import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { running } from "../../src/exec/local.js";
import { connect, type Kind, type Palace, palaceFile, type Target } from "../../src/memory/client.js";
import { load } from "../../src/memory/oslock.js";
import { LESSONS, WING } from "../../src/memory/paths.js";
import { readLog } from "../mcp/fake.js";
import { removeTree } from "../helpers.js";

// Tachikoma's palace client against the stand-in MemPalace (8d plan, step 18), in both of its forms: the hub over HTTP
// and a program over stdio. Nothing here starts a real hub or touches a real palace.

const STANDIN = path.resolve("tests/memory/standin.mjs");
// The tests' own limit for a call that should answer: long enough never to be reached by one that does.
const LIMIT = 10_000;
const ROOM = "agent-harness-3f9a1c2b";
// A connect to a program that answers `initialize` late and lists nothing: the test's own limit, when the program
// answers, and how far past the limit the connect may answer. The margin is 5 times the most measured on this PC, 15
// ms in 40 runs (20 alone, 20 beside this file's and oslock's tests), as the user's margins are (the step 18 report,
// "Review fixes").
const HANG_LIMIT = 1_000;
const HANG_START = 600;
const HANG_MARGIN = 75;

type Hub = ChildProcessByStdio<null, Readable, Readable>;
const hubs: Hub[] = [];
const palaces: Palace[] = [];
const folders: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(palaces.splice(0).map((p) => p.close()));
  await Promise.all(
    hubs.splice(0).map(async (hub) => {
      if (hub.exitCode !== null || hub.signalCode !== null) return;
      const closed = new Promise((resolve) => hub.on("close", resolve));
      hub.kill("SIGKILL");
      await closed;
    }),
  );
  for (const folder of folders.splice(0)) await removeTree(folder);
});

async function folder(): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), "tachi-client-"));
  folders.push(made);
  return made;
}

