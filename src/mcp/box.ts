// An MCP server in the session's box (8c-2a design, "Starting and stopping a server in the box"; plan, Task 3,
// decisions 2 and 3): the `docker exec` that starts it, and the block of its variables, which goes over its own input
// before the first message, so the variables are neither on a command line nor in a file, and the docker program gets
// them neither as its own variables nor on its command line: it only copies its input into the box.
import { randomUUID } from "node:crypto";
import { visible } from "../core/permissions.js";
import { onPath } from "../exec/env.js";
import type { DockerRun } from "../sandbox/docker.js";
import type { BoxState } from "../sandbox/executor.js";

// The session's box, as the servers started in it see it. `program` is the docker program to start, when it is not the
// one on PATH (a test's stand-in, Task 4). Tasks 4-8 share this shape.
export interface McpBox {
  id: string;
  kind: "live" | "copy";
  state: BoxState;
  run: DockerRun;
  program?: { file: string; args: string[] };
}

export const BOX_WORK = "/work";
// The server's roots, written out: pathToFileURL("/work") gives file:///C:/work on Windows (decision 8).
export const BOX_ROOTS = "file:///work";
export const BOX_STOPPED = "the box stopped";
// What the inner script prints to its error output when the command is not in the box (decision 3).
export const NOT_FOUND = "tachikoma: not found";

const NUL = String.fromCharCode(0);
// A name the box takes: letters, digits and _, not starting with a digit (choice 5).
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The block: each variable as NAME=VALUE and a NUL, then one more NUL, the empty entry that ends it (the design's
// framing). A value never holds a NUL, as config.ts refuses one; a name the box cannot take is given back, the first.
export function envBlock(env: Record<string, string>): { block: Buffer } | { bad: string } {
  const entries = Object.entries(env);
  const bad = entries.find(([name]) => !NAME.test(name));
  if (bad) return { bad: bad[0] };
  return { block: Buffer.from(entries.map(([name, value]) => `${name}=${value}${NUL}`).join("") + NUL) };
}

// The inner script, run as `bash -c INNER <command> <args...>`, so the command comes as its $0 (decision 2). It first
// keeps the command and its arguments as its own arguments, $1 on, which no variable can change, as an entry named
// BASH_ARGV0 would change $0 once exported. Then it reads the block one entry at a time with `IFS= read -r -d ''`,
// which takes a pipe a byte at a time and, with IFS empty, keeps a value's spaces, tabs and line breaks; a block cut
// short ends it with exit 2. The entries are exported only after the block, all at once from x's own arguments, once x
// has unset itself and the loop's e and a, so an entry with one of those names is kept as given. The command is looked
// up after that, so an entry's own PATH counts, and when it is not found NOT_FOUND goes to the error output with exit
// 127. Otherwise the script becomes the server, which reads its input from the next byte on: the first MCP message.
// Nothing is printed to its output, which is the server's. Other names bash keeps for itself (SHELLOPTS, RANDOM and the
// like) may not reach the server as given: a known limit.
export const INNER =
  "set -- \"$0\" \"$@\"; x() { unset -f x; unset e a; [ $# = 0 ] || export \"$@\"; }; a=(); " +
  "while IFS= read -r -d '' e || exit 2; [ -n \"$e\" ]; do a+=(\"$e\"); done; x \"${a[@]}\"; " +
  `command -v "$1" >/dev/null || { echo '${NOT_FOUND}' >&2; exit 127; }; exec "$@"`;

// inGroup's wrapper (src/sandbox/executor.ts), with "$@" in place of its one argument: INNER, the command and its
// arguments run in a process group of their own, whose id goes to `group` first, so a stop can kill the whole group in
// the box (killLine), with the same `.stop` file for a stop before the id is written.
const outer = (group: string) =>
  `exec 3>&2 2>/dev/null; ` +
  `setsid -w bash -c 'echo $$ > ${group}; [ -e ${group}.stop ] && exit; exec bash -c "$@"' _ "$@" 2>&3 3>&-; ` +
  `s=$?; rm -f ${group} ${group}.stop; exit $s`;

// The docker exec that starts the server: -i for its input, never -t, which would mangle the messages; in /work, as the
// box's own user; the server's words as arguments, as given, and no value of its env (the design's "Start").
export function execArgs(id: string, group: string, command: string, args: string[]): string[] {
  return ["exec", "-i", "-w", BOX_WORK, id, "bash", "-c", outer(group), "_", INNER, command, ...args];
}

// The group's file in the box's /tmp, as inGroup's.
export const groupFile = () => `/tmp/tachikoma-${randomUUID()}`;

// The docker program, found on PATH at each start (decision 5).
export function dockerProgram(env: NodeJS.ProcessEnv): { file: string; args: string[] } | undefined {
  const file = onPath("docker", env);
  return file === undefined ? undefined : { file, args: [] };
}

// The red line's reason when the command is not in the box (the design's line).
export const notFoundLine = (command: string) =>
  `${command} was not found in the box; if it needs this computer, add "host": true to its entry in ` +
  "~/.tachikoma/settings.json";

// The red line's reason for a variable name the box cannot take (choice 5), quoted as config.ts quotes a name.
export const badNameLine = (name: string) =>
  `its env has the name ${visible(JSON.stringify(name))}, which the box cannot take: ` +
  "a name there is letters, digits and _, not starting with a digit";
