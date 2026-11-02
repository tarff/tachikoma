// The sandbox's image: which Dockerfile, its tag, whether it is built, and building it after asking (release 7 design,
// "The image is built on the user's PC, after asking"; plan, Task 11 and choices 15, 16 and 68). Task 16's launch calls
// prepareImage after choice 13's refusal; `tachi sandbox build` calls sandboxCommand. Docker is reached only through a
// DockerRun (choice 69), and the question through `ask`, so tests never touch Docker or the terminal.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS_DIR } from "../core/datadir.js";
import { visible } from "../core/permissions.js";
import { docker, type DockerRun, dockerState } from "./docker.js";

// Shipped with Tachikoma (package.json's `files`), beside src and dist alike.
export const SHIPPED = fileURLToPath(new URL("../../sandbox/Dockerfile", import.meta.url));

// The launch's lines (Task 11), each ending the launch with exit 1, but UNBUILT, the no to the question, with 0.
export const NOT_INSTALLED = "The sandbox needs Docker, which is not installed. Install Docker Desktop, or launch with --sandbox off.";
export const NOT_RUNNING = "The sandbox needs Docker, which is not running. Start Docker Desktop, then launch again.";
export const NOT_BUILT = "The sandbox's image is not built. Run tachi sandbox build first.";
export const UNBUILT = "Not built; the sandbox needs it.";
export const BUILD_FAILED = "The image could not be built.";
// `tachi sandbox build` with no terminal: nothing is built without the user's answer (design: no switch approves the
// download in advance).
export const NO_TERMINAL = "tachi sandbox build needs a terminal, to ask before it downloads anything.";
// `tachi sandbox build`'s own lines for Docker, each with exit 1 (choice 71).
export const BUILD_NOT_INSTALLED = "The sandbox needs Docker, which is not installed. Install Docker Desktop, then run tachi sandbox build again.";
export const BUILD_NOT_RUNNING = "The sandbox needs Docker, which is not running. Start Docker Desktop, then run tachi sandbox build again.";
// Ctrl-C's exit, 128 + SIGINT's number, as the launch's other Ctrl-C exits are. A stop prints nothing more.
const STOP = 128 + os.constants.signals.SIGINT;
const USAGE = "Usage: tachi sandbox build";

export interface ImageInfo { tag: string; dockerfile: string; built: boolean; project: boolean }

// How a flow reaches the user and Docker. Without `ask` there is nobody to answer (headless), so nothing is built.
export interface ImageIo {
  ask?: (question: string) => Promise<boolean>;
  out: (line: string) => void;
  err: (line: string) => void;
  signal: AbortSignal;
  run?: DockerRun;
}

// The project's own Dockerfile when it has one (choice 16), or the shipped one (choice 15). Its tag is the first 12 hex
// of the SHA-256 of its text, so a changed Dockerfile is a new image, with `-project` after a project's.
export async function imageFor(root: string, run: DockerRun = docker): Promise<ImageInfo> {
  const own = path.join(root, SETTINGS_DIR, "sandbox.Dockerfile");
  const project = existsSync(own);
  const dockerfile = project ? own : SHIPPED;
  const tag = `tachikoma-sandbox:${createHash("sha256").update(dockerText(dockerfile)).digest("hex").slice(0, 12)}${project ? "-project" : ""}`;
  const got = await run(["image", "inspect", "--format", "{{.Id}}", tag]);
  return { tag, dockerfile, built: got !== "missing" && got.code === 0, project };
}

// The Dockerfile's bytes with each \r\n read as \n, so its line endings never change its tag (choice 68). Through latin1,
// which maps each byte to one character and back unchanged, so the rest is the file's own bytes, whatever its encoding.
function dockerText(dockerfile: string): Buffer {
  return Buffer.from(readFileSync(dockerfile, "latin1").replaceAll("\r\n", "\n"), "latin1");
}

// The images the build downloads, for the question: each FROM's and COPY --from's, in the file's order, once each. A
// stage of the file's own, by name or number, is not one, nor is `scratch`. Comment lines are passed over, and a line
// ending in `\` goes on in the next, as Docker reads them.
export function downloads(dockerfile: string): string[] {
  const instructions: string[] = [];
  let held = "";
  for (const line of readFileSync(dockerfile, "utf8").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    held += line;
    if (held.trimEnd().endsWith("\\")) held = held.trimEnd().slice(0, -1);
    else {
      instructions.push(held);
      held = "";
    }
  }
  if (held) instructions.push(held);
  const stages = new Set<string>();
  const images: string[] = [];
  const add = (image: string) => {
    if (image.toLowerCase() !== "scratch" && !stages.has(image.toLowerCase()) && !/^\d+$/.test(image) && !images.includes(image)) images.push(image);
  };
  for (const instruction of instructions) {
    const words = instruction.trim().split(/\s+/);
    const name = words[0]?.toUpperCase();
    if (name === "FROM") {
      const [image, as, stage] = words.slice(1).filter((w) => !w.startsWith("--"));
      if (image) add(image);
      if (as?.toUpperCase() === "AS" && stage) stages.add(stage.toLowerCase());
    } else if (name === "COPY") {
      for (const word of words) if (word.startsWith("--from=")) add(word.slice("--from=".length));
    }
  }
  return images;
}