// The stand-in started as the hub, with its home and palace in a folder the test made and the hub's model setting.
async function startHub(args: string[] = []) {
  const dir = await folder();
  const record = path.join(dir, "record.jsonl");
  const home = path.join(dir, "home");
  const palace = path.join(dir, "palace");
  const hub = spawn(
    process.execPath,
    [STANDIN, "--transport", "http", "--port", "0", "--palace", palace, "--backend", "sqlite_exact", "--record", record,
      ...args],
    {
      env: { ...process.env, USERPROFILE: home, HOME: home, MEMPALACE_EMBEDDING_MODEL: "minilm" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  hubs.push(hub);
  const closed = new Promise<number | null>((resolve) => hub.on("close", resolve));
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    hub.stdout.setEncoding("utf8");
    hub.stdout.on("data", (d: string) => {
      out += d;
      if (out.includes("\n")) resolve(JSON.parse(out.slice(0, out.indexOf("\n"))).port);
    });
    void closed.then((code) => reject(new Error(`the stand-in hub exited with code ${code}`)));
  });
  return { hub, port, closed, record, home, palace, target: { url: `http://127.0.0.1:${port}/mcp` } as Target };
}

// The stand-in as a program the client starts over stdio, recording into a folder the test made. `withPalace` gives it
// a palace there and the backend, only so that its read-back can be shown: Tachikoma never gives the user's own
// program either (the test of its start, below).
async function startProgram(args: string[] = [], withPalace = false) {
  const dir = await folder();
  const record = path.join(dir, "record.jsonl");
  const palace = path.join(dir, "palace");
  const given = withPalace ? ["--palace", palace, "--backend", "sqlite_exact"] : [];
  const target: Target = { command: process.execPath, args: [STANDIN, "--record", record, ...given, ...args] };
  return { record, palace, target };
}

async function open(target: Target, kind: Kind = "own", onLost?: () => void): Promise<Palace> {
  const made = await connect(target, kind, { timeout: LIMIT, ...(onLost && { onLost }) });
  if (made.is !== "connected") throw new Error(`not connected: ${JSON.stringify(made)}`);
  palaces.push(made.palace);
  return made.palace;
}

const calls = (record: string) => readLog(record).flatMap((l) => (l.call ? [l.call] : []));

describe.each(["hub", "stdio"] as const)("the palace client, %s", (form) => {
  const start = (args: string[] = []) => (form === "hub" ? startHub(args) : startProgram(args, true));

  it("reports what the palace offers: everything, for a whole one", async () => {
    const s = await start();
    const palace = await open(s.target, "own");
    expect(palace.offers).toEqual({ missing: [], lookup: true, counts: true });
  });

  it("adds an entry with its room and label, and says when the same text is already there", async () => {
    const s = await start();
    const palace = await open(s.target);
    expect(await palace.add(ROOM, "tachikoma session one, turn 1", "the saver keeps turns", LIMIT)).toEqual({
      is: "added",
    });
    expect(await palace.add(ROOM, "tachikoma session two, turn 4", "the saver keeps turns", LIMIT)).toEqual({
      is: "already there",
    });
    expect(await palace.add(LESSONS, "a lesson", "the saver keeps turns", LIMIT)).toEqual({ is: "added" });
    const refused = await palace.add(ROOM, "too long", "x".repeat(100_001), LIMIT);
    expect(refused).toEqual({ is: "refused", reason: "content exceeds maximum length of 100000 characters" });
    const adds = calls(s.record).filter((c) => c.name === "mempalace_add_drawer");
    expect(adds).toHaveLength(4);
    for (const add of adds) {
      expect(add.arguments).toEqual({ wing: WING, room: expect.any(String), content: expect.any(String),
        source_file: expect.any(String) });
    }
    expect(adds[0].arguments).toMatchObject({ room: ROOM, source_file: "tachikoma session one, turn 1" });
  });

  it("counts an entry's pieces by its exact label, and removes it by that label", async () => {
    const s = await start();
    const palace = await open(s.target);
    await palace.add(ROOM, "tachikoma session one, turn 12", "y".repeat(2_016), LIMIT);
    await palace.add(ROOM, "tachikoma session one, turn 1", "short", LIMIT);
    expect(await palace.pieces("tachikoma session one, turn 12", LIMIT)).toEqual({ is: "counted", pieces: 3 });
    expect(await palace.pieces("tachikoma session one, turn", LIMIT)).toEqual({ is: "counted", pieces: 0 });
    expect(await palace.remove("tachikoma session one, turn 12", LIMIT)).toEqual({ is: "removed", pieces: 3 });
    expect(await palace.pieces("tachikoma session one, turn 12", LIMIT)).toEqual({ is: "counted", pieces: 0 });
    expect(await palace.pieces("tachikoma session one, turn 1", LIMIT)).toEqual({ is: "counted", pieces: 1 });
    const byLabel = calls(s.record).filter((c) => c.name === "mempalace_delete_by_source").map((c) => c.arguments);
    expect(byLabel).toEqual([
      { source_file: "tachikoma session one, turn 12", dry_run: true },
      { source_file: "tachikoma session one, turn", dry_run: true },
      { source_file: "tachikoma session one, turn 12", dry_run: false },
      { source_file: "tachikoma session one, turn 12", dry_run: true },
      { source_file: "tachikoma session one, turn 1", dry_run: true },
    ]);
  });

  it("counts a room's entries with list_drawers' total, not its pieces", async () => {
    const s = await start();
    const palace = await open(s.target);
    await palace.add(ROOM, "one", "z".repeat(2_016), LIMIT);
    await palace.add(ROOM, "two", "short", LIMIT);
    await palace.add(LESSONS, "three", "a lesson", LIMIT);
    expect(await palace.entries(ROOM, LIMIT)).toEqual({ is: "counted", entries: 2 });
    expect(await palace.entries(LESSONS, LIMIT)).toEqual({ is: "counted", entries: 1 });
    expect(await palace.entries("never-used", LIMIT)).toEqual({ is: "counted", entries: 0 });
    const counted = calls(s.record).filter((c) => c.name === "mempalace_list_drawers").map((c) => c.arguments);
    expect(counted[0]).toEqual({ wing: WING, room: ROOM, limit: 1 });
  });

  it("searches one room, the wing, or the whole palace, with the caller's limit", async () => {
    const s = await start();
    const palace = await open(s.target);
    await palace.add(ROOM, "p1", "red apple pie crust", LIMIT);
    await palace.add(LESSONS, "l1", "red apple pie", LIMIT);
    const room = await palace.search("red apple pie crust", { room: ROOM }, 7, LIMIT);
    expect(room).toEqual({
      is: "found",
      hits: [
        { text: "red apple pie crust", wing: WING, room: ROOM, label: "p1", distance: 0, date: expect.any(String) },
      ],
    });
    const wing = await palace.search("red apple pie crust", "wing", 7, LIMIT);
    expect(wing.is === "found" && wing.hits.map((h) => [h.room, h.distance])).toEqual([[ROOM, 0], [LESSONS, 0.25]]);
    const all = await palace.search("red apple pie crust", "palace", 7, LIMIT);
    expect(all.is === "found" && all.hits).toHaveLength(2);
    const searches = calls(s.record).filter((c) => c.name === "mempalace_search").map((c) => c.arguments);
    expect(searches).toEqual([
      { query: "red apple pie crust", limit: 7, wing: WING, room: ROOM },
      { query: "red apple pie crust", limit: 7, wing: WING },
      { query: "red apple pie crust", limit: 7 },
    ]);
  });

  it("cuts a query of 300 characters to its first 250, counted as MemPalace counts them", async () => {
    const s = await start();
    const palace = await open(s.target);
    const query = `${"a".repeat(249)}\u{1F600}${"b".repeat(50)}`;
    expect([...query]).toHaveLength(300);
    expect((await palace.search(query, { room: ROOM }, 5, LIMIT)).is).toBe("found");
    const [sent] = calls(s.record).filter((c) => c.name === "mempalace_search");
    expect(sent.arguments.query).toBe(`${"a".repeat(249)}\u{1F600}`);
  });

  it("searches two rooms with two calls at once, one per room, and merges them by distance", async () => {
    const s = await start();
    const palace = await open(s.target);
    await palace.add(ROOM, "p1", "red apple pie crust", LIMIT);
    await palace.add(ROOM, "p2", "green pear", LIMIT);
    await palace.add(LESSONS, "l1", "red apple pie", LIMIT);
    await palace.add(LESSONS, "l2", "apple", LIMIT);
    const found = await palace.searchTwo("red apple pie crust", [ROOM, LESSONS], 5, LIMIT);
    expect(found.is === "found" && found.hits.map((h) => [h.label, h.distance])).toEqual([
      ["p1", 0], ["l1", 0.25], ["l2", 0.75], ["p2", 1],
    ]);
    const searches = calls(s.record).filter((c) => c.name === "mempalace_search").map((c) => c.arguments);
    expect(searches.map((a) => a.room).sort()).toEqual([ROOM, LESSONS].sort());
    for (const a of searches) expect(typeof a.room).toBe("string");
  });

  it("gives one room's results alone when the other room's search passes the limit", async () => {
    const s = await start(["--hold-room", LESSONS]);
    const palace = await open(s.target);
    await palace.add(ROOM, "p1", "red apple", LIMIT);
    const found = await palace.searchTwo("red apple", [ROOM, LESSONS], 5, 500);
    expect(found).toEqual({ is: "found", hits: [expect.objectContaining({ label: "p1", room: ROOM })] });
  });

  // Sent one after the other, the two would take at least twice the limit.
  it("says it timed out when both rooms' searches pass the limit, both sent at once", async () => {
    const s = await start(["--hold-room", ROOM, "--hold-room", LESSONS]);
    const palace = await open(s.target);
    const began = performance.now();
    expect(await palace.searchTwo("red apple", [ROOM, LESSONS], 5, 1_500)).toEqual({ is: "timed out" });
    expect(performance.now() - began).toBeLessThan(3_000);
    expect(calls(s.record).filter((c) => c.name === "mempalace_search")).toHaveLength(2);
  });

  it("ends a slow answer at the time limit the caller gives", async () => {
    const s = await start(["--slow", "60000"]);
    const palace = await open(s.target);
    const began = performance.now();
    expect(await palace.search("anything", { room: ROOM }, 5, 300)).toEqual({ is: "timed out" });
    expect(await palace.add(ROOM, "label", "text", 300)).toEqual({ is: "timed out" });
    expect(performance.now() - began).toBeLessThan(LIMIT);
  });

  it("says why a write was refused", async () => {
    const s = await start(["--refuse-writes"]);
    const palace = await open(s.target);
    const refused = { is: "refused", reason: "the stand-in refuses writes" };
    expect(await palace.add(ROOM, "label", "text", LIMIT)).toEqual(refused);
    expect(await palace.remove("label", LIMIT)).toEqual(refused);
  });

  it("reads back the backend from the palace and the model from its file", async () => {
    const s = await start();
    const palace = await open(s.target);
    expect(await palace.inForce(s.palace, LIMIT)).toEqual({ is: "read", backend: "sqlite_exact" });
    await palace.add(ROOM, "label", "text", LIMIT);
    expect(await palace.inForce(s.palace, LIMIT)).toEqual({ is: "read", backend: "sqlite_exact", model: "minilm" });
  });

  it("reports a missing required tool by name", async () => {
    const s = await start(["--lack", "mempalace_delete_by_source", "--lack", "mempalace_status"]);
    const own = await open(s.target, "own");
    expect(own.offers.missing).toEqual(["mempalace_delete_by_source", "mempalace_status"]);
    const t = await start(["--lack", "mempalace_add_drawer"]);
    const use = await open(t.target, "use");
    expect(use.offers.missing).toEqual(["mempalace_add_drawer"]);
  });

  // The stand-in's own stop (step 22's "stop between two adds"): after its first add it answers nothing and changes
  // nothing until its gate exists.
  it("stops the stand-in between two adds until its gate exists", async () => {
    const gate = path.join(await folder(), "gate");
    const s = await start(["--stop-after", "mempalace_add_drawer=1", "--gate", gate]);
    const palace = await open(s.target);
    expect(await palace.add(ROOM, "part 1", "first part", LIMIT)).toEqual({ is: "added" });
    expect(await palace.add(ROOM, "part 2", "second part", 500)).toEqual({ is: "timed out" });
    expect(await palace.pieces("part 2", 500)).toEqual({ is: "timed out" });
    writeFileSync(gate, "");
    expect(await palace.pieces("part 2", LIMIT)).toEqual({ is: "counted", pieces: 0 });
    expect(await palace.add(ROOM, "part 2", "second part", LIMIT)).toEqual({ is: "added" });
    expect(await palace.entries(ROOM, LIMIT)).toEqual({ is: "counted", entries: 2 });
  });

  it("reports a palace with search and add only as lacking the look-up, the removal and the counts", async () => {
    const s = await start(["--lack", "mempalace_delete_by_source", "--lack", "mempalace_list_drawers"]);
    const palace = await open(s.target, "use");
    expect(palace.offers).toEqual({ missing: [], lookup: false, counts: false });
    expect(await palace.pieces("label", LIMIT)).toEqual({ is: "not offered" });
    expect(await palace.remove("label", LIMIT)).toEqual({ is: "not offered" });
    expect(await palace.entries(ROOM, LIMIT)).toEqual({ is: "not offered" });
    expect(await palace.add(ROOM, "label", "text", LIMIT)).toEqual({ is: "added" });
    expect(calls(s.record).map((c) => c.name)).toEqual(["mempalace_add_drawer"]);
  });
});

describe("the palace client, over stdio", () => {
  // A program that answers `initialize` late, then never lists its tools, and ignores its input's end. The connect and
  // the list share the one limit, and the caller does not wait for the library's close, which would take about 4 s
  // (2 s, SIGTERM, 2 s; @modelcontextprotocol/client/dist/stdio.mjs:193-198). The program stays in `running` until it
  // is gone, so it still dies with the window.
  it("answers a connect that passes its limit within that limit, without waiting for the program's close", async () => {
    const p = await startProgram(["--hang", String(HANG_START)]);
    const began = performance.now();
    expect(await connect(p.target, "use", { timeout: HANG_LIMIT })).toEqual({ is: "timed out" });
    expect(performance.now() - began).toBeLessThan(HANG_LIMIT + HANG_MARGIN);
    const [start] = readLog(p.record).filter((l) => l.start).map((l) => l.start);
    const child = [...running].find((c) => c.pid === start.pid);
    expect(child).toBeDefined();
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child!.kill("SIGKILL");
    await exited;
  });

  it("starts the program with the commands' environment, no key and no backend, model or palace; owns it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-not-real");
    vi.stubEnv("OPENAI_API_KEY", "sk-not-real");
    const p = await startProgram();
    const palace = await open(p.target, "use");
    const [start] = readLog(p.record).filter((l) => l.start).map((l) => l.start);
    const names = Object.keys(start.env).map((n) => n.toUpperCase());
    expect(names).not.toContain("ANTHROPIC_API_KEY");
    expect(names).not.toContain("OPENAI_API_KEY");
    expect(start.argv).toEqual(["--record", p.record]);
    const child = [...running].find((c) => c.pid === start.pid);
    expect(child).toBeDefined();
    await palace.close();
    expect(running.has(child!)).toBe(false);
  });

  it("marks the program lost when it exits, and says so to the next call", async () => {
    const p = await startProgram();
    let lost = 0;
    const palace = await open(p.target, "use", () => lost++);
    const [start] = readLog(p.record).filter((l) => l.start).map((l) => l.start);
    process.kill(start.pid, "SIGKILL");
    for (let waited = 0; !palace.lost && waited < LIMIT; waited += 20) await sleep(20);
    expect(palace.lost).toBe(true);
    expect(lost).toBe(1);
    expect(await palace.search("anything", { room: ROOM }, 5, LIMIT)).toEqual({ is: "lost" });
  });
});

