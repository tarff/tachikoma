import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Bus, type ErrorEvent, type Events } from "../../src/core/bus.js";
import { PermissionGate } from "../../src/core/permissions.js";
import { type Conversation, Session } from "../../src/core/session.js";
import { localDate } from "../../src/core/setup.js";
import type { CompletionRequest, Provider, Turn } from "../../src/core/types.js";
import { askLesson, LESSON_REQUEST, lessonRequest, pairOf, type Ran } from "../../src/memory/lessons.js";
import { Memory } from "../../src/memory/memory.js";
import { LESSONS, WING } from "../../src/memory/paths.js";
import { defineTool, type ToolContext } from "../../src/tools/tool.js";
import { callTool, FakeProvider, Held, reply, tempDir, usage } from "../helpers.js";

// The lesson ask and storing lessons (8d plan, step 26): which calls make a pair, the request, the reply read, and,
// with the stand-in MemPalace as the user's own program (tests/memory/standin.mjs, never a real one), storing,
// memory's gate and the requests memory owns. No real model is called: the FakeProvider and the held provider of
// tests/helpers.ts answer. Every home, AppData folder, data folder and PATH of this process and of the stand-in is in
// a folder the test made; no error log is attached.

const STANDIN = path.resolve("tests/memory/standin.mjs");
// The tests' own limit for something that should happen: long enough never to be reached by one that does.
const LIMIT = 10_000;
const ROOM = "agent-harness-3f9a1c2b";
const lead = () => "fake:a";

const ran = (name: string, input: unknown, outcome: Ran["outcome"], error?: string): Ran =>
  (error === undefined ? { name, input, outcome } : { name, input, outcome, error });
const failed = (name: string, input: unknown, error = "it broke") => ran(name, input, "failed", error);
const ok = (name: string, input: unknown) => ran(name, input, "ok");

describe("which calls make a pair", () => {
  const root = path.resolve("made-up-project");

  it("pairs a failed command with a later one of the same first word that worked", () => {
    const a = failed("shell", { command: "git push origin main" });
    const b = ok("shell", { command: "  git   push --force-with-lease" });
    expect(pairOf([a, b], root)).toEqual({ failed: a, worked: b });
  });

  it("does not pair commands of different first words, nor a command with another tool", () => {
    expect(pairOf([failed("shell", { command: "git push" }), ok("shell", { command: "npm test" })], root))
      .toBeUndefined();
    expect(pairOf([failed("shell", { command: "git push" }), ok("read_file", { path: "git" })], root)).toBeUndefined();
    expect(pairOf([failed("read_file", { path: "a" }), ok("shell", { command: "read_file" })], root)).toBeUndefined();
  });

  it("pairs edits of the same file, write or edit, its path resolved against the project and its letter case aside",
    () => {
      const a = failed("edit_file", { path: "src/Cart.ts", old_text: "x", new_text: "y" });
      const b = ok("write_file", { path: path.join(root, "SRC", "cart.ts"), content: "y" });
      expect(pairOf([a, b], root)).toEqual({ failed: a, worked: b });
    });

  it("does not pair edits of different files", () => {
    expect(pairOf([failed("edit_file", { path: "a.ts" }), ok("edit_file", { path: "b.ts" })], root)).toBeUndefined();
  });

  it("pairs another tool with itself, whatever its input, and not with another tool", () => {
    const a = failed("read_file", { path: "a.ts" });
    const b = ok("read_file", { path: "b.ts" });
    expect(pairOf([a, b], root)).toEqual({ failed: a, worked: b });
    expect(pairOf([a, ok("find_files", { pattern: "a.ts" })], root)).toBeUndefined();
  });

  it("counts a declined or cancelled call as neither a failure nor a call that worked", () => {
    const job = { command: "git push" };
    expect(pairOf([ran("shell", job, "declined"), ok("shell", job)], root)).toBeUndefined();
    expect(pairOf([ran("shell", job, "cancelled"), ok("shell", job)], root)).toBeUndefined();
    expect(pairOf([failed("shell", job), ran("shell", job, "declined")], root)).toBeUndefined();
    expect(pairOf([failed("shell", job), ran("shell", job, "cancelled")], root)).toBeUndefined();
  });

  // PR #26 review, finding 5: a command still running when its call returned has not finished, so it has not worked.
  it("does not take a command still running when its call returned for the one that worked", () => {
    const a = failed("shell", { command: "npm test" });
    const running: Ran = { ...ok("shell", { command: "npm run dev", background: true }), running: true };
    const b = ok("shell", { command: "npm test -- --run" });
    expect(pairOf([a, running], root)).toBeUndefined();
    expect(pairOf([a, running, b], root)).toEqual({ failed: a, worked: b });
  });

  it("pairs only a call that worked after the failure, and gives the first pair of several", () => {
    const job = { command: "git push" };
    expect(pairOf([ok("shell", job), failed("shell", job)], root)).toBeUndefined();
    const a = failed("read_file", { path: "a" });
    const b = failed("shell", job);
    const c = ok("shell", job);
    const d = ok("read_file", { path: "a" });
    expect(pairOf([a, b, c, d], root)).toEqual({ failed: a, worked: d });
    expect(pairOf([b, a, c, d], root)).toEqual({ failed: b, worked: c });
  });

  it("finds no pair in a turn with no failure", () => {
    expect(pairOf([ok("shell", { command: "git push" }), ok("shell", { command: "git push" })], root)).toBeUndefined();
    expect(pairOf([], root)).toBeUndefined();
  });
});

