import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { privateDir } from "../../src/auth/private.js";
import { type Line, readOutline, readTranscript, Transcript, wholeLines } from "../../src/core/transcript.js";
import type { Message } from "../../src/core/types.js";
import { removeTree } from "../helpers.js";

// Release 8a plan, Task 3. The sessions folder is inside a fresh temporary folder, as privateDir needs (plan, "Rules for
// every task"). Making a folder private starts PowerShell on Windows, so the cases share one, each with its own session
// in it, as the App's tests share their history folder; only the cases that break the layout get a folder of their own.
describe("transcript", { timeout: 15_000 }, () => {
  let top: string;
  let shared: string;
  let sessions = 0;
  beforeAll(async () => {
    top = await mkdtemp(path.join(tmpdir(), "tachi-transcript-"));
    shared = path.join(top, "sessions", "project");
    privateDir(shared);
  });
  afterAll(() => removeTree(top));
  function place() {
    const id = `s${++sessions}`;
    return { file: path.join(shared, `${id}.jsonl`), pictures: path.join(shared, id, "pictures"), subagents: path.join(shared, id, "subagents") };
  }
  async function fresh() {
    const own = await mkdtemp(path.join(tmpdir(), "tachi-transcript-"));
    onTestFinished(() => removeTree(own));
    const dir = path.join(own, "data", "sessions", "project");
    return { top: own, file: path.join(dir, "s1.jsonl"), pictures: path.join(dir, "s1", "pictures") };
  }
  // A subagent's file, written as its transcript would write it: a Transcript would make the new subagents folder
  // private, which starts PowerShell again.
  const subagentFile = (folder: string, id: string, lines: object[]) => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `${id}.jsonl`), lines.map((l) => `${JSON.stringify({ at: "2026-11-06T00:00:00.000Z", ...l })}\n`).join(""));
  };
  const start: Omit<Extract<Line, { t: "start" }>, "at"> = {
    t: "start",
    v: 1,
    id: "s1",
    project: "C:\\a project",
    lead: "fake:a",
    version: "0.8.0",
    print: false,
    system: "Be brief.",
    tools: [{ name: "read_file", description: "Reads a file", inputSchema: { type: "object" } }],
  };
  const prompt = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });
  const said = (text: string): Message => ({ role: "assistant", parts: [{ type: "text", text }] });
  const asks = (id: string, input: unknown): Message => ({ role: "assistant", parts: [{ type: "tool_call", id, name: "read_file", input }] });
  const answers = (id: string, output: string): Message => ({ role: "user", parts: [{ type: "tool_result", callId: id, output, isError: false }] });
  const picture = (id: number, data: Buffer): Message => ({
    role: "user",
    parts: [
      { type: "text", text: "look at " },
      { type: "image", id, mediaType: "image/png", data },
    ],
  });
  const read = (p: { file: string; pictures: string }) => {
    const r = readTranscript(p.file, p.pictures);
    if ("problem" in r) throw new Error(r.problem);
    return r;
  };
  // Replaces line `i` (from 0) of the file with half of itself, as a crash or a full disk leaves one.
  const tear = (file: string, i: number) => {
    const lines = readFileSync(file, "utf8").split("\n");
    lines[i] = lines[i]!.slice(0, lines[i]!.length / 2);
    writeFileSync(file, lines.join("\n"));
  };
  const UNKNOWN =
    "Outcome unknown: the session ended while this was running, or before its result was saved. It may have run in full or in part. " +
    "Check what it would have changed before running it again.";

  // A reply's lead too (release 8a plan, choice 27; user, 2026-11-06: "Record each reply's lead").
  it("reads back every kind of line, a reply's provider content and lead included", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    const reply: Message = {
      role: "assistant",
      parts: [
        { type: "text", text: "Reading it." },
        { type: "tool_call", id: "c1", name: "read_file", input: { path: "a.txt" } },
      ],
      native: { provider: "anthropic", content: [{ type: "thinking", thinking: "hm", signature: "sig==" }] },
      lead: "anthropic:claude-opus-5-5",
    };
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "what is in a.txt?" }] },
      reply,
      {
        role: "user",
        parts: [
          { type: "tool_result", callId: "c1", output: "hello", isError: false },
          { type: "text", text: "Background task t1 finished", from: "tasks" },
        ],
      },
      said("It says hello."),
    ];
    t.write(start);
    t.write({ t: "name", name: "greeting" });
    for (const message of history) t.write({ t: "message", message });
    t.write({ t: "lead", lead: "fake:b" });
    t.write({ t: "subagent", id: "t1", description: "find it", file: "t1.jsonl" });
    expect(t.failed).toBeNull();
    const lines = readFileSync(p.file, "utf8").split("\n");
    expect(lines.at(-1)).toBe("");
    for (const l of lines.slice(0, -1)) expect(JSON.parse(l)).toMatchObject({ t: expect.any(String), at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    const r = read(p);
    expect(r.start).toMatchObject(start);
    expect(r.messages).toEqual(history);
    expect(r).toMatchObject({ system: "Be brief.", lead: "fake:b", name: "greeting", firstPrompt: "what is in a.txt?", damaged: 0 });
    expect(r).toMatchObject({ nextPicture: 1, nextTask: 2 });
    expect(r.prompts).toEqual(["what is in a.txt?"]);
    expect(r.calls).toEqual([{ name: "read_file", input: { path: "a.txt" } }]);
  });

  it("saves a picture as its own file, before its line, and reads its bytes back", async () => {
    const p = place();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: picture(1, bytes) });
    expect(readdirSync(p.pictures)).toEqual(["1.png"]);
    const line = JSON.parse(readFileSync(p.file, "utf8").split("\n")[1]!);
    expect(line.message.parts[1]).toEqual({ type: "image", id: 1, mediaType: "image/png", file: "1.png" });
    const r = read(p);
    expect(r.messages).toEqual([picture(1, bytes)]);
    expect(r.prompts).toEqual(["look at [Image #1]"]);
    expect(r.nextPicture).toBe(2);
  });

  it("reads a picture whose file is gone as a note saying so", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: picture(2, Buffer.from("bytes")) });
    rmSync(path.join(p.pictures, "2.png"));
    expect(read(p).messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "look at " },
          { type: "text", text: "[Image #2: not found]" },
        ],
      },
    ]);
  });

  it("mends a torn last line before the next write, so it stays one damaged line and the new message reads back", async () => {
    const p = place();
    const first = new Transcript(p.file, p.pictures);
    first.write(start);
    first.write({ t: "message", message: prompt("one") });
    appendFileSync(p.file, '{"t":"message","at":"2026-11-06T00:00:00.000Z","message":{"ro');
    const before = readFileSync(p.file, "utf8");
    // A new process resuming the session.
    const t = new Transcript(p.file, p.pictures);
    t.mend();
    t.mend(); // the second finds the line break the first added, and adds nothing
    expect(readFileSync(p.file, "utf8")).toBe(`${before}\n`);
    t.write({ t: "message", message: said("two") });
    const r = read(p);
    expect(r.messages).toEqual([prompt("one"), said("two")]);
    expect(r.damaged).toBe(1);
  });

  it("gives a call whose result line is damaged the 'Outcome unknown' result, and drops a result whose call is damaged", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    for (const message of [prompt("go"), asks("c1", { path: "a" }), answers("c1", "A"), asks("c2", { path: "b" }), answers("c2", "B"), said("done")]) {
      t.write({ t: "message", message });
    }
    tear(p.file, 3); // c1's result
    tear(p.file, 4); // the reply calling c2
    const r = read(p);
    expect(r.damaged).toBe(2);
    expect(r.messages).toEqual([
      prompt("go"),
      asks("c1", { path: "a" }),
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: UNKNOWN, isError: true }] },
      said("done"),
    ]);
  });

  it("gives the calls of a reply that ended the file the 'Outcome unknown' result: the crash case", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: prompt("go") });
    t.write({ t: "message", message: asks("c1", { path: "a" }) });
    expect(read(p).messages).toEqual([
      prompt("go"),
      asks("c1", { path: "a" }),
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: UNKNOWN, isError: true }] },
    ]);
  });

  it("starts the history at the last shortening's message and system prompt", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: prompt("one") });
    t.write({ t: "message", message: said("1") });
    t.write({ t: "shortened", system: "Second prompt.", message: prompt("summary A") });
    t.write({ t: "message", message: said("2") });
    t.write({ t: "shortened", system: "Third prompt.", message: prompt("summary B") });
    t.write({ t: "message", message: said("3") });
    const r = read(p);
    expect(r.messages).toEqual([prompt("summary B"), said("3")]);
    expect(r.system).toBe("Third prompt.");
  });

  describe("an interrupted shortening", () => {
    function shortenedOnce() {
      const p = place();
      const t = new Transcript(p.file, p.pictures);
      t.write(start);
      t.write({ t: "message", message: prompt("one") });
      t.write({ t: "message", message: said("1") });
      return { p, t };
    }

    it("reads back the whole history before a shortening line torn halfway, with one line damaged", async () => {
      const { p, t } = shortenedOnce();
      t.write({ t: "shortened", system: "New prompt.", message: prompt("summary") });
      const text = readFileSync(p.file, "utf8");
      const cut = text.lastIndexOf("\n", text.length - 2) + 1;
      writeFileSync(p.file, text.slice(0, cut + (text.length - cut) / 2)); // the test's own file, cut short
      const r = read(p);
      expect(r.messages).toEqual([prompt("one"), said("1")]);
      expect(r.system).toBe("Be brief.");
      expect(r.damaged).toBe(1);
    });

    it("leaves the file reading back the same when the shortening's write fails", async () => {
      const { p, t } = shortenedOnce();
      const before = readFileSync(p.file, "utf8");
      mkdirSync(path.dirname(p.pictures), { recursive: true });
      writeFileSync(p.pictures, ""); // a file where the pictures folder should be, so the summary's picture cannot be saved
      t.write({ t: "shortened", system: "New prompt.", message: picture(1, Buffer.from("x")) });
      expect(t.failed).toEqual(expect.any(String));
      expect(readFileSync(p.file, "utf8")).toBe(before);
      const r = read(p);
      expect(r.messages).toEqual([prompt("one"), said("1")]);
      expect(r).toMatchObject({ system: "Be brief.", damaged: 0 });
    });
  });

  it("rebuilds the judge's prompts and calls from the whole file, never from a summary", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    const waiting = { type: "text", text: "Background task t1 finished", from: "tasks" } as const;
    t.write({ t: "message", message: { role: "user", parts: [...picture(4, Buffer.from("x")).parts, waiting] } });
    t.write({ t: "message", message: asks("c1", { path: "before" }) });
    t.write({ t: "message", message: answers("c1", "B") });
    t.write({ t: "shortened", system: "New prompt.", message: prompt("summary of it all") });
    t.write({ t: "message", message: prompt("and now") });
    t.write({ t: "message", message: asks("c2", { path: "after" }) });
    const r = read(p);
    expect(r.prompts).toEqual(["look at [Image #4]", "and now"]);
    expect(r.calls).toEqual([
      { name: "read_file", input: { path: "before" } },
      { name: "read_file", input: { path: "after" } },
    ]);
    expect(r.firstPrompt).toBe("look at [Image #4]");
  });

  // Release 8b plan, choice 16 (design, review finding 4): a PreToolUse hook's rewrite is saved after its reply, and the
  // record of calls takes it in its call's place, before and after a shortening; the reply itself is kept as it came.
  it("puts each saved rewrite in its call's place in the calls, before and after a shortening, leaving the replies as they were", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: prompt("go") });
    t.write({ t: "message", message: asks("c1", { path: "A" }) });
    t.write({ t: "rewritten", id: "c1", input: { path: "B" } });
    t.write({ t: "message", message: answers("c1", "B's text") });
    t.write({ t: "shortened", system: "New prompt.", message: prompt("summary of it all") });
    // The same id again, as a provider may give a later call: each rewrite counts for the reply it follows.
    t.write({ t: "message", message: asks("c1", { path: "C" }) });
    t.write({ t: "message", message: answers("c1", "C's text") });
    t.write({ t: "message", message: asks("c2", { path: "D" }) });
    t.write({ t: "rewritten", id: "c2", input: { path: "E" } });
    // Tachikoma's fields are an object, never a list: such a line is damaged, and its call keeps its own input.
    t.write({ t: "message", message: asks("c3", { path: "F" }) });
    t.write({ t: "rewritten", id: "c3", input: ["G"] });
    expect(t.failed).toBeNull();
    const r = read(p);
    expect(r.damaged).toBe(1);
    expect(r.calls).toEqual([
      { name: "read_file", input: { path: "B" } },
      { name: "read_file", input: { path: "C" } },
      { name: "read_file", input: { path: "E" } },
      { name: "read_file", input: { path: "F" } },
    ]);
    expect(r.messages.filter((m) => m.role === "assistant")).toEqual([asks("c1", { path: "C" }), asks("c2", { path: "D" }), asks("c3", { path: "F" })]);
  });

  it("leaves a cut-off reply's calls out of the judge's calls, as session.ts never keeps them", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    const notRun = (id: string): Message => ({
      role: "user",
      parts: [{ type: "tool_result", callId: id, output: "Not run: the response was cut off (max_tokens).", isError: true }],
    });
    for (const message of [prompt("go"), asks("c1", { path: "run" }), answers("c1", "A"), asks("c2", { path: "cut off" }), notRun("c2")]) {
      t.write({ t: "message", message });
    }
    // A reply the crash left without results: the file cannot tell it from one that ran, so its calls count.
    t.write({ t: "message", message: asks("c3", { path: "crash" }) });
    expect(read(p).calls).toEqual([
      { name: "read_file", input: { path: "run" } },
      { name: "read_file", input: { path: "crash" } },
    ]);
  });

  it("counts both calls of a reply whose results only look like a cut-off reply's", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: prompt("go") });
    const reply: Message = {
      role: "assistant",
      parts: [
        { type: "tool_call", id: "c1", name: "read_file", input: { path: "a" } },
        { type: "tool_call", id: "c2", name: "read_file", input: { path: "b" } },
      ],
    };
    t.write({ t: "message", message: reply });
    const results: Message = {
      role: "user",
      parts: [
        { type: "tool_result", callId: "c1", output: "A", isError: false },
        { type: "tool_result", callId: "c2", output: "Not run: the response was cut off (a file that says so)", isError: true },
      ],
    };
    t.write({ t: "message", message: results });
    expect(read(p).calls).toEqual([
      { name: "read_file", input: { path: "a" } },
      { name: "read_file", input: { path: "b" } },
    ]);
  });

  it("numbers the next picture past every picture in the file and its folder", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: picture(3, Buffer.from("x")) });
    t.write({ t: "shortened", system: "New prompt.", message: prompt("summary") });
    expect(read(p).messages).toEqual([prompt("summary")]);
    expect(read(p).nextPicture).toBe(4);
    writeFileSync(path.join(p.pictures, "5.webp"), "saved just before a crash; its line never was");
    expect(read(p).nextPicture).toBe(6);
  });

  it("numbers the next subagent past every subagent line and every subagent file", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "subagent", id: "t1", description: "one", file: "t1.jsonl" });
    t.write({ t: "subagent", id: "t3", description: "three", file: "t3.jsonl" });
    expect(read(p).nextTask).toBe(4);
    mkdirSync(p.subagents, { recursive: true });
    writeFileSync(path.join(p.subagents, "t7.jsonl"), "");
    expect(read(p).nextTask).toBe(8);
  });

  it("lists the subagents whose files hold no final answer", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    for (const [id, description, messages] of [
      ["t1", "finished one", [prompt("brief 1"), asks("c1", {}), answers("c1", "x"), said("found it")]],
      ["t2", "cut off in a call", [prompt("brief 2"), asks("c1", {})]],
      ["t3", "never started", []], // so it has no file
    ] as const) {
      t.write({ t: "subagent", id, description, file: `${id}.jsonl` });
      if (messages.length) subagentFile(p.subagents, id, messages.map((message) => ({ t: "message", message })));
    }
    expect(read(p).unfinished).toEqual([
      { id: "t2", description: "cut off in a call" },
      { id: "t3", description: "never started" },
    ]);
  });

  it("lists no subagent whose file ends saying it failed or was stopped, as the lead was told so", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    for (const [id, state] of [
      ["t1", "failed"],
      ["t2", "stopped"],
      ["t3", null],
    ] as const) {
      t.write({ t: "subagent", id, description: `${state ?? "lost"} one`, file: `${id}.jsonl` });
      const ended = state ? [{ t: "ended", state }] : [];
      subagentFile(p.subagents, id, [{ t: "message", message: prompt("brief") }, { t: "message", message: asks("c1", {}) }, ...ended]);
    }
    expect(read(p).unfinished).toEqual([{ id: "t3", description: "lost one" }]);
  });

  // Release 8a plan, choice 4 (Task 6 spec review): a resume that reported a subagent lost says so in its file.
  it("lists no subagent whose file says a resume reported it lost", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "subagent", id: "t1", description: "look", file: "t1.jsonl" });
    subagentFile(p.subagents, "t1", [{ t: "message", message: prompt("brief") }, { t: "ended", state: "lost" }]);
    expect(read(p).unfinished).toEqual([]);
  });

  // Release 8a plan, choice 4 (Task 6 spec review): a reply keeps its provider's own content only under the tools it was
  // saved under, the last start or tools line before it.
  it("keeps a reply's own content only for the tools it was saved under", async () => {
    const p = place();
    const other = [{ name: "write_file", description: "Writes a file", inputSchema: { type: "object" } }];
    const thought = (text: string): Message => ({ ...said(text), native: { provider: "anthropic", content: [{ type: "thinking", thinking: text }] } });
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: prompt("one") });
    t.write({ t: "message", message: thought("under the first") });
    t.write({ t: "tools", tools: other });
    t.write({ t: "message", message: prompt("two") });
    t.write({ t: "message", message: thought("under the other") });
    const r = read(p);
    expect(r.tools).toEqual(other);
    expect(r.messages[1]!.native).toBeDefined();
    const first = r.withTools(start.tools, start.system);
    expect(first).toMatchObject({ dropped: true, otherTools: true });
    expect(first.messages.map((m) => m.native !== undefined)).toEqual([false, true, false, false]);
    expect(r.withTools(other, start.system).messages.map((m) => m.native !== undefined)).toEqual([false, false, false, true]);
    expect(r.withTools(other, start.system).dropped).toBe(true);
  });

  // Release 8a final review (user, 2026-11-07: "Rebuild it", "Save the setting"): a system line, as a resume under another
  // sandbox setting writes, is the prompt and setting from then on, and a reply keeps its own content only under the
  // prompt it was saved under too.
  it("keeps a reply's own content only for the system prompt it was saved under, the last start or system line", async () => {
    const p = place();
    const thought = (text: string): Message => ({ ...said(text), native: { provider: "anthropic", content: [{ type: "thinking", thinking: text }] } });
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: prompt("one") });
    t.write({ t: "message", message: thought("under the first") });
    expect(read(p).box).toBe(false); // a start line without the setting: off
    t.write({ t: "system", system: "In the box.", box: true });
    t.write({ t: "message", message: prompt("two") });
    t.write({ t: "message", message: thought("under the box's") });
    const r = read(p);
    expect(r).toMatchObject({ system: "In the box.", box: true });
    const box = r.withTools(start.tools, "In the box.");
    expect(box).toMatchObject({ dropped: true, otherTools: false });
    expect(box.messages.map((m) => m.native !== undefined)).toEqual([false, false, false, true]);
    expect(r.withTools(start.tools, start.system)).toMatchObject({ dropped: true, otherTools: false });
    expect(r.withTools(start.tools, start.system).messages.map((m) => m.native !== undefined)).toEqual([false, true, false, false]);
  });

  // Release 8a final review (user, 2026-11-07: "Becomes normal"): a -p run opened in the window is a session as any other.
  it("reads a -p run as one no longer once an interactive line follows", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write({ ...start, print: true });
    t.write({ t: "message", message: prompt("one") });
    expect(read(p).print).toBe(true);
    expect(readOutline(p.file)!.print).toBe(true);
    t.write({ t: "interactive" });
    expect(read(p).print).toBe(false);
    expect(readOutline(p.file)!.print).toBe(false);
  });

  it("writes no picture file again for a kept prompt's picture in a shortening line, and reads it back", async () => {
    const p = place();
    const bytes = Buffer.from("the picture");
    const first = new Transcript(p.file, p.pictures);
    first.write(start);
    first.write({ t: "message", message: picture(1, bytes) });
    // A resumed session's transcript, shortening with the prompt that holds picture 1 kept: its file is already there.
    // Other bytes under the same number, so a write over the saved file would show.
    const t = new Transcript(p.file, p.pictures);
    t.write({ t: "shortened", system: "New prompt.", message: picture(1, Buffer.from("other")) });
    expect(t.failed).toBeNull();
    expect(readdirSync(p.pictures)).toEqual(["1.png"]);
    expect(readFileSync(path.join(p.pictures, "1.png"))).toEqual(bytes);
    expect(read(p).messages).toEqual([picture(1, bytes)]);
  });

  it("stops saving, saying why, when a file stands where the sessions folder should be", async () => {
    const p = await fresh();
    mkdirSync(path.join(p.top, "data"));
    writeFileSync(path.join(p.top, "data", "sessions"), "");
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    expect(t.failed).toEqual(expect.any(String));
    const reason = t.failed;
    t.write({ t: "message", message: prompt("one") });
    expect(t.failed).toBe(reason);
    expect(readFileSync(path.join(p.top, "data", "sessions"), "utf8")).toBe("");
  });

  it("gives the whole lines of a file, leaving out a torn last one", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: prompt("one") });
    const whole = readFileSync(p.file, "utf8");
    appendFileSync(p.file, '{"t":"mess');
    expect(wholeLines(p.file)).toBe(whole);
  });

  it("says a file it cannot read is not a session", async () => {
    const p = await fresh();
    const r = readTranscript(p.file, p.pictures);
    expect(r).toEqual({ problem: expect.stringMatching(/^.+s1\.jsonl could not be read as a session \(.+\)\.$/) });
  });

  it("says a file whose first line is missing or damaged is not a session", async () => {
    const p = place();
    const words = `${p.file} could not be read as a session (its first line is missing or damaged).`;
    writeFileSync(p.file, "");
    expect(readTranscript(p.file, p.pictures)).toEqual({ problem: words });
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "message", message: prompt("one") });
    tear(p.file, 0);
    expect(readTranscript(p.file, p.pictures)).toEqual({ problem: words });
  });

  // The session list's reader (release 8a plan, Task 4) shows what resuming would load.
  it("outlines a file as the full reader reads it", async () => {
    const p = place();
    const t = new Transcript(p.file, p.pictures);
    t.write(start);
    t.write({ t: "name", name: "the fix" });
    t.write({ t: "lead", lead: "fake:b" });
    t.write({ t: "message", message: answers("c1", "a result whose call is gone") });
    t.write({ t: "message", message: prompt("the real prompt") });
    t.write({ t: "message", message: said("Done.") });
    t.write({ t: "message", message: prompt("and then?") });
    tear(p.file, 5);
    const full = read(p);
    const outline = readOutline(p.file)!;
    expect(full.damaged).toBe(1);
    expect(outline).toEqual({ start: full.start, print: full.print, name: full.name, lead: full.lead, firstPrompt: full.firstPrompt, said: true });
    expect(outline).toMatchObject({ name: "the fix", lead: "fake:b", firstPrompt: "the real prompt" });
  });
});
