import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Action, type Judge, PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { Tasks } from "../../src/core/tasks.js";
import type { Message, Provider, Turn } from "../../src/core/types.js";
import type { Executor } from "../../src/exec/executor.js";
import { LocalExecutor } from "../../src/exec/local.js";
import { judgeOf, type Verdict } from "../../src/safety/judge.js";
import { delegateTool } from "../../src/tools/delegate.js";
import { editFileTool, readFileTool } from "../../src/tools/files.js";
import { SUBAGENT_TOOLS, TOOLS } from "../../src/tools/index.js";
import { searchFilesTool } from "../../src/tools/search.js";
import { shellTool } from "../../src/tools/shell.js";
import type { Tool } from "../../src/tools/tool.js";
import { Bus, FakeProvider, callTool, collectErrors, reply, texts, usage } from "../helpers.js";

// Release 7 plan, Task 10: auto mode in the gate. Reads and project edits pass, dangers ask the user, and the judge
// decides the rest; after 3 refusals in a row or 20 in the session auto mode pauses (choice 8); an answer counts only if
// nothing changed while it was out. The commands here are text the gate reads; no test runs one.

const PAUSED = (n: number) => `Auto mode paused after ${n} refusals; approving this resumes it.`;
const yes = reply('{"allow": true}');
const no = (reason = "It is not part of the task.") => reply(JSON.stringify({ allow: false, reason }));
type Asked = { summary: string; owner?: string; warnings?: string[]; note?: string };

// One reply holding several calls, which the session runs one after another.
const calls = (...made: [string, unknown][]): Turn => ({ parts: made.flatMap(([name, input], i) => callTool(`c${i + 1}`, name, input).parts), usage });
// What the tools gave back in the last request the lead was sent.
const results = (lead: FakeProvider) => lead.seen.at(-1)!.flatMap((m: Message) => m.parts.flatMap((p) => (p.type === "tool_result" ? [p.output] : [])));
// The action line of each judge's request (judge.ts, request).
const judged = (j: { seen: Message[][] }) => j.seen.map((messages) => JSON.parse(texts(messages[0]!)[0]!.split("\n")[7]!) as Action);

// A session in auto as cli.tsx makes it: the gate's judge is judgeOf on the session, and a subagent's gate adds its own
// calls. The user answers each question from `answers`, and no when they run out.
// `judge` undefined: none set, so the lead leading judges, as cli.tsx gives it without --judge.
async function setup(lead: FakeProvider, judge: Provider | undefined, opts: { headless?: boolean; answers?: boolean[]; worker?: Provider } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "tachi-"));
  const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-"));
  const bus = new Bus();
  const errors = collectErrors(bus);
  const asked: Asked[] = [];
  const answers = opts.answers ?? [];
  let session: Session | undefined;
  const gate = new PermissionGate(
    "auto",
    async (summary, _detail, owner, _plain, warnings, note) => {
      asked.push({ summary, ...(owner ? { owner: owner.name } : {}), ...(warnings?.length ? { warnings } : {}), ...(note ? { note } : {}) });
      return answers.shift() ?? false;
    },
    opts.headless ? "Not allowed in -p mode, where nobody can approve it" : undefined,
    { root, headless: opts.headless ?? false, judge: judgeOf(judge, () => session!, "Run the tests before committing.", bus) },
  );
  const executor = new LocalExecutor();
  const tasks = new Tasks({ bus, max: 8, worker: () => opts.worker ?? new FakeProvider("w", []), system: "sub", tools: SUBAGENT_TOOLS, ctx: { root, executor, gate } });
  session = new Session({ lead, tools: [...TOOLS, delegateTool(tasks, { headless: opts.headless ?? false })], system: "t", ctx: { root, executor, gate }, bus, inbox: () => tasks.take() });
  return { root, elsewhere, bus, errors, asked, gate, session, tasks, out: (name: string) => path.join(elsewhere, name) };
}