// The shipped image's question names its images and Debian's packages; a project's says it is the project's own, from
// its own file, which may download more than the images read here (choice 72). With no image names read, the list is
// left out of either.
export function buildQuestion(images: string[], project: boolean): string {
  const list = images.join(", ");
  if (project) {
    const named = images.length > 0 ? `, starting with: ${list}` : "";
    return (
      "The sandbox needs this project's image, from .tachikoma/sandbox.Dockerfile, built here once. " +
      `It downloads what that file asks for${named}. Build it now? [y/n]`
    );
  }
  const named = images.length > 0 ? `: ${list}, and` : "";
  return `The sandbox needs its image, built here once. It downloads${named} Debian's packages. Build it now? [y/n]`;
}

// Builds from an empty folder of its own as the context, so the build cannot copy any of the project's files into the
// image (choice 16), and the Dockerfile given on stdin as the text its tag hashes (choice 68). Each line of the build's
// output goes to `out` as it comes. Rejects when the build fails.
export async function buildImage(info: ImageInfo, out: (line: string) => void, signal: AbortSignal, run: DockerRun = docker): Promise<void> {
  const context = await mkdtemp(path.join(os.tmpdir(), "tachi-build-"));
  try {
    const got = await run(["build", "--tag", info.tag, "--file", "-", context], { line: out, input: dockerText(info.dockerfile), signal });
    if (got === "missing" || got.code !== 0) throw new Error(BUILD_FAILED);
  } finally {
    // Never recursive, so nothing but the empty folder is ever removed. A folder that cannot be removed is left, and
    // the build's own result stands.
    await rmdir(context).catch(() => {});
  }
}

// The launch's steps for the image (Task 16's order: Docker's state, then the image): the image's tag when it is ready,
// or the exit code once the reason is printed. Headless (no `ask`), an image not built stops at once, and nothing waits.
export async function prepareImage(root: string, io: ImageIo): Promise<{ tag: string } | { exit: number }> {
  const run = io.run ?? docker;
  const stopped = await dockerReady(run, io, NOT_INSTALLED, NOT_RUNNING);
  if (stopped !== undefined) return { exit: stopped };
  const info = await imageFor(root, run);
  if (info.built) return { tag: info.tag };
  if (!io.ask) {
    io.err(NOT_BUILT);
    return { exit: 1 };
  }
  return askAndBuild(info, io.ask, io);
}

// `tachi sandbox build`: the launch's steps, with its own lines for Docker (choice 71), saying so when the image is up
// to date.
export async function sandboxCommand(args: string[], root: string, io: ImageIo): Promise<number> {
  if (args.length !== 1 || args[0] !== "build") {
    io.err(USAGE);
    return 1;
  }
  const run = io.run ?? docker;
  const stopped = await dockerReady(run, io, BUILD_NOT_INSTALLED, BUILD_NOT_RUNNING);
  if (stopped !== undefined) return stopped;
  const info = await imageFor(root, run);
  if (info.built) {
    io.out(`The sandbox's image is up to date (${info.tag}).`);
    return 0;
  }
  if (!io.ask) {
    io.err(NO_TERMINAL);
    return 1;
  }
  const done = await askAndBuild(info, io.ask, io);
  return "exit" in done ? done.exit : 0;
}

// Docker's state: undefined when it can be used, or the exit code once the line saying what to do is printed. No time
// limit: `docker version` is waited for, and Ctrl-C stops it (choice 70); a client ended by that Ctrl-C reads as Docker
// not running, so a stop is known by the signal, not by the answer.
async function dockerReady(run: DockerRun, io: ImageIo, missing: string, notRunning: string): Promise<number | undefined> {
  let state;
  try {
    state = await dockerState(run, io.signal);
  } catch (err) {
    if (io.signal.aborted) return STOP;
    throw err;
  }
  if (io.signal.aborted) return STOP;
  if (state === "ready") return undefined;
  io.err(state === "missing" ? missing : notRunning);
  return 1;
}

// The question, then the build on a yes. What a project's Dockerfile names, and what its build prints, are escaped, so
// neither can act on the terminal.
async function askAndBuild(info: ImageInfo, ask: (question: string) => Promise<boolean>, io: ImageIo): Promise<{ tag: string } | { exit: number }> {
  if (!(await ask(visible(buildQuestion(downloads(info.dockerfile), info.project))))) {
    io.out(UNBUILT);
    return { exit: 0 };
  }
  try {
    await buildImage(info, (line) => io.out(visible(line, { tabs: true })), io.signal, io.run);
  } catch {
    if (io.signal.aborted) return { exit: STOP }; // a stop is not a failure
    io.err(BUILD_FAILED);
    return { exit: 1 };
  }
  return { tag: info.tag };
}
