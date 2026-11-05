import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { docker as realDocker, type DockerRun, dockerState } from "../../src/sandbox/docker.js";
import {
  BUILD_FAILED,
  BUILD_NOT_ALLOWED,
  BUILD_NOT_INSTALLED,
  BUILD_NOT_RUNNING,
  BUILD_WINDOWS_CONTAINERS,
  buildQuestion,
  downloads,
  imageFor,
  NOT_ALLOWED,
  NOT_BUILT,
  NOT_INSTALLED,
  NOT_RUNNING,
  NO_TERMINAL,
  prepareImage,
  sandboxCommand,
  sandboxHeld,
  SHIPPED,
  UNBUILT,
  WINDOWS_CONTAINERS,
} from "../../src/sandbox/image.js";

// A project folder of the test's own, removed when the test ends; `dockerfile` puts .tachikoma/sandbox.Dockerfile in it.
function project(dockerfile?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "tachi-image-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  if (dockerfile !== undefined) {
    mkdirSync(path.join(root, ".tachikoma"));
    writeFileSync(path.join(root, ".tachikoma", "sandbox.Dockerfile"), dockerfile);
  }
  return root;
}

const hex = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
// The shipped Dockerfile's text as imageFor keeps it, with LF line endings (choice 68).
const shipped = () => Buffer.from(readFileSync(SHIPPED, "utf8").replaceAll("\r\n", "\n"));

