// The box's Workspace (release 7 design, "Nothing on the host opens a path in the box's folder while the box runs"; plan,
// Task 13): each operation is one `docker exec -i <box> node -e <loader>`, with the helper's code and the request on
// stdin, so the image need not change with each Tachikoma version. Docker is reached only through a DockerRun (choice
// 69).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import type { Match, Workspace } from "../exec/workspace.js";
import { BINARY_TEST_BYTES, LINE_CUT } from "../tools/search.js";
import { docker, type DockerRun } from "./docker.js";
import { BoxState, inGroup, NO_DOCKER } from "./executor.js";
import { helper, type Request } from "./helper.js";

// What `node -e` runs in the box: it reads the call's JSON from stdin, {code, request}, runs the code with the request
// and Node's require, and writes one JSON answer, {ok} or {error, code}.
export const LOADER =
  'let s="";process.stdin.setEncoding("utf8").on("data",(d)=>{s+=d}).on("end",async()=>{let a;try{const{code,request}=JSON.parse(s);' +
  'a={ok:await new Function("request","require",code)(request,require)}}catch(e){a={error:String(e&&e.message||e),code:e&&e.code}}' +
  "process.stdout.write(JSON.stringify(a))})";

// The code a call sends: the `ignore` library, then the helper's own source, as this process was given it. `ignore`'s
// index.js is found as Node finds the package from here: in a global install, in the node_modules of Tachikoma's own
// package folder (or one above it, where the package manager hoisted it). `__name` is tsx's (helper.ts).
export function helperCode(source = String(helper)): string {
  const lib = readFileSync(createRequire(import.meta.url).resolve("ignore"), "utf8");
  return [
    "const __name = (f) => f;",
    "const module = { exports: {} };",
    `(function (module, exports) {\n${lib}\n})(module, module.exports);`,
    `return (${source})(request, module.exports, require);`,
  ].join("\n");
}

let code: string | undefined;

export class BoxWorkspace implements Workspace {
  #branch: string | null = null;

  // `root` is the box's folder for the project; a test gives a host folder, with the host's Node standing in for Docker.
  // `state` is the box's, shared with its DockerExecutor (Task 16), so once either finds Docker failing both are off.
  constructor(
    readonly id: string,
    private readonly run: DockerRun = docker,
    readonly root = "/work",
    private readonly state = new BoxState(id, run),
  ) {}

  // `trusted` is the host's, for instruction files, which are read before the box starts.
  async resolve(p: string, _opts?: { trusted?: boolean }) {
    return (await this.#call({ op: "resolve", path: p })) as { abs: string; outside: boolean; shown: string; real: string; linked: boolean };
  }

  async readText(abs: string): Promise<string> {
    return (await this.#call({ op: "readText", path: abs })) as string;
  }

  async writeText(abs: string, content: string): Promise<void> {
    await this.#call({ op: "writeText", path: abs, content });
  }

  async find(start: string, pattern: string, signal?: AbortSignal): Promise<string[]> {
    return (await this.#call({ op: "find", path: start, pattern }, signal)) as string[];
  }

  async search(start: string, pattern: string, glob: string | undefined, signal?: AbortSignal): Promise<{ matches: Match[]; beyond: number }> {
    const request = { op: "search", path: start, pattern, glob, cap: MAX_TOOL_OUTPUT, binaryBytes: BINARY_TEST_BYTES, lineCut: LINE_CUT } as const;
    return (await this.#call(request, signal)) as { matches: Match[]; beyond: number };
  }

  // Read after every turn (queue.ts), so while the tools are off it is the branch last read, with no Docker call and no
  // red line after each turn (Task 14's review).
  async branch(): Promise<string | null> {
    if (this.state.broken) return this.#branch;
    this.#branch = (await this.#call({ op: "branch" })) as string | null;
    return this.#branch;
  }

  // One call, in a process group of its own, as DockerExecutor.exec runs a command (executor.ts, inGroup), so an abort
  // kills the whole group in the box. Docker failing stops the box's shell and file tools, as the executor's does. An
  // answer that is not JSON asks first whether the box still runs (choice 106): while it does, only this call fails,
  // naming the memory limit when the box's memory-kill count rose, as the executor's out-of-memory line does.
  async #call(request: DistributiveOmit<Request, "root">, signal?: AbortSignal): Promise<unknown> {
    const { state } = this;
    if (state.broken) throw state.broken;
    if (signal?.aborted) throw new Error("Cancelled");
    const before = state.oomKills;
    const input = Buffer.from(JSON.stringify({ code: (code ??= helperCode()), request: { ...request, root: this.root } }), "utf8");
    const got = await inGroup(this.run, this.id, ["-i"], "node -e", LOADER, { input, signal });
    if ("cancelled" in got) throw new Error("Cancelled");
    if ("unreached" in got) throw state.fail(got.unreached);
    let answer: { ok?: unknown; error?: string; code?: string };
    try {
      answer = JSON.parse(got.out);
    } catch {
      const gone = await state.gone();
      if (gone === NO_DOCKER) throw state.fail(NO_DOCKER);
      if (gone !== undefined) throw state.fail(got.err.trim() || gone);
      const words = (await state.outOfMemory(before, got.code)) ? `it used more than ${state.memoryLine()}` : got.err.trim() || `exit code ${got.code}`;
      throw new Error(`The file tool stopped in the box before it answered: ${words}${words.endsWith(".") ? "" : "."}`);
    }
    if (answer.error !== undefined) throw Object.assign(new Error(answer.error), answer.code ? { code: answer.code } : {});
    return answer.ok ?? null;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