describe("auto mode, in a session", () => {
  it("runs an action the judge allows, and gives the model the judge's reason for one it refuses", async () => {
    const j = new FakeProvider("judge", [yes, no("The user asked only for notes in the project.")]);
    const script: Turn[] = [];
    const lead = new FakeProvider("lead", script);
    const s = await setup(lead, j);
    script.push(calls(["write_file", { path: s.out("a.txt"), content: "one" }], ["write_file", { path: s.out("b.txt"), content: "two" }]), reply("done"));
    await s.session.send("write the notes");
    expect(await readFile(s.out("a.txt"), "utf8")).toBe("one");
    expect(existsSync(s.out("b.txt"))).toBe(false);
    expect(results(lead)).toEqual(["Wrote 3 characters to " + s.out("a.txt"), "The judge refused: The user asked only for notes in the project."]);
    expect(s.asked).toEqual([]);
  });

  it("passes a read and a write in the project without the judge, and sends a read outside it, by read_file and search_files, to the judge", async () => {
    const j = new FakeProvider("judge", [yes, yes]);
    const script: Turn[] = [];
    const lead = new FakeProvider("lead", script);
    const s = await setup(lead, j);
    await writeFile(path.join(s.root, "a.txt"), "inside");
    await writeFile(s.out("notes.txt"), "outside");
    script.push(
      calls(
        ["read_file", { path: "a.txt" }],
        ["write_file", { path: "b.txt", content: "new" }],
        ["search_files", { pattern: "inside" }],
        ["read_file", { path: s.out("notes.txt") }],
        ["search_files", { pattern: "outside", path: s.elsewhere }],
      ),
      reply("done"),
    );
    await s.session.send("look around");
    expect(judged(j).map((a) => [a.kind, a.outside, a.summary])).toEqual([
      ["read", true, `read ${s.out("notes.txt")}`],
      ["read", true, `search ${s.elsewhere}`],
    ]);
    expect(await readFile(path.join(s.root, "b.txt"), "utf8")).toBe("new");
    expect(s.asked).toEqual([]);
  });

  it("refuses when the judge's answer cannot be read, and when the judge cannot be reached, which fails no turn", async () => {
    const j = new FakeProvider("judge", [reply("Sure, go ahead."), new Error("rate limited")]);
    const script: Turn[] = [];
    const lead = new FakeProvider("lead", script);
    const s = await setup(lead, j);
    script.push(calls(["write_file", { path: s.out("a.txt"), content: "x" }], ["write_file", { path: s.out("b.txt"), content: "x" }]), reply("done"));
    await s.session.send("write");
    expect(results(lead)).toEqual(["The judge refused: the judge's answer could not be read", "The judge refused: the judge could not be reached: rate limited"]);
    expect(s.errors).toEqual([{ kind: "judge", attempted: "request to fake:judge", message: "rate limited", lead: "fake:judge" }]);
    expect(texts(s.session.messages.at(-1)!)).toEqual(["done"]); // the turn went on to the model's answer
  });

  it("asks the user, with the red lines and never the judge, before a dangerous command", async () => {
    const j = new FakeProvider("judge", []);
    const lead = new FakeProvider("lead", [calls(["shell", { command: "git push --force" }]), reply("done")]);
    const s = await setup(lead, j);
    await s.session.send("push it");
    expect(s.asked).toEqual([{ summary: "run: git push --force", warnings: ["Danger: rewriting or deleting git history: git push --force"] }]);
    expect(j.seen).toEqual([]);
    expect(results(lead)).toEqual(["The user declined: run: git push --force"]);
  });

  it("sends a protected write in the project to the judge", async () => {
    const j = new FakeProvider("judge", [no("It changes a git hook.")]);
    const lead = new FakeProvider("lead", [calls(["write_file", { path: ".husky/pre-commit", content: "npm test" }]), reply("done")]);
    const s = await setup(lead, j);
    await mkdir(path.join(s.root, ".husky"));
    await s.session.send("add a hook");
    expect(judged(j).map((a) => a.protectedPart)).toEqual([".husky"]);
    expect(results(lead)).toEqual(["The judge refused: It changes a git hook."]);
    expect(existsSync(path.join(s.root, ".husky", "pre-commit"))).toBe(false);
  });

  it("pauses after 3 refusals in a row, asking with the line, and approving one resumes auto mode and starts the row again", async () => {
    const j = new FakeProvider("judge", [no(), no(), no(), no(), yes]);
    const script: Turn[] = [];
    const lead = new FakeProvider("lead", script);
    const s = await setup(lead, j, { answers: [true] });
    const writes = ["a", "b", "c", "d", "e", "f"].map((n): [string, unknown] => ["write_file", { path: s.out(`${n}.txt`), content: n }]);
    script.push(calls(...writes), reply("done"));
    await s.session.send("write them");
    expect(s.asked).toEqual([{ summary: `write ${s.out("d.txt")}`, note: PAUSED(3) }]);
    // After the approval one refusal (e) is the first of a new row, so f goes to the judge, not to the user.
    expect(judged(j).map((a) => a.summary)).toEqual(["a", "b", "c", "e", "f"].map((n) => `write ${s.out(`${n}.txt`)}`));
    expect(["d", "e", "f"].map((n) => existsSync(s.out(`${n}.txt`)))).toEqual([true, false, true]);
  });

  it("goes to the judge again for the same action asked twice", async () => {
    const j = new FakeProvider("judge", [yes, yes]);
    const read: [string, unknown] = ["read_file", { path: "/made/up/elsewhere/notes.txt" }];
    const lead = new FakeProvider("lead", [calls(read, read), reply("done")]);
    const s = await setup(lead, j);
    await s.session.send("read it twice");
    expect(j.seen).toHaveLength(2);
    expect(s.asked).toEqual([]);
  });

  it("never sends the judge a tool's result", async () => {
    const j = new FakeProvider("judge", [yes]);
    const script: Turn[] = [];
    const lead = new FakeProvider("lead", script);
    const s = await setup(lead, j);
    await writeFile(path.join(s.root, "a.txt"), "MARKER-from-a-tool");
    script.push(calls(["read_file", { path: "a.txt" }], ["read_file", { path: s.out("b.txt") }]), reply("done"));
    await s.session.send("read both");
    expect(JSON.stringify(lead.seen)).toContain("MARKER-from-a-tool");
    expect(j.seen).toHaveLength(1);
    expect(JSON.stringify(j.seen)).not.toContain("MARKER");
    const lines = texts(j.seen[0]![0]!)[0]!.split("\n");
    expect(lines[1]).toBe('["read both"]');
    expect(JSON.parse(lines[4]!)).toEqual([
      { name: "read_file", input: { path: "a.txt" } },
      { name: "read_file", input: { path: s.out("b.txt") } },
    ]);
    expect(lines[10]).toBe('"Run the tests before committing."');
  });

  it("judges a subagent's action with the lead's prompts, the lead's calls and then its own, and counts its refusals in the lead's gate", async () => {
    const outside = (n: string): [string, unknown] => ["read_file", { path: `/made/up/elsewhere/${n}.txt` }];
    const worker = new FakeProvider("w", [calls(outside("a"), outside("b"), outside("c")), reply("found nothing")]);
    const j = new FakeProvider("judge", [no(), no(), no()]);
    const lead = new FakeProvider("lead", [calls(["delegate", { description: "look", task: "find the notes" }]), calls(["write_file", { path: "/made/up/elsewhere/d.txt", content: "x" }]), reply("done")]);
    const s = await setup(lead, j, { worker });
    await s.session.send("find the notes");
    const lines = texts(j.seen[0]![0]!)[0]!.split("\n");
    expect(lines[1]).toBe('["find the notes"]');
    expect(JSON.parse(lines[4]!)).toEqual([
      { name: "delegate", input: { description: "look", task: "find the notes" } },
      ...["a", "b", "c"].map((n) => ({ name: "read_file", input: { path: `/made/up/elsewhere/${n}.txt` } })), // a reply's calls are kept before any runs
    ]);
    expect(j.seen).toHaveLength(3);
    // The lead's next action that would go to the judge asks: the subagent's three refusals were the session's.
    expect(s.asked).toEqual([{ summary: expect.stringContaining("d.txt"), note: PAUSED(3) }]);
  });

  // With no judge set, the lead leading judges a subagent's action too, never the subagent's own model (release 7 design,
  // "The modes": "Unset, the lead's own model judges").
  it("with no judge set, sends a subagent's action to the lead to judge, not to the worker", async () => {
    const lead = new FakeProvider("lead", [calls(["delegate", { description: "look", task: "find the notes" }]), yes, reply("done")]);
    const worker = new FakeProvider("w", [calls(["read_file", { path: "/made/up/elsewhere/a.txt" }]), reply("found nothing")]);
    const s = await setup(lead, undefined, { worker });
    await s.session.send("find the notes");
    expect(lead.seen).toHaveLength(3);
    expect(judged({ seen: [lead.seen[1]!] }).map((a) => a.summary)).toEqual([expect.stringContaining("a.txt")]);
    expect(worker.seen).toHaveLength(2); // its own two requests, and no judge's
    expect(JSON.stringify(worker.seen)).not.toContain("The user's own messages");
    expect(s.tasks.all.map((t) => t.state)).toEqual(["done"]);
  });

  it("gives a subagent's judge errors to the subagent, which still finishes", async () => {
    const worker = new FakeProvider("w", [calls(["read_file", { path: "/made/up/elsewhere/a.txt" }]), reply("found nothing")]);
    const j = new FakeProvider("judge", [new Error("judge down")]);
    const lead = new FakeProvider("lead", [calls(["delegate", { description: "look", task: "find the notes" }]), reply("done")]);
    const s = await setup(lead, j, { worker });
    await s.session.send("find the notes");
    expect(s.tasks.all.map((t) => [t.state, t.answer])).toEqual([["done", "found nothing"]]);
    expect(s.errors).toEqual([{ kind: "judge", attempted: "t1: request to fake:judge", message: "judge down", lead: "fake:judge" }]);
    expect(worker.seen.at(-1)!.at(-1)!.parts).toMatchObject([{ type: "tool_result", output: "The judge refused: the judge could not be reached: judge down" }]);
  });
});