describe("the palace client, against the hub", () => {
  it("does not take the library's event-stream report for a lost hub", async () => {
    const h = await startHub();
    let lost = 0;
    const palace = await open(h.target, "own", () => lost++);
    const streamAsked = () => readLog(h.record).some((l) => l.get === "/mcp");
    for (let waited = 0; !streamAsked() && waited < LIMIT; waited += 20) await sleep(20);
    expect(streamAsked()).toBe(true);
    expect((await palace.search("anything", { room: ROOM }, 5, LIMIT)).is).toBe("found");
    expect(palace.lost).toBe(false);
    expect(lost).toBe(0);
  });

  it("marks the hub lost when a call cannot reach it", async () => {
    const h = await startHub();
    let lost = 0;
    const palace = await open(h.target, "own", () => lost++);
    h.hub.kill("SIGKILL");
    await h.closed;
    expect(await palace.search("anything", { room: ROOM }, 5, LIMIT)).toEqual({ is: "lost" });
    expect(palace.lost).toBe(true);
    expect(lost).toBe(1);
  });

  it("says why it could not connect", async () => {
    const h = await startHub();
    h.hub.kill("SIGKILL");
    await h.closed;
    let lost = 0;
    const made = await connect(h.target, "own", { timeout: LIMIT, onLost: () => lost++ });
    expect(made.is).toBe("failed");
    expect(lost).toBe(0);
  });

  it("says a malformed hub address failed, without throwing", async () => {
    const made = await connect({ url: "not an address" }, "own", { timeout: LIMIT });
    expect(made).toEqual({ is: "failed", reason: expect.any(String) });
  });

  // node:sqlite's load failing (here, the shared loader replaced) gives no model, never an error.
  it("reads back no model when node:sqlite cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("../../src/memory/oslock.js", () => ({
      load: () => {
        throw new Error("no node:sqlite");
      },
    }));
    try {
      const fresh = await import("../../src/memory/client.js");
      const h = await startHub();
      const made = await fresh.connect(h.target, "own", { timeout: LIMIT });
      if (made.is !== "connected") throw new Error(`not connected: ${JSON.stringify(made)}`);
      palaces.push(made.palace);
      await made.palace.add(ROOM, "label", "text", LIMIT);
      expect(await made.palace.inForce(h.palace, LIMIT)).toEqual({ is: "read", backend: "sqlite_exact" });
    } finally {
      vi.doUnmock("../../src/memory/oslock.js");
      vi.resetModules();
    }
  });
});

