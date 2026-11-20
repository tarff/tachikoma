import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { localDate } from "../../src/core/setup.js";
import { connect, type Palace } from "../../src/memory/client.js";
import type { MemoryState } from "../../src/memory/memory.js";
import { LESSONS, WING } from "../../src/memory/paths.js";
import type { ToolContext } from "../../src/tools/tool.js";
import { memoryTools } from "../../src/tools/memory.js";
import { readLog } from "../mcp/fake.js";
import { removeTree } from "../helpers.js";

// The three memory tools (8d plan, step 23) against the stand-in MemPalace (tests/memory/standin.mjs) as a program over
// stdio, which keeps its entries in memory and records every call into a folder the test made. Nothing here starts a
// real MemPalace or touches a real palace.

const STANDIN = path.resolve("tests/memory/standin.mjs");
// The tests' own limit for a request that should answer, long enough never to be reached by one that does; and a short
// one, for a request the stand-in holds or answers late, so that it passes.
const LIMIT = 10_000;
const SHORT = 500;
const ROOM = "agent-harness-3f9a1c2b";
const SESSION = "4c1e0d2a";
// The tools use no part of the context.
const CTX = {} as ToolContext;

const palaces: Palace[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(palaces.splice(0).map((p) => p.close()));
  for (const folder of folders.splice(0)) await removeTree(folder);
});

// A memory stand-in: the state and the palace, as step 21's Memory gives them; the test changes them.
type Held = { state: MemoryState; palace: Palace | undefined };