// A stand-in for Docker (choice 69): it records each call and its stdin, and answers by the call's first words. Docker
// is running, with Linux containers, unless told otherwise; an image is built when it is in `built`; a build gives `lines`, then runs `during`
// with its context folder, as if Docker were still building, and exits `buildCode`. `version` and `inspect` run during
// those calls.
function fakeDocker(
  opts: {
    state?: "missing" | "stopped" | "denied" | "windows";
    built?: string[];
    lines?: string[];
    buildCode?: number;
    during?: (context: string) => void;
    version?: () => void;
    inspect?: () => void;
  } = {},
) {
  const calls: { args: string[]; input?: string; signal?: AbortSignal; tree?: boolean; context?: string[] }[] = [];
  const run: DockerRun = async (args, o = {}) => {
    const call: (typeof calls)[number] = {
      args,
      ...(o.input !== undefined ? { input: o.input.toString("utf8") } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.tree ? { tree: o.tree } : {}),
    };
    calls.push(call);
    if (opts.state === "missing") return "missing";
    if (args[0] === "version") {
      opts.version?.();
      if (opts.state === "stopped") return { code: 1, out: "", err: "" };
      if (opts.state === "denied") {
        return { code: 1, out: "", err: "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n" };
      }
      return { code: 0, out: opts.state === "windows" ? "windows\n" : "linux\n", err: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      opts.inspect?.();
      return { code: opts.built?.includes(args.at(-1)!) ? 0 : 1, out: "", err: "" };
    }
    if (args[0] === "build") {
      call.context = readdirSync(args.at(-1)!);
      for (const line of opts.lines ?? []) o.line?.(line);
      opts.during?.(args.at(-1)!);
      return { code: opts.buildCode ?? 0, out: "", err: "" };
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { run, calls, builds: () => calls.filter((c) => c.args[0] === "build") };
}

// What a flow printed, each line marked with where it went, and the questions it asked, answered from `answers`.
function terminal(answers: boolean[] = []) {
  const printed: string[] = [];
  const asked: string[] = [];
  return {
    printed,
    asked,
    out: (line: string) => printed.push(`out: ${line}`),
    err: (line: string) => printed.push(`err: ${line}`),
    ask: async (question: string) => {
      asked.push(question);
      return answers.shift() ?? false;
    },
  };
}

// With a letter outside ASCII, so the build is seen to get the file's own bytes.
const PROJECT = "# The project's own image, café\nFROM example.test/base:1\nRUN echo hi\n";

describe("imageFor", () => {
  it("is the shipped Dockerfile's image, tagged by its hash, when the project has none (choice 15)", async () => {
    const docker = fakeDocker();
    const info = await imageFor(project(), docker.run);
    const tag = `tachikoma-sandbox:${hex(shipped().toString())}`;
    expect(info).toEqual({ tag, dockerfile: SHIPPED, text: shipped(), built: false, project: false });
    expect(docker.calls.map((c) => c.args)).toEqual([["image", "inspect", "--format", "{{.Id}}", tag]]);
  });

  it("is the project's own, tagged by its hash with -project, when it has .tachikoma/sandbox.Dockerfile (choice 16)", async () => {
    const root = project(PROJECT);
    const tag = `tachikoma-sandbox:${hex(PROJECT)}-project`;
    const info = await imageFor(root, fakeDocker({ built: [tag] }).run);
    expect(info).toEqual({ tag, dockerfile: path.join(root, ".tachikoma", "sandbox.Dockerfile"), text: Buffer.from(PROJECT), built: true, project: true });
  });

  it("gives a Dockerfile the same tag with Windows line endings as with LF (choice 68)", async () => {
    const lf = await imageFor(project(PROJECT), fakeDocker().run);
    const crlf = await imageFor(project(PROJECT.replaceAll("\n", "\r\n")), fakeDocker().run);
    expect(crlf.tag).toBe(lf.tag);
    expect(lf.tag).toBe(`tachikoma-sandbox:${hex(PROJECT)}-project`);
  });

  // The one test of real Docker. It builds nothing: it looks for the image Task 1 built, and skips, saying why, when
  // there is no docker program, Docker is not running, or the image is not there.
  // Docker is asked only in the test's body, so a run that leaves the test out never reaches it.
  const TASK_1 = "tachikoma-sandbox:5879e9863c31";
  it("finds the image Task 1 built from the shipped Dockerfile (real Docker)", async (ctx) => {
    const state = await dockerState();
    if (state === "missing") return ctx.skip("no docker program on PATH");
    if (state === "stopped") return ctx.skip("Docker is not running");
    if (state !== "ready") return ctx.skip(state === "denied" ? "this user is not allowed to use Docker" : "Docker is set to Windows containers");
    const got = await realDocker(["image", "inspect", "--format", "{{.Id}}", TASK_1]);
    if (got === "missing" || got.code !== 0) return ctx.skip(`the image of Task 1 (${TASK_1}) is not built`);
    expect(await imageFor(project())).toEqual({ tag: TASK_1, dockerfile: SHIPPED, text: shipped(), built: true, project: false });
  });
});

describe("downloads", () => {
  it("reads the images of FROM and COPY --from, but not earlier stages or scratch", () => {
    const text = [
      "# syntax comment FROM example.test/not-this:1",
      "FROM --platform=linux/amd64 example.test/base:1@sha256:abc AS build",
      "from example.test/other:2",
      "COPY --from=build /a /b",
      "COPY --chown=1000:1000 --from=example.test/tool:3 /t /usr/local/bin/",
      "COPY --from=0 /c /d",
      "FROM build",
      "FROM scratch",
      "COPY \\",
      "  --from=example.test/split:4 /e /f",
      "COPY --from=example.test/tool:3 /g /h",
    ].join("\r\n");
    expect(downloads(text)).toEqual([
      "example.test/base:1@sha256:abc",
      "example.test/other:2",
      "example.test/tool:3",
      "example.test/split:4",
    ]);
  });

  it("reads a first FROM after a byte order mark, as Docker does", async () => {
    const bom = String.fromCodePoint(0xfeff);
    expect(downloads(`${bom}FROM example.test/base:1\n`)).toEqual(["example.test/base:1"]);
    const t = terminal([false]);
    await prepareImage(project(`${bom}FROM example.test/base:1\n`), { ...t, signal: new AbortController().signal, run: fakeDocker().run });
    expect(t.asked).toEqual([buildQuestion(["example.test/base:1"], true)]);
  });

  it("names the shipped Dockerfile's base and uv's image", () => {
    expect(downloads(shipped().toString()).map((image) => image.split("@")[0])).toEqual(["node:24-bookworm-slim", "ghcr.io/astral-sh/uv"]);
  });
});

describe("the question", () => {
  it("names what the shipped image's build downloads", () => {
    expect(buildQuestion(["example.test/base:1", "example.test/tool:3"], false)).toBe(
      "The sandbox needs its image, built here once. It downloads: example.test/base:1, example.test/tool:3, and Debian's packages. Build it now? [y/n]",
    );
    expect(buildQuestion([], false)).toBe("The sandbox needs its image, built here once. It downloads Debian's packages. Build it now? [y/n]");
  });

  it("says a project's image is the project's, from its own file (choice 72)", () => {
    expect(buildQuestion(["example.test/base:1", "example.test/tool:3"], true)).toBe(
      "The sandbox needs this project's image, from .tachikoma/sandbox.Dockerfile, built here once. It downloads what that file asks for, " +
        "starting with: example.test/base:1, example.test/tool:3. Build it now? [y/n]",
    );
    expect(buildQuestion([], true)).toBe(
      "The sandbox needs this project's image, from .tachikoma/sandbox.Dockerfile, built here once. It downloads what that file asks for. Build it now? [y/n]",
    );
  });

  it("asks about the shipped image when the project has no Dockerfile", async () => {
    const t = terminal([false]);
    await prepareImage(project(), { ...t, signal: new AbortController().signal, run: fakeDocker().run });
    expect(t.asked).toEqual([buildQuestion(downloads(shipped().toString()), false)]);
  });

  // The characters are made from their codes, and their escapes from parts, so no escape in this file's text is turned
  // into the character itself on the way.
  it("escapes control characters in a project's image names and in the build's lines", async () => {
    const [esc, bel, tab] = [27, 7, 9].map((code) => String.fromCharCode(code));
    const shown = (code: number) => `${"\\"}u${code.toString(16).padStart(4, "0")}`;
    const t = terminal([true]);
    const docker = fakeDocker({ lines: [`#1 ${esc}]52;c;eA==${bel}done${tab}ok`] });
    await prepareImage(project(`FROM example.test/base${esc}[2J:1\n`), { ...t, signal: new AbortController().signal, run: docker.run });
    expect(t.asked).toEqual([buildQuestion([`example.test/base${shown(27)}[2J:1`], true)]);
    expect(t.printed).toEqual([`out: #1 ${shown(27)}]52;c;eA==${shown(7)}done${tab}ok`]); // a tab stays, as in the scrollback's prose
  });
});

describe("prepareImage (the launch)", () => {
  it("stops when Docker is not installed, before looking for the image", async () => {
    const docker = fakeDocker({ state: "missing" });
    const t = terminal();
    expect(await prepareImage(project(), { ...t, signal: new AbortController().signal, run: docker.run })).toEqual({ exit: 1 });
    expect(NOT_INSTALLED).toBe("The sandbox needs Docker, which is not installed. Install Docker, or launch with --sandbox off.");
    expect(t.printed).toEqual([`err: ${NOT_INSTALLED}`]);
    expect(docker.calls).toHaveLength(1);
  });

  it("stops when Docker is not running, before looking for the image", async () => {
    const docker = fakeDocker({ state: "stopped" });
    const t = terminal();
    expect(await prepareImage(project(), { ...t, signal: new AbortController().signal, run: docker.run })).toEqual({ exit: 1 });
    expect(NOT_RUNNING).toBe("The sandbox needs Docker, which is not running. Start Docker, then launch again.");
    expect(t.printed).toEqual([`err: ${NOT_RUNNING}`]);
    expect(docker.calls.map((c) => c.args[0])).toEqual(["version"]);
  });

  it("stops when this user is not allowed to use Docker, before looking for the image (choice 78)", async () => {
    const docker = fakeDocker({ state: "denied" });
    const t = terminal();
    expect(await prepareImage(project(), { ...t, signal: new AbortController().signal, run: docker.run })).toEqual({ exit: 1 });
    expect(NOT_ALLOWED).toBe(
      "The sandbox needs Docker, but this user is not allowed to use it. Docker's install guide for Linux says how to allow it, or launch with --sandbox off.",
    );
    expect(t.printed).toEqual([`err: ${NOT_ALLOWED}`]);
    expect(docker.calls.map((c) => c.args[0])).toEqual(["version"]);
  });

  it("stops when Docker is set to Windows containers, before looking for the image (choice 78)", async () => {
    const docker = fakeDocker({ state: "windows" });
    const t = terminal();
    expect(await prepareImage(project(), { ...t, signal: new AbortController().signal, run: docker.run })).toEqual({ exit: 1 });
    expect(WINDOWS_CONTAINERS).toBe(
      "The sandbox needs Docker's Linux containers, but Docker is set to Windows containers. Switch it to Linux containers, then launch again.",
    );
    expect(t.printed).toEqual([`err: ${WINDOWS_CONTAINERS}`]);
    expect(docker.calls.map((c) => c.args[0])).toEqual(["version"]);
  });

  it("headless with no image, stops at once: nothing is asked and nothing is built", async () => {
    const docker = fakeDocker();
    const t = terminal();
    const { ask: _, ...headless } = t;
    expect(await prepareImage(project(PROJECT), { ...headless, signal: new AbortController().signal, run: docker.run })).toEqual({ exit: 1 });
    expect(NOT_BUILT).toBe("The sandbox's image is not built. Run tachi sandbox build first.");
    expect(t.printed).toEqual([`err: ${NOT_BUILT}`]);
    expect(t.asked).toEqual([]);
    expect(docker.builds()).toEqual([]);
  });

  it("gives the image's tag when it is built, asking nothing", async () => {
    const tag = `tachikoma-sandbox:${hex(PROJECT)}-project`;
    const docker = fakeDocker({ built: [tag] });
    const t = terminal();
    expect(await prepareImage(project(PROJECT), { ...t, signal: new AbortController().signal, run: docker.run })).toEqual({ tag });
    expect(t.printed).toEqual([]);
    expect(t.asked).toEqual([]);
  });

  it("asks before building, and a no exits 0 without building", async () => {
    const docker = fakeDocker();
    const t = terminal([false]);
    expect(await prepareImage(project(PROJECT), { ...t, signal: new AbortController().signal, run: docker.run })).toEqual({ exit: 0 });
    expect(t.asked).toEqual([buildQuestion(["example.test/base:1"], true)]);
    expect(UNBUILT).toBe("Not built; the sandbox needs it.");
    expect(t.printed).toEqual([`out: ${UNBUILT}`]);
    expect(docker.builds()).toEqual([]);
  });

  it("a yes builds the project's image from an empty folder, showing the build's lines (choice 16)", async () => {
    const tag = `tachikoma-sandbox:${hex(PROJECT)}-project`;
    const docker = fakeDocker({ lines: ["#1 load", "#2 DONE"] });
    const t = terminal([true]);
    const stop = new AbortController();
    expect(await prepareImage(project(PROJECT.replaceAll("\n", "\r\n")), { ...t, signal: stop.signal, run: docker.run })).toEqual({ tag });
    const [build] = docker.builds();
    expect(build!.args.slice(0, -1)).toEqual(["build", "--tag", tag, "--file", "-"]);
    expect(build!.context).toEqual([]); // nothing of the project's can be copied in
    expect(existsSync(build!.args.at(-1)!)).toBe(false); // the empty folder is removed after
    expect(build!.input).toBe(PROJECT); // the text the tag hashes, with LF line endings (choice 68)
    expect(build!.signal).toBe(stop.signal);
    expect(build!.tree).toBe(true); // a stop ends buildx too (choice 125)
    expect(docker.calls.filter((c) => c.tree).map((c) => c.args[0])).toEqual(["build"]); // only the build
    expect(t.printed).toEqual(["out: #1 load", "out: #2 DONE"]);
  });

  it("says when the build failed, after its lines, and exits 1", async () => {
    const docker = fakeDocker({ lines: ["ERROR: failed to solve"], buildCode: 1 });
    const t = terminal([true]);
    expect(await prepareImage(project(PROJECT), { ...t, signal: new AbortController().signal, run: docker.run })).toEqual({ exit: 1 });
    expect(BUILD_FAILED).toBe("The image could not be built.");
    expect(t.printed).toEqual(["out: ERROR: failed to solve", `err: ${BUILD_FAILED}`]);
  });

  it("Ctrl-C during the build claims no failure, and exits 130", async () => {
    const stop = new AbortController();
    let context = "";
    const docker = fakeDocker({
      lines: ["#1 load"],
      during: (dir) => {
        context = dir;
        stop.abort();
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); // as the real run rejects
      },
    });
    const t = terminal([true]);
    expect(await prepareImage(project(PROJECT), { ...t, signal: stop.signal, run: docker.run })).toEqual({ exit: 130 });
    expect(t.printed).toEqual(["out: #1 load"]);
    expect(existsSync(context)).toBe(false);
  });

  it("Ctrl-C while the image is looked for asks nothing, claims nothing, and exits 130", async () => {
    const stop = new AbortController();
    const docker = fakeDocker({ inspect: () => stop.abort() });
    const t = terminal([true]);
    expect(await prepareImage(project(PROJECT), { ...t, signal: stop.signal, run: docker.run })).toEqual({ exit: 130 });
    // Its own stop and Docker, so the stop comes during its own inspect, not before its Docker check.
    const stop2 = new AbortController();
    const docker2 = fakeDocker({ inspect: () => stop2.abort() });
    expect(await sandboxCommand(["build"], project(PROJECT), { ...t, signal: stop2.signal, run: docker2.run })).toBe(130);
    expect(t.asked).toEqual([]);
    expect(t.printed).toEqual([]);
    expect(docker.builds()).toEqual([]);
    expect(docker2.builds()).toEqual([]);
  });

  it("Ctrl-C while Docker's state is read claims nothing, and exits 130 (choice 70)", async () => {
    const stop = new AbortController();
    const docker = fakeDocker({ state: "stopped", version: () => stop.abort() }); // the client ended by the same Ctrl-C
    const t = terminal();
    expect(await prepareImage(project(PROJECT), { ...t, signal: stop.signal, run: docker.run })).toEqual({ exit: 130 });
    expect(await sandboxCommand(["build"], project(PROJECT), { ...t, signal: stop.signal, run: docker.run })).toBe(130);
    expect(t.printed).toEqual([]);
    expect(docker.calls.find((c) => c.args[0] === "version")!.signal).toBe(stop.signal);
  });

  it("a good build stays good when its folder cannot be removed", async () => {
    let context = "";
    const docker = fakeDocker({
      during: (dir) => {
        context = dir;
        writeFileSync(path.join(dir, "left"), ""); // so the remove, which never removes what is inside, fails
      },
    });
    onTestFinished(() => rmSync(context, { recursive: true, force: true }));
    const t = terminal([true]);
    const tag = `tachikoma-sandbox:${hex(PROJECT)}-project`;
    expect(await prepareImage(project(PROJECT), { ...t, signal: new AbortController().signal, run: docker.run })).toEqual({ tag });
    expect(readdirSync(context)).toEqual(["left"]);
    expect(t.printed).toEqual([]);
  });

  it("asks again when the Dockerfile changed since its image was built", async () => {
    const docker = fakeDocker({ built: [`tachikoma-sandbox:${hex(PROJECT)}-project`] });
    const t = terminal([false]);
    const changed = `${PROJECT}RUN echo more\n`;
    await prepareImage(project(changed), { ...t, signal: new AbortController().signal, run: docker.run });
    expect(t.asked).toEqual([buildQuestion(["example.test/base:1"], true)]);
  });
});

describe("tachi sandbox build", () => {
  it("says the image is up to date when it is built", async () => {
    const tag = `tachikoma-sandbox:${hex(PROJECT)}-project`;
    const t = terminal();
    expect(await sandboxCommand(["build"], project(PROJECT), { ...t, signal: new AbortController().signal, run: fakeDocker({ built: [tag] }).run })).toBe(0);
    expect(t.printed).toEqual([`out: The sandbox's image is up to date (${tag}).`]);
    expect(t.asked).toEqual([]);
  });

  it("asks the same question, and builds on a yes", async () => {
    const docker = fakeDocker({ lines: ["#1 DONE"] });
    const t = terminal([true]);
    expect(await sandboxCommand(["build"], project(PROJECT), { ...t, signal: new AbortController().signal, run: docker.run })).toBe(0);
    expect(t.asked).toEqual([buildQuestion(["example.test/base:1"], true)]);
    expect(docker.builds()).toHaveLength(1);
    expect(t.printed).toEqual(["out: #1 DONE"]);
  });

  it("has its own lines when Docker is not installed, not running, not allowed or set to Windows containers (choices 71 and 78)", async () => {
    expect(BUILD_NOT_INSTALLED).toBe("The sandbox needs Docker, which is not installed. Install Docker, then run tachi sandbox build again.");
    expect(BUILD_NOT_RUNNING).toBe("The sandbox needs Docker, which is not running. Start Docker, then run tachi sandbox build again.");
    expect(BUILD_NOT_ALLOWED).toBe(
      "The sandbox needs Docker, but this user is not allowed to use it. " +
        "Docker's install guide for Linux says how to allow it, then run tachi sandbox build again.",
    );
    expect(BUILD_WINDOWS_CONTAINERS).toBe(
      "The sandbox needs Docker's Linux containers, but Docker is set to Windows containers. " +
        "Switch it to Linux containers, then run tachi sandbox build again.",
    );
    for (const [state, line] of [
      ["missing", BUILD_NOT_INSTALLED],
      ["stopped", BUILD_NOT_RUNNING],
      ["denied", BUILD_NOT_ALLOWED],
      ["windows", BUILD_WINDOWS_CONTAINERS],
    ] as const) {
      const t = terminal();
      expect(await sandboxCommand(["build"], project(), { ...t, signal: new AbortController().signal, run: fakeDocker({ state }).run })).toBe(1);
      expect(t.printed).toEqual([`err: ${line}`]);
    }
  });

  it("with no terminal to ask in, builds nothing", async () => {
    const docker = fakeDocker();
    const { ask: _, ...t } = terminal();
    expect(await sandboxCommand(["build"], project(PROJECT), { ...t, signal: new AbortController().signal, run: docker.run })).toBe(1);
    expect(NO_TERMINAL).toBe("tachi sandbox build needs a terminal, to ask before it downloads anything.");
    expect(t.printed).toEqual([`err: ${NO_TERMINAL}`]);
    expect(docker.builds()).toEqual([]);
  });

  // Choice 71: a folder holding Tachikoma's own (choice 13) is refused before Docker is asked anything, so a Dockerfile in
  // the settings folder is never read. The data folder is put inside the project for it.
  it("refuses a folder that holds Tachikoma's data folder, before Docker, after its usage", async () => {
    const root = project();
    vi.stubEnv("TACHI_DATA_DIR", path.join(root, "data"));
    onTestFinished(() => void vi.unstubAllEnvs());
    const docker = fakeDocker();
    const t = terminal([true]);
    expect(await sandboxCommand(["build"], root, { ...t, signal: new AbortController().signal, run: docker.run })).toBe(1);
    expect(t.printed).toEqual([
      `err: The sandbox cannot run on ${root}: it holds Tachikoma's data folder, which must never be in the box. Start Tachikoma in a project folder.`,
    ]);
    expect(docker.calls).toEqual([]);
    expect(await sandboxCommand(["make"], root, { ...t, signal: new AbortController().signal, run: docker.run })).toBe(1);
    expect(t.printed.at(-1)).toBe("err: Usage: tachi sandbox build");
  });

  // Choice 107: the home folder itself is named as such, before the folders it holds; a folder above it names the first
  // of those it holds.
  it("names the home folder when the project is it, and the folders it holds otherwise", () => {
    const top = realpathSync.native(project());
    const home = path.join(top, "home");
    mkdirSync(home);
    const data = path.join(home, "data");
    expect(sandboxHeld(home, home, data)).toBe("the home folder");
    expect(sandboxHeld(top, home, data)).toBe("Tachikoma's data folder");
    expect(sandboxHeld(top, home, path.join(tmpdir(), "elsewhere-data"))).toBe("Tachikoma's settings folder");
    mkdirSync(path.join(home, "project"));
    expect(sandboxHeld(path.join(home, "project"), home, data)).toBeUndefined();
  });

  it("explains its usage for anything but build", async () => {
    for (const args of [[], ["make"], ["build", "now"]]) {
      const docker = fakeDocker();
      const t = terminal();
      expect(await sandboxCommand(args, project(), { ...t, signal: new AbortController().signal, run: docker.run })).toBe(1);
      expect(t.printed).toEqual(["err: Usage: tachi sandbox build"]);
      expect(docker.calls).toEqual([]);
    }
  });
});