// What the palace file holds, told apart (the user's choice at step 20's run 3): a refused status with no file is a
// palace not written yet, and with a file that cannot be opened a broken one.
describe("the palace file", () => {
  const meta = (file: string, model?: string) => {
    const db = new (load().DatabaseSync)(file);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    if (model) db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("embedder_model:mempalace_drawers", model);
    db.close();
  };

  it("holds no file in a palace folder that is missing or empty", async () => {
    const dir = await folder();
    expect(palaceFile(path.join(dir, "palace"))).toEqual({ holds: "no file" });
    expect(palaceFile(dir)).toEqual({ holds: "no file" });
  });

  it("holds a file but no model row before the model is recorded", async () => {
    const dir = await folder();
    meta(path.join(dir, "sqlite_exact.sqlite3"));
    expect(palaceFile(dir)).toEqual({ holds: "no model row" });
  });

  it("holds the model once it is recorded", async () => {
    const dir = await folder();
    meta(path.join(dir, "sqlite_exact.sqlite3"), "minilm");
    expect(palaceFile(dir)).toEqual({ holds: "model", model: "minilm" });
  });

  it("cannot be opened when the file is not a database", async () => {
    const dir = await folder();
    writeFileSync(path.join(dir, "sqlite_exact.sqlite3"), "not a database: broken on purpose\n");
    expect(palaceFile(dir)).toEqual({ holds: "can't open" });
  });

  it("cannot be opened when node:sqlite cannot be loaded", async () => {
    const dir = await folder();
    meta(path.join(dir, "sqlite_exact.sqlite3"), "minilm");
    vi.resetModules();
    vi.doMock("../../src/memory/oslock.js", () => ({
      load: () => {
        throw new Error("no node:sqlite");
      },
    }));
    try {
      const fresh = await import("../../src/memory/client.js");
      expect(fresh.palaceFile(dir)).toEqual({ holds: "can't open" });
    } finally {
      vi.doUnmock("../../src/memory/oslock.js");
      vi.resetModules();
    }
  });
});