// Release 7 plan, Task 10: each tool gives the gate the turn's signal, so stopping the turn while the judge is out runs
// nothing. The judge records the signal it was given and says yes after the stop, whatever the signal says, and the
// executor records what reaches it, so an action that ran would show.
describe("auto mode, the turn's signal from each tool", () => {
  const cases: [string, Tool, (elsewhere: string) => unknown][] = [
    ["read_file, outside the project", readFileTool, (elsewhere) => ({ path: path.join(elsewhere, "notes.txt") })],
    ["edit_file", editFileTool, (elsewhere) => ({ path: path.join(elsewhere, "notes.txt"), old_text: "old", new_text: "new" })],
    ["search_files", searchFilesTool, (elsewhere) => ({ pattern: "old", path: elsewhere })],
    ["shell", shellTool, () => ({ command: "echo hi" })],
  ];
  it.each(cases)("%s: stopping the turn while the judge is out rejects with the stop and runs nothing", async (_, tool, input) => {
    const root = await mkdtemp(path.join(tmpdir(), "tachi-"));
    const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-"));
    await writeFile(path.join(elsewhere, "notes.txt"), "old");
    let given: AbortSignal | undefined;
    let answer: ((v: Verdict) => void) | undefined;
    const judge: Judge = (_action, signal) => ((given = signal), new Promise((resolve) => (answer = resolve)));
    const gate = new PermissionGate("auto", async () => false, undefined, { root, judge });
    const ran: string[] = [];
    const executor: Executor = {
      exec: async (command) => (ran.push(`exec ${command}`), { code: 0, signal: null, stdout: "", stderr: "" }),
      readFile: async (abs) => (ran.push(`read ${abs}`), "old"),
      writeFile: async (abs) => void ran.push(`write ${abs}`),
    };
    const stop = new AbortController();
    const running = tool.run(input(elsewhere), { root, executor, gate, signal: stop.signal });
    for (let i = 0; i < 40 && !answer; i++) await settle();
    stop.abort();
    answer!({ allow: true });
    await expect(running).rejects.toBe(stop.signal.reason);
    expect(given).toBe(stop.signal);
    expect(ran).toEqual([]);
    expect(await readFile(path.join(elsewhere, "notes.txt"), "utf8")).toBe("old");
  });
});

