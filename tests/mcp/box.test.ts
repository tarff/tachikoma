import { describe, expect, it } from "vitest";
import {
  badNameLine,
  BOX_WORK,
  envBlock,
  execArgs,
  groupFile,
  INNER,
  NOT_FOUND,
  notFoundLine,
} from "../../src/mcp/box.js";
import type { DockerRun } from "../../src/sandbox/docker.js";
import { killInBox, killLine } from "../../src/sandbox/executor.js";

const NUL = String.fromCharCode(0);

// 8c-2a plan, Task 3: the box server's start command and the block of its variables (decisions 2 and 3). The scripts
// themselves run in the real box in Task 5's tests.
describe("envBlock", () => {
  it("gives each entry as NAME=VALUE and a NUL, then one more NUL, values whole", () => {
    const got = envBlock({ A: "x \t", B: "one\ntwo", C: "", D: "end\n" });
    expect(got).toEqual({ block: Buffer.from(`A=x \t${NUL}B=one\ntwo${NUL}C=${NUL}D=end\n${NUL}${NUL}`) });
  });

  it("gives a single NUL for no variables", () => {
    expect(envBlock({})).toEqual({ block: Buffer.from(NUL) });
  });

  it("refuses a name the box cannot take, naming the first", () => {
    expect(envBlock({ OK: "1", "BAD-NAME": "2", "9LIVES": "3" })).toEqual({ bad: "BAD-NAME" });
    expect(envBlock({ "9LIVES": "3" })).toEqual({ bad: "9LIVES" });
    expect(envBlock({ "A=B": "4" })).toEqual({ bad: "A=B" });
  });
});

describe("execArgs", () => {
  const group = "/tmp/tachikoma-g1";
  const args = execArgs("b0x", group, "npx", ["-y", "some server", "$HOME"]);

  it("is docker exec -i in /work, never -t, with the server's words as arguments, as given", () => {
    expect(args.slice(0, 7)).toEqual(["exec", "-i", "-w", BOX_WORK, "b0x", "bash", "-c"]);
    expect(BOX_WORK).toBe("/work");
    expect(args).not.toContain("-t");
    expect(args.slice(8)).toEqual(["_", INNER, "npx", "-y", "some server", "$HOME"]);
  });

  it("runs its words in a group of its own, writing and removing the group's file and its .stop file", () => {
    const outer = args[7];
    expect(outer).toContain(
      `setsid -w bash -c 'echo $$ > ${group}; [ -e ${group}.stop ] && exit; exec bash -c "$@"' _ "$@"`,
    );
    expect(outer).toContain(`rm -f ${group} ${group}.stop`);
  });

  it("takes a new group file in the box's /tmp each time", () => {
    const a = groupFile();
    expect(a).toMatch(/^\/tmp\/tachikoma-[0-9a-f-]{36}$/);
    expect(groupFile()).not.toBe(a);
  });
});

describe("INNER", () => {
  it("reads with IFS= read -r -d '', looks the command up after its exports, and says when it is not found", () => {
    expect(INNER).toContain("IFS= read -r -d ''");
    expect(INNER.indexOf("command -v")).toBeGreaterThan(INNER.indexOf("export"));
    expect(INNER).toContain(NOT_FOUND);
    expect(NOT_FOUND).toBe("tachikoma: not found");
    expect(INNER).toContain("exit 127");
    expect(INNER).toContain("exit 2");
    expect(INNER).toMatch(/exec "\$0" "\$@"$/);
  });
});

describe("the red lines' reasons", () => {
  it("are the approved words", () => {
    expect(notFoundLine("uvx mcp-x")).toBe(
      'uvx mcp-x was not found in the box; if it needs this computer, add "host": true to its entry in ' +
        "~/.tachikoma/settings.json",
    );
    expect(badNameLine("BAD-NAME")).toBe(
      'its env has the name "BAD-NAME", which the box cannot take: a name there is letters, digits and _, ' +
        "not starting with a digit",
    );
  });
});

// Decision 24: inGroup's kill, shared with the box server.
describe("killLine and killInBox", () => {
  it("killLine is inGroup's kill line", () => {
    const group = "/tmp/tachikoma-g1";
    expect(killLine(group)).toBe(
      `touch ${group}.stop; kill -KILL -- -"$(cat ${group} 2>/dev/null)" 2>/dev/null; exit 0`,
    );
  });

  const answering = (answer: () => ReturnType<DockerRun>) => {
    const calls: string[][] = [];
    const run: DockerRun = (args) => {
      calls.push(args);
      return answer();
    };
    return { run, calls };
  };

  it("runs the kill line in the box, and gives undefined when it exits 0", async () => {
    const fake = answering(async () => ({ code: 0, out: "", err: "" }));
    expect(await killInBox(fake.run, "b0x", "/tmp/tachikoma-g1")).toBeUndefined();
    expect(fake.calls).toEqual([["exec", "b0x", "bash", "-c", killLine("/tmp/tachikoma-g1")]]);
  });

  it("gives no docker program's words, Docker's error output, the box stopped, or the error's message", async () => {
    const kill = (answer: () => ReturnType<DockerRun>) => killInBox(answering(answer).run, "b0x", "/tmp/tachikoma-g1");
    expect(await kill(async () => "missing")).toBe("no docker program is on PATH any more");
    expect(await kill(async () => ({ code: 1, out: "", err: "Error: boom\n" }))).toBe("Error: boom");
    expect(await kill(async () => ({ code: 1, out: "", err: "" }))).toBe("the box stopped");
    expect(await kill(() => Promise.reject(new Error("spawn docker EACCES")))).toBe("spawn docker EACCES");
  });
});