describe("the stand-in hub", () => {
  it("writes serverinfo.json with its own process id, and answers the health check and the status", async () => {
    const h = await startHub();
    const key = createHash("sha256")
      .update(process.platform === "win32" ? h.palace.toLowerCase() : h.palace)
      .digest("hex")
      .slice(0, 24);
    const file = path.join(h.home, ".mempalace", "server", key, "serverinfo.json");
    expect(existsSync(file)).toBe(true);
    const info = JSON.parse(readFileSync(file, "utf8"));
    expect(info).toMatchObject({ pid: h.hub.pid, host: "127.0.0.1", port: h.port, palace_path: h.palace });
    expect((await fetch(`http://127.0.0.1:${h.port}/healthz`)).status).toBe(200);
    const status = await (await fetch(`http://127.0.0.1:${h.port}/statusz`)).json();
    expect(status).toMatchObject({ palace: { backend: "sqlite_exact" }, server: { version: "3.12.0" } });
  });

  it("exits with code 2 when a second copy is started for the same palace", async () => {
    const h = await startHub();
    const second = spawn(
      process.execPath,
      [STANDIN, "--transport", "http", "--port", "0", "--palace", h.palace, "--backend", "sqlite_exact"],
      {
        env: { ...process.env, USERPROFILE: h.home, HOME: h.home },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    hubs.push(second);
    expect(await new Promise((resolve) => second.on("close", resolve))).toBe(2);
  });
});