// The gate alone, with a judge the test answers: each request waits in `out` until the test gives its verdict, whatever
// the signal does, so the gate's own recheck is what is tried.
function heldGate(opts: { headless?: boolean; answers?: boolean[] } = {}) {
  const out: { action: Action; answer: (v: Verdict) => void }[] = [];
  const judge: Judge = (action) => new Promise((answer) => out.push({ action, answer }));
  const asked: Asked[] = [];
  const answers = opts.answers ?? [];
  const gate = new PermissionGate(
    "auto",
    async (summary, _detail, _owner, _plain, warnings, note) => {
      asked.push({ summary, ...(warnings?.length ? { warnings } : {}), ...(note ? { note } : {}) });
      return answers.shift() ?? false;
    },
    opts.headless ? "Not allowed in -p mode, where nobody can approve it" : undefined,
    { root: "/made/up/project", headless: opts.headless ?? false, judge },
  );
  return { gate, out, asked };
}
const outside = (n: number): Action => ({ kind: "read", outside: true, summary: `read /made/up/elsewhere/${n}.txt` });
const run = (command: string): Action => ({ kind: "shell", outside: false, summary: `run: ${command}`, command });
// Settles each verdict in turn for one action at a time, returning how each ended.
async function decide(g: ReturnType<typeof heldGate>, action: Action, verdict?: Verdict): Promise<string> {
  const done = g.gate.require(action, new AbortController().signal).then(
    () => "ran",
    (err: Error) => err.message,
  );
  await Promise.resolve();
  if (verdict) g.out.shift()!.answer(verdict);
  return done;
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const NO: Verdict = { allow: false, reason: "No." };
const YES: Verdict = { allow: true };

describe("auto mode, in the gate", () => {
  it("pauses once the session has had 20 refusals, and again at each refusal after that", async () => {
    const g = heldGate({ answers: [true, false] });
    let n = 0;
    for (let round = 0; round < 10; round++) {
      // Two refusals and a yes: never 3 in a row.
      expect(await decide(g, outside(n++), NO)).toBe("The judge refused: No.");
      expect(await decide(g, outside(n++), NO)).toBe("The judge refused: No.");
      if (round < 9) expect(await decide(g, outside(n++), YES)).toBe("ran");
    }
    expect(g.asked).toEqual([]);
    expect(await decide(g, outside(n++))).toBe("ran"); // approved: auto mode resumes
    expect(g.asked).toEqual([{ summary: "read /made/up/elsewhere/29.txt", note: PAUSED(20) }]);
    expect(await decide(g, outside(n++), NO)).toBe("The judge refused: No.");
    expect(await decide(g, outside(n++))).toBe("The user declined: read /made/up/elsewhere/31.txt");
    expect(await decide(g, outside(n++))).toBe("The user declined: read /made/up/elsewhere/32.txt"); // a no keeps it paused
    expect(g.asked.slice(1).map((a) => a.note)).toEqual([PAUSED(21), PAUSED(21)]);
    expect(g.out).toEqual([]);
  });

  // A question still waiting from an earlier pause, approved after auto mode resumed and paused again, must not lift the
  // later pause: only one asked under the pause in force does (the code-quality review).
  it("lets only a question asked under the pause in force lift it, not one still waiting from an earlier pause", async () => {
    const questions: { summary: string; note?: string; answer: (yes: boolean) => void }[] = [];
    const judged: string[] = [];
    const judge: Judge = async (action) => (judged.push(action.summary), judged.length <= 6 ? NO : YES);
    const ask = (summary: string, _detail?: string, _owner?: unknown, _plain?: boolean, _warnings?: string[], note?: string) =>
      new Promise<boolean>((answer) => questions.push({ summary, ...(note ? { note } : {}), answer }));
    const gate = new PermissionGate("auto", ask, undefined, { root: "/made/up/project", judge });
    const child = gate.for({ name: "t1", signal: new AbortController().signal, stop: () => {} });
    for (let n = 1; n <= 3; n++) await expect(gate.require(outside(n))).rejects.toThrow("The judge refused: No.");
    const a = gate.require(outside(4)); // the lead's
    const b = child.require(outside(5)); // a subagent's, waiting behind it under the same pause
    await settle();
    expect(questions.map((q) => q.note)).toEqual([PAUSED(3), PAUSED(3)]);
    questions.shift()!.answer(true);
    await a; // auto mode resumes
    for (let n = 6; n <= 8; n++) await expect(gate.require(outside(n))).rejects.toThrow("The judge refused: No."); // and pauses again
    questions.shift()!.answer(true);
    await b; // approved, but asked under the first pause
    const f = gate.require(outside(9));
    await settle();
    expect(questions.map((q) => [q.summary, q.note])).toEqual([["read /made/up/elsewhere/9.txt", PAUSED(3)]]);
    expect(judged).toHaveLength(6);
    questions.shift()!.answer(false);
    await expect(f).rejects.toThrow("The user declined: read /made/up/elsewhere/9.txt");
  });

  // A refusal from a judge request already out when auto mode paused continues that pause, so the question waiting
  // under it still resumes auto mode when approved.
  it("counts a refusal that comes during a pause in that pause, so the question waiting under it still lifts it", async () => {
    const questions: { note?: string; answer: (yes: boolean) => void }[] = [];
    const out: ((v: Verdict) => void)[] = [];
    const judge: Judge = () => new Promise((answer) => out.push(answer));
    const ask = (_summary: string, _detail?: string, _owner?: unknown, _plain?: boolean, _warnings?: string[], note?: string) =>
      new Promise<boolean>((answer) => questions.push({ ...(note ? { note } : {}), answer }));
    const gate = new PermissionGate("auto", ask, undefined, { root: "/made/up/project", judge });
    const refused = [1, 2, 3].map((n) => gate.require(outside(n)).catch((err: Error) => err.message));
    const late = gate.require(outside(4)).catch((err: Error) => err.message); // out at the judge before the pause
    for (const answer of out.splice(0, 3)) answer(NO);
    expect(await Promise.all(refused)).toEqual(Array(3).fill("The judge refused: No."));
    const waiting = gate.require(outside(5)); // asks, under the pause
    await settle();
    expect(questions.map((q) => q.note)).toEqual([PAUSED(3)]);
    out.shift()!(NO); // the late refusal, during the pause
    expect(await late).toBe("The judge refused: No.");
    questions.shift()!.answer(true);
    await waiting; // approved: auto mode resumes
    const next = gate.require(outside(6));
    await settle();
    expect(questions).toEqual([]);
    expect(out).toHaveLength(1); // it went to the judge
    out.shift()!(YES);
    await next;
  });

  it("headless, never asks: every refusal is final, and the run carries on", async () => {
    const g = heldGate({ headless: true });
    for (let n = 0; n < 25; n++) expect(await decide(g, outside(n), NO)).toBe("The judge refused: No.");
    expect(await decide(g, outside(25), YES)).toBe("ran");
    expect(g.asked).toEqual([]);
  });

  it("runs nothing when the turn is stopped while the judge is out, even if a yes comes after", async () => {
    const g = heldGate();
    const stop = new AbortController();
    const done = g.gate.require(outside(1), stop.signal);
    await Promise.resolve();
    stop.abort();
    g.out.shift()!.answer(YES);
    await expect(done).rejects.toBe(stop.signal.reason);
    expect(g.asked).toEqual([]);
  });

  it("decides again under the mode now in force when it changed while the judge was out", async () => {
    const g = heldGate({ answers: [true] });
    const done = g.gate.require(run("echo hi"), new AbortController().signal);
    await Promise.resolve();
    g.gate.mode = "ask";
    g.out.shift()!.answer(YES);
    await done;
    expect(g.asked).toEqual([{ summary: "run: echo hi" }]);
    expect(g.out).toEqual([]); // decided under ask: the judge was not asked again
  });

  // The design: an answer counts only for the rules it was given under, so a mode that left auto and came back while the
  // judge was out throws it away too.
  it("decides again when the mode went from auto and back while the judge was out", async () => {
    const g = heldGate();
    const done = g.gate.require(run("echo hi"), new AbortController().signal);
    await Promise.resolve();
    for (const mode of ["ask", "project", "auto"] as const) g.gate.mode = mode;
    g.out.shift()!.answer(YES);
    await settle();
    expect(g.out.map((o) => o.action.summary)).toEqual(["run: echo hi"]); // asked again, under auto
    g.out.shift()!.answer(YES);
    await done;
    expect(g.asked).toEqual([]);
  });

  it("decides again with the rules now in force when they changed while the judge was out", async () => {
    const g = heldGate();
    const done = g.gate.require(run("make deploy"), new AbortController().signal).catch((err: Error) => err.message);
    await Promise.resolve();
    g.gate.rules = { add: ["make deploy"], off: [] };
    g.out.shift()!.answer(YES);
    expect(await done).toBe("The user declined: run: make deploy");
    expect(g.asked).toEqual([{ summary: "run: make deploy", warnings: ["Danger: your own rule: make deploy: make deploy"] }]);

    // Any live edit of the rules throws the answer away, even one that does not match: the action goes to the judge again.
    const again = g.gate.require(run("make test"), new AbortController().signal);
    await Promise.resolve();
    g.gate.rules = { add: ["make deploy", "terraform apply"], off: [] };
    g.out.shift()!.answer(NO);
    await settle();
    expect(g.out.map((o) => o.action.summary)).toEqual(["run: make test"]);
    g.out.shift()!.answer(YES);
    await again;
  });

  it("shows the judge's reason with control characters as escapes", async () => {
    const g = heldGate();
    expect(await decide(g, outside(1), { allow: false, reason: "No\u001b[8m." })).toBe("The judge refused: No\\u001b[8m.");
  });
});