describe("the request", () => {
  it("is the approved text, and a message of the failed call, its error and the call that worked alone", () => {
    expect(LESSON_REQUEST).toBe("A tool call failed earlier in this turn, and a later call doing the same job " +
      "worked. If there is a lesson worth keeping for next time, write it in one line: what went wrong, what fixed " +
      "it, and how to spot it. If there is none, answer: none.");
    expect(lessonRequest('shell {"command":"git push"}', "exit code: 1\nboom", 'shell {"command":"git push -f"}'))
      .toBe('Failed call: shell {"command":"git push"}\nIts error: exit code: 1\nboom\n' +
        'The call that worked: shell {"command":"git push -f"}');
  });
});

describe("asking for a lesson", () => {
  const TEXT = lessonRequest("a 1", "it broke", "a 2");
  const ask = async (answers: (Turn | Error)[], signal = new AbortController().signal) => {
    const bus = new Bus();
    const spent: Events["usage"][0][] = [];
    const errors: ErrorEvent[] = [];
    bus.on("usage", (u) => spent.push(u));
    bus.on("error", (e) => errors.push(e));
    const provider = new Recording("a", answers);
    const line = await askLesson(provider, TEXT, signal, bus);
    return { line, provider, spent, errors };
  };

  it("sends one request, the approved text its system prompt, no tools, its one message the three lines", async () => {
    const a = await ask([reply("Push failed on auth; a fresh token fixed it; look for 'Authentication failed'.")]);
    expect(a.provider.requests).toEqual([{ system: LESSON_REQUEST, tools: [], cache: false,
      messages: [{ role: "user", parts: [{ type: "text", text: TEXT }] }] }]);
    expect(a.line).toBe("Push failed on auth; a fresh token fixed it; look for 'Authentication failed'.");
  });

  it("gives the reply's first line alone", async () => {
    expect((await ask([reply("The lesson.\nMore words.\nAnd more.")])).line).toBe("The lesson.");
  });

  it.each(["none", "None.", " NONE \nbecause nothing was learned"])("gives nothing for the answer %j", async (text) => {
    expect((await ask([reply(text)])).line).toBeUndefined();
  });

  it("gives nothing for a reply cut off, a blank one, a failed request or a stopped one, and says no error",
    async () => {
      const cut = { ...reply("A lesson that was cut"), cutOff: { kind: "max_tokens" as const, detail: "limit" } };
      const stopped = new AbortController();
      stopped.abort();
      const all = [await ask([cut]), await ask([reply("  \n ")]), await ask([new Error("the provider failed")]),
        await ask([reply("A lesson.")], stopped.signal)];
      expect(all.map((a) => a.line)).toEqual([undefined, undefined, undefined, undefined]);
      expect(all.flatMap((a) => a.errors)).toEqual([]);
    });

  it("gives nothing for a first line over 100,000 characters, counted as MemPalace counts them", async () => {
    expect((await ask([reply("x".repeat(100_001))])).line).toBeUndefined();
    // 100,000 code points, 200,000 UTF-16 units: held, as MemPalace counts by code point.
    const emoji = "\u{1F600}".repeat(100_000);
    expect((await ask([reply(emoji)])).line).toBe(emoji);
  });

  it("reports its spend marked as the lesson ask's, the declined attempts' too", async () => {
    const declined = [{ provider: "fake:b", usage, priceKnown: true }];
    const a = await ask([{ ...reply("A lesson."), declined, servedBy: "fake:c" }]);
    expect(a.spent).toEqual([{ provider: "fake:b", usage, priceKnown: true, lesson: true },
      { provider: "fake:c", usage, lesson: true }]);
  });
});

// A FakeProvider that also keeps every request whole, but its signal.
class Recording extends FakeProvider {
  readonly requests: Omit<CompletionRequest, "signal">[] = [];
  override async complete(req: CompletionRequest): Promise<Turn> {
    const { signal: _, ...kept } = req;
    this.requests.push(structuredClone(kept));
    return super.complete(req);
  }
}

// --- With memory: the stand-in MemPalace as the user's own program. ---