async function start(args: string[] = [], o: { everything?: "wing" | "palace"; search?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-memtools-"));
  folders.push(dir);
  const record = path.join(dir, "record.jsonl");
  const memory: Held = { state: { is: "on" }, palace: undefined };
  const made = await connect({ command: process.execPath, args: [STANDIN, "--record", record, ...args] }, "own", {
    timeout: LIMIT,
    onLost: () => {
      memory.state = { is: "failing", reason: "Memory is failing: the hub stopped answering; restarting it." };
      memory.palace = undefined;
    },
  });
  if (made.is !== "connected") throw new Error(`not connected: ${JSON.stringify(made)}`);
  palaces.push(made.palace);
  memory.palace = made.palace;
  const tools = memoryTools({
    memory,
    room: ROOM,
    everything: o.everything ?? "wing",
    session: () => SESSION,
    timeouts: { search: o.search ?? LIMIT, add: LIMIT },
  });
  const calls = () => readLog(record).flatMap((l) => (l.call ? [l.call] : []));
  return { memory, palace: made.palace, tools, calls, record };
}

const search = (t: Awaited<ReturnType<typeof start>>, input: unknown) => t.tools.search.run(input, CTX);

describe("memory_search", () => {
  it("has the approved description and inputs", async () => {
    const t = await start();
    expect(t.tools.search.spec.name).toBe("memory_search");
    expect(t.tools.search.spec.description).toBe(
      "Search long-term memory: earlier conversations with the user, saved notes and lessons from earlier failures. " +
        'Scope "project" (the default) searches this project and the lessons; "all" searches everything in the palace.',
    );
    const props = (t.tools.search.spec.inputSchema as { properties: Record<string, { description?: string }> })
      .properties;
    expect(props.query!.description).toBe("What to look for, in plain words; only the first 250 characters are used.");
    expect(props.scope!.description).toBe('"project" (the default) or "all".');
    expect((t.tools.search.spec.inputSchema as { required: string[] }).required).toEqual(["query"]);
  });

  it("searches this project's room and the lessons at once, five each, and merges them closest first", async () => {
    const t = await start();
    await t.palace.add(ROOM, "tachikoma session a, turn 1", "the build failed on a missing lock file today", LIMIT);
    await t.palace.add(LESSONS, "tachikoma lesson, x-1, 2026-11-19", "a missing lock file: run the install", LIMIT);
    await t.palace.add("other-12345678", "tachikoma session b, turn 1", "missing lock file in another project", LIMIT);
    const out = await search(t, { query: "missing lock file" });
    const searches = t.calls().filter((c) => c.name === "mempalace_search");
    expect(searches.map((c) => c.arguments)).toEqual([
      { query: "missing lock file", limit: 5, wing: WING, room: ROOM },
      { query: "missing lock file", limit: 5, wing: WING, room: LESSONS },
    ]);
    const today = localDate();
    expect(out).toBe(
      `${today} · tachikoma lesson, x-1, 2026-11-19 · ${LESSONS}\na missing lock file: run the install\n\n` +
        `${today} · tachikoma session a, turn 1 · ${ROOM}\nthe build failed on a missing lock file today`,
    );
  });

  it("keeps the five closest of both rooms together", async () => {
    const t = await start();
    // "lock" and k other words: the stand-in's distance is 1 - 1/(1 + k), so the order is set by k alone.
    const words = (k: number) => ["lock", ...Array.from({ length: k }, (_, j) => `w${j}`)].join(" ");
    for (let i = 0; i < 4; i++) {
      await t.palace.add(ROOM, `tachikoma session a, turn ${i + 1}`, words(i * 2), LIMIT);
      await t.palace.add(LESSONS, `tachikoma lesson, x-1, d${i}`, words(i * 2 + 1), LIMIT);
    }
    const out = await search(t, { query: "lock", scope: "project" });
    const labels = out.split("\n\n").map((m) => m.split("\n")[0]!.split(" · ")[1]);
    expect(labels).toEqual([
      "tachikoma session a, turn 1",
      "tachikoma lesson, x-1, d0",
      "tachikoma session a, turn 2",
      "tachikoma lesson, x-1, d1",
      "tachikoma session a, turn 3",
    ]);
  });

  it('searches the whole wing for "all" with Tachikoma\'s own palace, in one search', async () => {
    const t = await start();
    await t.palace.add("other-12345678", "tachikoma session b, turn 1", "lock file in another project", LIMIT);
    const out = await search(t, { query: "lock file", scope: "all" });
    expect(t.calls().filter((c) => c.name === "mempalace_search").map((c) => c.arguments)).toEqual([
      { query: "lock file", limit: 5, wing: WING },
    ]);
    expect(out).toContain("tachikoma session b, turn 1 · other-12345678");
  });

  it('searches the whole palace for "all" with the user\'s own MemPalace', async () => {
    const t = await start([], { everything: "palace" });
    await search(t, { query: "lock file", scope: "all" });
    expect(t.calls().filter((c) => c.name === "mempalace_search").map((c) => c.arguments)).toEqual([
      { query: "lock file", limit: 5 },
    ]);
  });

  it("sends a query of 300 characters as its first 250", async () => {
    const t = await start();
    const query = "a".repeat(250) + "b".repeat(50);
    await search(t, { query, scope: "all" });
    expect(t.calls().find((c) => c.name === "mempalace_search")!.arguments.query).toBe("a".repeat(250));
  });

  it("shows a turn saved in parts by that part's label and the matched piece's text", async () => {
    const t = await start();
    const label = "tachikoma session a, turn 7, part 2 of 3";
    const text = `${"w ".repeat(400)}${"lock file ".repeat(20)}`; // 800 + 200 characters: two pieces
    await t.palace.add(ROOM, label, text, LIMIT);
    const out = await search(t, { query: "lock file" });
    const [first, ...rest] = out.split("\n\n");
    expect(first).toBe(`${localDate()} · ${label} · ${ROOM}\n${"lock file ".repeat(20)}`);
    expect(rest.map((m) => m.split("\n")[1]!.length)).toEqual([800]);
  });

  it("says when nothing matches", async () => {
    const t = await start();
    expect(await search(t, { query: "nothing here" })).toBe("No matches.");
  });

  it("takes only the two scopes", async () => {
    const t = await start();
    await expect(search(t, { query: "x", scope: "everything" })).rejects.toThrow("Invalid input for memory_search");
    expect(t.calls()).toEqual([]);
  });
});

describe("memory_save", () => {
  it("has the approved description and input", async () => {
    const t = await start();
    expect(t.tools.save.spec.name).toBe("memory_save");
    expect(t.tools.save.spec.description).toBe(
      "Save a note to long-term memory, for something worth keeping beyond this conversation, such as a decision, a " +
        "fact about the project or a preference of the user's. It is filed under this project.",
    );
    const props = (t.tools.save.spec.inputSchema as { properties: Record<string, { description?: string }> })
      .properties;
    expect(props.text!.description).toBe("The note, written so it makes sense on its own later.");
  });

  it("files each note in the project's room, labelled as this session's next note", async () => {
    const t = await start();
    expect(await t.tools.save.run({ text: "The user prefers tabs." }, CTX)).toBe("Saved.");
    expect(await t.tools.save.run({ text: "Releases go out on Fridays." }, CTX)).toBe("Saved.");
    expect(t.calls().filter((c) => c.name === "mempalace_add_drawer").map((c) => c.arguments)).toEqual([
      {
        wing: WING,
        room: ROOM,
        content: "The user prefers tabs.",
        source_file: `tachikoma session ${SESSION}, note 1`,
      },
      {
        wing: WING,
        room: ROOM,
        content: "Releases go out on Fridays.",
        source_file: `tachikoma session ${SESSION}, note 2`,
      },
    ]);
  });

  it("takes a note of 100,000 characters, and refuses one of 100,001 without sending it", async () => {
    const t = await start();
    expect(await t.tools.save.run({ text: "n".repeat(100_000) }, CTX)).toBe("Saved.");
    await expect(t.tools.save.run({ text: "n".repeat(100_001) }, CTX)).rejects.toThrow(
      new Error("Not saved: a note can be at most 100,000 characters."),
    );
    expect(t.calls().filter((c) => c.name === "mempalace_add_drawer")).toHaveLength(1);
  });
});

describe("record_lesson", () => {
  it("has the approved description and input", async () => {
    const t = await start();
    expect(t.tools.lesson.spec.name).toBe("record_lesson");
    expect(t.tools.lesson.spec.description).toBe(
      "Record a lesson after fixing a failure, so it is found when a like failure comes back, in any project: what " +
        "went wrong, what fixed it, and how to spot it next time.",
    );
    const props = (t.tools.lesson.spec.inputSchema as { properties: Record<string, { description?: string }> })
      .properties;
    expect(props.lesson!.description).toBe("The lesson, in one or two sentences.");
  });

  it("files the lesson alone in lessons, the project and the date in its label", async () => {
    const t = await start();
    const lesson = "npm ci failed on a stale lock file; deleting node_modules fixed it.";
    expect(await t.tools.lesson.run({ lesson }, CTX)).toBe("Recorded.");
    const adds = t.calls().filter((c) => c.name === "mempalace_add_drawer");
    expect(adds.map((c) => c.arguments)).toEqual([
      { wing: WING, room: LESSONS, content: lesson, source_file: `tachikoma lesson, ${ROOM}, ${localDate()}` },
    ]);
    expect(adds[0]!.arguments.content).not.toContain(ROOM);
    expect(adds[0]!.arguments.content).not.toContain(localDate());
  });

  it("stores the same lesson once, and says so the second time", async () => {
    const t = await start();
    const lesson = "A missing lock file: run the install first.";
    expect(await t.tools.lesson.run({ lesson }, CTX)).toBe("Recorded.");
    expect(await t.tools.lesson.run({ lesson }, CTX)).toBe("Not recorded: memory already holds this lesson.");
    expect(await t.palace.entries(LESSONS, LIMIT)).toEqual({ is: "counted", entries: 1 });
  });

  it("refuses a lesson of 100,001 characters without sending it", async () => {
    const t = await start();
    await expect(t.tools.lesson.run({ lesson: "l".repeat(100_001) }, CTX)).rejects.toThrow(
      new Error("Not recorded: a lesson can be at most 100,000 characters."),
    );
    expect(t.calls().filter((c) => c.name === "mempalace_add_drawer")).toEqual([]);
  });
});

describe("the three tools, with memory not on", () => {
  const each = (t: Awaited<ReturnType<typeof start>>) => [
    () => t.tools.search.run({ query: "lock" }, CTX),
    () => t.tools.save.run({ text: "a note" }, CTX),
    () => t.tools.lesson.run({ lesson: "a lesson" }, CTX),
  ];

  it("says memory is not ready yet while it is still connecting, and sends nothing", async () => {
    const t = await start();
    t.memory.state = { is: "setting up" };
    for (const run of each(t)) {
      await expect(run()).rejects.toThrow(new Error("Memory is not ready yet; try again shortly."));
    }
    expect(t.calls()).toEqual([]);
  });

  it("gives the state's reason when memory is off or failing, and sends nothing", async () => {
    const t = await start();
    for (const state of [
      { is: "off", reason: "Memory is off: the hub did not start (exit code: 1)." },
      { is: "failing", reason: "Memory is failing: the hub stopped answering; restarting it." },
    ] as MemoryState[]) {
      t.memory.state = state;
      for (const run of each(t)) await expect(run()).rejects.toThrow(new Error((state as { reason: string }).reason));
    }
    expect(t.calls()).toEqual([]);
  });

  it("gives the state's reason when memory fails during the call", async () => {
    const t = await start(["--slow", "2000"]);
    const pending = t.tools.search.run({ query: "lock" }, CTX);
    await sleep(200);
    await t.palace.close(); // as the program ending: the client's close is not a loss, so mark it lost here
    t.memory.state = { is: "failing", reason: "Memory is failing: the hub stopped answering; restarting it." };
    await expect(pending).rejects.toThrow(new Error("Memory is failing: the hub stopped answering; restarting it."));
  });

  it("uses the palace while memory winds down, and says memory is off once it is closed", async () => {
    const t = await start();
    t.memory.state = { is: "winding down" };
    expect(await t.tools.save.run({ text: "a note" }, CTX)).toBe("Saved.");
    t.memory.state = { is: "closed" };
    t.memory.palace = undefined;
    for (const run of each(t)) await expect(run()).rejects.toThrow(new Error("Memory is off."));
    expect(t.calls()).toHaveLength(1);
  });

  it("says a search that passes its limit did not answer in time, while memory is still on", async () => {
    const t = await start(["--slow", "2000"], { search: SHORT });
    await expect(t.tools.search.run({ query: "lock" }, CTX)).rejects.toThrow(
      new Error("Memory did not answer within 0.5 s; try again shortly."),
    );
  });

  it("gives MemPalace's words when it refuses a note, while memory is still on", async () => {
    const t = await start(["--refuse-writes"]);
    await expect(t.tools.save.run({ text: "a note" }, CTX)).rejects.toThrow(
      new Error("Memory refused it: the stand-in refuses writes."),
    );
  });
});