const made: Memory[] = [];
const records: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  const closing = Promise.allSettled(made.splice(0).map((m) => m.close({ lessons: "cancel" })));
  await Promise.race([closing, sleep(LIMIT)]);
  vi.unstubAllEnvs();
  const started = records.splice(0).flatMap((r) => lines(r).flatMap((l) => (l.start ? [l.start.pid as number] : [])));
  // The folders are removed once this has run, even when it fails (tempDir; cleanup plan, step 9).
  await until(() => started.every((pid) => !alive(pid)), "the stand-ins to end");
}, 4 * LIMIT);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function until(check: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > LIMIT) throw new Error(`waited too long for ${what}`);
    await sleep(20);
  }
}

const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  await sleep(50);
  return done;
};

const lines = (record: string) =>
  existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// The turns' own requests are answered from `turns`; the lesson ask's are held until the test answers them.
class Split implements Provider {
  readonly id = "fake:a";
  readonly held = new Held("fake:a");
  readonly turns: Turn[] = [];
  complete(req: CompletionRequest): Promise<Turn> {
    if (req.system === LESSON_REQUEST) return this.held.complete(req);
    const next = this.turns.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error("Split ran out of turns"));
  }
}

// Memory with the stand-in as the user's own program, in a folder the test made, and a lead's session given the
// lesson ask, whose `shell` stand-in fails or works as `outcomes` say, one call each.
async function withMemory() {
  const top = tempDir("tachi-lessonask-");
  const user = path.join(top, "user");
  const bin = path.join(top, "bin");
  mkdirSync(bin, { recursive: true });
  const env = { PATH: bin, USERPROFILE: user, HOME: user, APPDATA: path.join(user, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(user, "AppData", "Local"), TACHI_DATA_DIR: path.join(top, "tachi-data") };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const record = path.join(top, "record.jsonl");
  records.push(record);
  const bus = new Bus();
  // Every error but the rows of the turns' own failed calls.
  const errors: ErrorEvent[] = [];
  bus.on("error", (e) => e.kind !== "tool" && errors.push(e));
  const m = new Memory({ memory: { use: STANDIN }, bus, lead,
    launch: (file) => ({ command: process.execPath, args: [file, "--record", record] }) });
  made.push(m);
  const on = () => until(() => m.on(), "memory on");
  const outcomes: (string | Error)[] = [];
  const shell = defineTool("shell", "A stand-in", z.object({ command: z.string() }), async () => {
    const o = outcomes.shift();
    if (o instanceof Error) throw o;
    return o ?? "done";
  });
  const provider = new Split();
  const ctx = { gate: new PermissionGate("never", async () => false) } as unknown as Omit<ToolContext, "signal">;
  const session = (room = ROOM) => new Session({ lead: provider, tools: [shell], system: "t", ctx, bus,
    lessonAsk: { memory: m, room, timeout: LIMIT } });
  // One turn that asks: `git push` fails, then `git push --force` works.
  const asking = async (s: Session) => {
    outcomes.push(new Error("exit code: 1\n--- stderr ---\nrejected\n--- stdout ---\n"), "pushed");
    provider.turns.push(callTool("c1", "shell", { command: "git push" }),
      callTool("c2", "shell", { command: "git push --force" }), reply("done"));
    await s.send("go");
  };
  const adds = () => lines(record).flatMap((l) => (l.call?.name === "mempalace_add_drawer" ? [l.call.arguments] : []));
  const entries = async () => {
    const r = await m.palace!.entries(LESSONS, LIMIT);
    return r.is === "counted" ? r.entries : r;
  };
  return { m, on, bus, errors, provider, held: provider.held, session, asking, adds, entries, record };
}

describe("storing a lesson", () => {
  it("stores the reply's first line alone in the lessons, labelled with the project's room and the day", async () => {
    const w = await withMemory();
    w.m.start();
    await w.on();
    await w.asking(w.session());
    await until(() => w.held.asked.length === 1, "the ask");
    w.held.answer("Pushes are rejected when the remote moved; pulling first fixed it.\nA second line.");
    await until(() => w.adds().length === 1, "the add");
    expect(w.adds()).toEqual([{ wing: WING, room: LESSONS, source_file: `tachikoma lesson, ${ROOM}, ${localDate()}`,
      content: "Pushes are rejected when the remote moved; pulling first fixed it." }]);
    expect(w.errors).toEqual([]);
  });

  it("holds the same lesson learned in two turns on two days once", async () => {
    const w = await withMemory();
    w.m.start();
    await w.on();
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = w.session();
    for (const [i, day] of [19, 20].entries()) {
      vi.setSystemTime(new Date(2026, 10, day, 12));
      await w.asking(s);
      await until(() => w.held.asked.length === i + 1, "the ask");
      w.held.answer("Pull before pushing when the remote moved.");
      await until(() => w.adds().length === i + 1, "the add");
    }
    await w.m.waitLessons();
    expect(w.adds().map((a) => a.source_file)).toEqual([`tachikoma lesson, ${ROOM}, 2026-11-19`,
      `tachikoma lesson, ${ROOM}, 2026-11-20`]);
    expect(await w.entries()).toBe(1);
    expect(w.errors).toEqual([]);
  });

  it("holds the same lesson learned in two projects once", async () => {
    const w = await withMemory();
    w.m.start();
    await w.on();
    for (const [i, room] of [ROOM, "web-shop-0c41d9e7"].entries()) {
      await w.asking(w.session(room));
      await until(() => w.held.asked.length === i + 1, "the ask");
      w.held.answer("Pull before pushing when the remote moved.");
      await until(() => w.adds().length === i + 1, "the add");
    }
    await w.m.waitLessons();
    expect(w.adds().map((a) => a.source_file.split(", ")[1])).toEqual([ROOM, "web-shop-0c41d9e7"]);
    expect(await w.entries()).toBe(1);
    expect(w.errors).toEqual([]);
  });
});

describe("memory's gate", () => {
  it("asks nothing while memory is setting up, then once the set-up is done the next turn asks and stores",
    async () => {
      const w = await withMemory();
      const s = w.session();
      expect(w.m.state).toEqual({ is: "setting up" });
      await w.asking(s);
      await sleep(100);
      expect(w.held.asked).toEqual([]);
      w.m.start();
      await w.on();
      await w.asking(s);
      await until(() => w.held.asked.length === 1, "the ask");
      w.held.answer("A lesson.");
      await w.m.waitLessons();
      expect(w.held.asked).toHaveLength(1);
      expect(w.adds().map((a) => a.content)).toEqual(["A lesson."]);
    });

  it("stores nothing from a reply that comes back after memory has failed", async () => {
    const w = await withMemory();
    w.m.start();
    await w.on();
    await w.asking(w.session());
    await until(() => w.held.asked.length === 1, "the ask");
    const pid = lines(w.record).find((l) => l.start)!.start.pid as number;
    process.kill(pid);
    await until(() => w.m.state.is === "off", "memory off");
    w.held.answer("A lesson that came too late.");
    await w.m.waitLessons();
    expect(w.adds()).toEqual([]);
  });

  it("asks nothing once closing has begun", async () => {
    const w = await withMemory();
    w.m.start();
    await w.on();
    const closing = w.m.close({ lessons: "wait" });
    await w.asking(w.session());
    await closing;
    expect(w.held.asked).toEqual([]);
  });
});

describe("the lesson requests memory owns", () => {
  it("cancels one held: it stores nothing, says no error and leaves nothing running", async () => {
    const w = await withMemory();
    w.m.start();
    await w.on();
    await w.asking(w.session());
    await until(() => w.held.asked.length === 1, "the ask");
    w.m.cancelLessons();
    expect(await settled(w.m.waitLessons())).toBe(true);
    w.held.answer("A lesson that came too late.");
    await sleep(100);
    expect(w.adds()).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  it("waits for one held: released during the wait, it stores its lesson exactly once", async () => {
    const w = await withMemory();
    w.m.start();
    await w.on();
    await w.asking(w.session());
    await until(() => w.held.asked.length === 1, "the ask");
    const waiting = w.m.waitLessons();
    expect(await settled(waiting)).toBe(false);
    w.held.answer("A lesson.");
    await waiting;
    await w.m.waitLessons();
    await sleep(100);
    expect(w.adds().map((a) => a.content)).toEqual(["A lesson."]);
  });

  it("ends a wait at once when its caller's stop signal fires, and cancels the request held", async () => {
    const w = await withMemory();
    w.m.start();
    await w.on();
    await w.asking(w.session());
    await until(() => w.held.asked.length === 1, "the ask");
    const stop = new AbortController();
    const waiting = w.m.waitLessons(stop.signal);
    expect(await settled(waiting)).toBe(false);
    const began = Date.now();
    stop.abort();
    await waiting;
    expect(Date.now() - began).toBeLessThan(LIMIT / 2);
    expect(await settled(w.m.waitLessons())).toBe(true);
    w.held.answer("A lesson that came too late.");
    await sleep(100);
    expect(w.adds()).toEqual([]);
  });

  it("lets one held finish and store across a session switch", async () => {
    const w = await withMemory();
    w.m.start();
    await w.on();
    const s = w.session();
    await w.asking(s);
    await until(() => w.held.asked.length === 1, "the ask");
    const fresh: Conversation = { id: "s2", messages: [], system: "t", prompts: [], calls: [], nextPicture: 1,
      nextTask: 1 };
    s.load(fresh);
    w.held.answer("A lesson.");
    await w.m.waitLessons();
    expect(w.adds().map((a) => a.content)).toEqual(["A lesson."]);
  });
});
