import { type ChildProcessByStdio, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../../src/core/bus.js";
import { connect, type Kind, type Palace } from "../../src/memory/client.js";
import { WING } from "../../src/memory/paths.js";
import { entriesOf, LONGEST_ENTRY, Saver, type Turn } from "../../src/memory/saver.js";
import { readLog } from "../mcp/fake.js";
import { removeTree } from "../helpers.js";

// The saver of turns (8d plan, step 22) against the stand-in MemPalace (tests/memory/standin.mjs) as the hub, with a
// second saver in a process of its own (tests/memory/saver-child.ts) where a test needs two windows. Nothing here
// starts a real hub or touches a real palace; every process gets its home, AppData, PATH and Temp in a folder the test
// made.

const STANDIN = path.resolve("tests/memory/standin.mjs");
const CHILD = path.resolve("tests/memory/saver-child.ts");
// The tests' own limit for a request that should answer, long enough never to be reached by one that does; and a
// short one, for a request the stand-in holds, so that it passes.
const LIMIT = 10_000;
const SHORT = 1_000;
const ROOM = "agent-harness-3f9a1c2b";
const never = () => new AbortController().signal;

type Proc = ChildProcessByStdio<null, Readable, Readable>;
const procs: Proc[] = [];
const palaces: Palace[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(palaces.splice(0).map((p) => p.close()));
  await Promise.all(
    procs.splice(0).map(async (p) => {
      if (p.exitCode !== null || p.signalCode !== null) return;
      const closed = new Promise((resolve) => p.on("close", resolve));
      p.kill("SIGKILL");
      await closed;
    }),
  );
  for (const folder of folders.splice(0)) await removeTree(folder);
});

async function folder(): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), "tachi-saver-"));
  folders.push(made);
  return made;
}

// A process's environment: its home, the AppData folders, an empty PATH folder and Temp all in the folder `dir` the
// test made, PATH replaced in every spelling (Windows' is `Path`), as tests/memory/client.test.ts builds its own.
function ownEnv(dir: string, more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  const temp = path.join(dir, "tmp");
  mkdirSync(bin, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const kept = Object.entries(process.env).filter(([name]) => !["PATH", "TEMP", "TMP"].includes(name.toUpperCase()));
  return {
    ...Object.fromEntries(kept),
    PATH: bin,
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: temp,
    TMP: temp,
    ...more,
  };
}

// The lines a process prints, one at a time.
function lines(p: Proc) {
  const got: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let rest = "";
  let errors = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d: string) => {
    rest += d;
    for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
      const line = rest.slice(0, at).replace(/\r$/, "");
      rest = rest.slice(at + 1);
      const wake = waiting.shift();
      if (wake) wake(line);
      else got.push(line);
    }
  });
  p.stderr.on("data", (d) => (errors += d));
  const closed = new Promise<number | null>((resolve) => p.on("close", resolve));
  return {
    closed,
    next: () =>
      got.length
        ? Promise.resolve(got.shift()!)
        : new Promise<string>((resolve, reject) => {
            waiting.push(resolve);
            void closed.then((code) => reject(new Error(`exited ${code}; stderr: ${errors}`)));
          }),
  };
}

// The stand-in started as the hub, recording every call; the tests' own saved records go into the same file, so the
// order of calls and records is the order in that file. `lock` is the save lock's folder for the savers of this hub.
async function startHub(args: string[] = []) {
  const dir = await folder();
  const record = path.join(dir, "record.jsonl");
  const gate = path.join(dir, "gate");
  const lock = path.join(dir, "locks");
  const hub = spawn(
    process.execPath,
    [STANDIN, "--transport", "http", "--port", "0", "--palace", path.join(dir, "palace"), "--backend", "sqlite_exact",
      "--record", record, ...args],
    { env: ownEnv(dir, { MEMPALACE_EMBEDDING_MODEL: "minilm" }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  procs.push(hub);
  const out = lines(hub);
  const port = JSON.parse(await out.next()).port as number;
  const url = `http://127.0.0.1:${port}/mcp`;
  return { dir, hub, closed: out.closed, url, record, gate, lock, open: () => open(url) };
}

async function open(url: string, kind: Kind = "own"): Promise<Palace> {
  const made = await connect({ url }, kind, { timeout: LIMIT });
  if (made.is !== "connected") throw new Error(`not connected: ${JSON.stringify(made)}`);
  palaces.push(made.palace);
  return made.palace;
}

// What the hub was sent, and the records written, in order: a look-up (the removal's dry run), a removal, an add, and a
// saved record, each with its label.
type Step = { is: "look-up" | "removal" | "add" | "saved"; label: string; by?: string };
const steps = (record: string): Step[] =>
  readLog(record).flatMap((l): Step[] => {
    if (l.saved) return [{ is: "saved", label: l.saved, by: l.by }];
    const c = l.call;
    if (c?.name === "mempalace_delete_by_source") {
      return [{ is: c.arguments.dry_run === false ? "removal" : "look-up", label: c.arguments.source_file }];
    }
    if (c?.name === "mempalace_add_drawer") return [{ is: "add", label: c.arguments.source_file }];
    return [];
  });
const adds = (record: string) =>
  readLog(record).flatMap((l) => (l.call?.name === "mempalace_add_drawer" ? [l.call] : []));

const label = (n: number, session = "s1") => `tachikoma session ${session}, turn ${n}`;
const part = (n: number, k: number, m: number) => `${label(n)}, part ${k} of ${m}`;

// A turn handed to the saver, its saved record added to the hub's record file.
function turnOf(record: string, n: number, typed: string, texts: string[], session = "s1") {
  const saved: number[] = [];
  const turn: Turn = {
    session,
    n,
    typed,
    texts,
    record: () => {
      saved.push(n);
      appendFileSync(record, `${JSON.stringify({ saved: label(n, session), by: "test" })}\n`);
    },
  };
  return { turn, saved };
}

function saverOf(hub: { lock: string }, palace: Palace | undefined, more: { timeout?: number; bus?: Bus } = {}) {
  const memory: { palace: Palace | undefined } = { palace };
  const saver = new Saver({ memory, room: ROOM, folder: hub.lock, timeout: more.timeout ?? LIMIT, ...(more.bus && {
    bus: more.bus }) });
  return { saver, memory };
}

// Waits for `check`, up to the tests' limit.
async function until(check: () => boolean, what: string): Promise<void> {
  const began = performance.now();
  while (!check()) {
    if (performance.now() - began > LIMIT) throw new Error(`waited too long for ${what}`);
    await sleep(20);
  }
}

// A second saver in a process of its own, as another window's, given the same turn. `probe`: it first tries the save
// lock once and prints "busy" or "free".
async function child(hub: { dir: string; url: string; lock: string; record: string }, turn: object, probe = false) {
  const file = path.join(await folder(), "turn.json");
  writeFileSync(file, JSON.stringify({ ...turn, room: ROOM }));
  const args = ["--import", "tsx", CHILD, hub.url, hub.lock, file, hub.record, ...(probe ? ["probe"] : [])];
  const p = spawn(process.execPath, args, { env: ownEnv(await folder()), stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true });
  procs.push(p);
  return { p, ...lines(p) };
}

const text = (length: number, seed = "a") => {
  let s = "";
  for (let i = 0; s.length < length; i++) s += `${seed}${i} `;
  return s.slice(0, length);
};

describe("the saver", () => {
  it("saves a turn as one entry under its label in the project's room, its typed words and model text", async () => {
    const hub = await startHub();
    const { saver } = saverOf(hub, await hub.open());
    const { turn, saved } = turnOf(hub.record, 3, "fix the [Image #1] bug", ["Looking.", "Fixed it."]);
    saver.hand(turn);
    expect(saver.unsaved).toBe(1);
    await saver.run(never());
    expect(saved).toEqual([3]);
    expect(saver.unsaved).toBe(0);
    expect(steps(hub.record)).toEqual([
      { is: "look-up", label: label(3) },
      { is: "add", label: label(3) },
      { is: "saved", label: label(3), by: "test" },
    ]);
    expect(adds(hub.record)).toEqual([{ name: "mempalace_add_drawer", arguments: { wing: WING, room: ROOM,
      content: "fix the [Image #1] bug\n\nLooking.\n\nFixed it.", source_file: label(3) } }]);
  });

  it("sends every add with its label as source_file", async () => {
    const hub = await startHub();
    const { saver } = saverOf(hub, await hub.open());
    saver.hand(turnOf(hub.record, 1, "one", ["first"]).turn);
    saver.hand(turnOf(hub.record, 2, "two", [text(LONGEST_ENTRY + 10)]).turn);
    await saver.run(never());
    const sent = adds(hub.record);
    expect(sent).toHaveLength(3);
    for (const a of sent) {
      expect(a.arguments.source_file).toEqual(expect.stringMatching(/^tachikoma session s1, turn \d/));
    }
  });

  it("adds nothing for a turn already whole in the palace, as after a crash between add and record", async () => {
    const hub = await startHub();
    const palace = await hub.open();
    const { turn, saved } = turnOf(hub.record, 1, "go", [text(900)]);
    expect(await palace.add(ROOM, label(1), `go\n\n${text(900)}`, LIMIT)).toEqual({ is: "added" });
    const { saver } = saverOf(hub, palace);
    saver.hand(turn);
    await saver.run(never());
    expect(saved).toEqual([1]);
    expect(steps(hub.record)).toEqual([
      { is: "add", label: label(1) }, // the test's own, before the saver
      { is: "look-up", label: label(1) },
      { is: "saved", label: label(1), by: "test" },
    ]);
  });

  it("removes a half-saved turn by its label and adds it again", async () => {
    const hub = await startHub();
    const palace = await hub.open();
    await palace.add(ROOM, label(1), "a piece of it", LIMIT);
    const { saver } = saverOf(hub, palace);
    const { turn, saved } = turnOf(hub.record, 1, "go", [text(900)]);
    saver.hand(turn);
    await saver.run(never());
    expect(saved).toEqual([1]);
    expect(steps(hub.record).slice(1)).toEqual([
      { is: "look-up", label: label(1) },
      { is: "removal", label: label(1) },
      { is: "add", label: label(1) },
      { is: "saved", label: label(1), by: "test" },
    ]);
    expect(await palace.pieces(label(1), LIMIT)).toEqual({ is: "counted", pieces: 2 });
    expect(await palace.entries(ROOM, LIMIT)).toEqual({ is: "counted", entries: 1 });
  });

  it("keeps a turn unsaved while the hub is down, and saves it once memory is on again", async () => {
    const first = await startHub();
    const bus = new Bus();
    const { saver, memory } = saverOf(first, await first.open(), { bus });
    first.hub.kill("SIGKILL");
    await first.closed;
    const { turn, saved } = turnOf(first.record, 1, "go", ["an answer"]);
    saver.hand(turn);
    await saver.run(never());
    expect([saver.unsaved, saved]).toEqual([1, []]);
    // Another hub answers, and memory says it is on.
    const second = await startHub();
    memory.palace = await second.open();
    bus.emit("memory", { is: "on" });
    await until(() => saver.unsaved === 0, "the turn to be saved");
    expect(saved).toEqual([1]);
    expect(steps(second.record).map((s) => s.is)).toEqual(["look-up", "add"]);
  });

  // Step 6 item 9, and the step 14 record: a turn repeated word for word is stored once, under the first one's label.
  it("records a turn whose text is an earlier turn's, word for word, as saved, and does not try it again", async () => {
    const hub = await startHub();
    const palace = await hub.open();
    const { saver } = saverOf(hub, palace);
    const one = turnOf(hub.record, 1, "status?", ["All green."]);
    const two = turnOf(hub.record, 2, "status?", ["All green."]);
    saver.hand(one.turn);
    saver.hand(two.turn);
    await saver.run(never());
    expect([one.saved, two.saved, saver.unsaved]).toEqual([[1], [2], 0]);
    const before = readLog(hub.record).length;
    saver.send();
    await saver.run(never());
    expect(readLog(hub.record)).toHaveLength(before);
    expect(await palace.entries(ROOM, LIMIT)).toEqual({ is: "counted", entries: 1 });
  });

  it("leaves a turn the palace refuses unsaved, and does not try it again in this run", async () => {
    const hub = await startHub(["--refuse-writes"]);
    const { saver } = saverOf(hub, await hub.open());
    const one = turnOf(hub.record, 1, "go", ["refused"]);
    saver.hand(one.turn);
    await saver.run(never());
    const two = turnOf(hub.record, 2, "again", ["refused too"]);
    saver.hand(two.turn);
    await saver.run(never());
    saver.send();
    await saver.run(never());
    expect([one.saved, two.saved, saver.unsaved]).toEqual([[], [], 2]);
    expect(adds(hub.record).map((a) => a.arguments.source_file)).toEqual([label(1), label(2)]);
  });

  it("gives up at the final save's limit, unbound, with the turn still unsaved", async () => {
    const hub = await startHub(["--slow", String(LIMIT)]);
    const palace = await hub.open();
    const { saver } = saverOf(hub, palace);
    const { turn, saved } = turnOf(hub.record, 1, "go", ["an answer"]);
    saver.hand(turn);
    const limit = new AbortController();
    const run = saver.run; // as closing calls it (src/memory/memory.ts)
    const done = run(limit.signal);
    await until(() => steps(hub.record).length === 1, "the look-up to be sent");
    limit.abort();
    await done;
    expect([saver.unsaved, saved]).toEqual([1, []]);
  });
});

describe("the saver, a long turn in parts", () => {
  it("saves a turn of exactly 100,000 characters as one entry under the bare label", async () => {
    const entries = entriesOf({ session: "s1", n: 1, typed: "t", texts: [text(LONGEST_ENTRY - 3)] });
    expect(entries.map((e) => [e.label, e.text.length])).toEqual([[label(1), LONGEST_ENTRY]]);
    const hub = await startHub();
    const { saver } = saverOf(hub, await hub.open());
    saver.hand(turnOf(hub.record, 1, "t", [text(LONGEST_ENTRY - 3)]).turn);
    await saver.run(never());
    expect(adds(hub.record).map((a) => a.arguments.source_file)).toEqual([label(1)]);
  });

  it("saves one of 100,001 as part 1 of 2 and part 2 of 2, neither over 100,000, none under the bare one", async () => {
    const texts = [text(LONGEST_ENTRY - 2)];
    const entries = entriesOf({ session: "s1", n: 1, typed: "t", texts });
    expect(entries.map((e) => [e.label, e.text.length])).toEqual([[part(1, 1, 2), LONGEST_ENTRY], [part(1, 2, 2), 1]]);
    const hub = await startHub();
    const palace = await hub.open();
    const { saver } = saverOf(hub, palace);
    saver.hand(turnOf(hub.record, 1, "t", texts).turn);
    await saver.run(never());
    expect(adds(hub.record).map((a) => [a.arguments.source_file, a.arguments.content.length])).toEqual([
      [part(1, 1, 2), LONGEST_ENTRY],
      [part(1, 2, 2), 1],
    ]);
    expect(await palace.pieces(label(1), LIMIT)).toEqual({ is: "counted", pieces: 0 });
  });

  it("cuts so that the parts, joined in order, are the turn's text letter for letter", () => {
    const typed = "the words";
    const texts = [text(120_000, "x"), text(130_001, "y")];
    const entries = entriesOf({ session: "s1", n: 4, typed, texts });
    expect(entries.map((e) => e.text).join("")).toBe([typed, ...texts].join("\n\n"));
    // 9 + 2 + 120,000 + 2 + 130,001 characters.
    expect(entries.map((e) => e.text.length)).toEqual([LONGEST_ENTRY, LONGEST_ENTRY, 50_014]);
    expect(entries.map((e) => e.label)).toEqual([part(4, 1, 3), part(4, 2, 3), part(4, 3, 3)]);
  });

  it("cuts before an emoji lying across the 100,000th place, the emoji whole in the next part", () => {
    const typed = "t";
    // "t\n\n" is 3 characters, so the emoji's two halves are the 100,000th and 100,001st.
    const texts = [`${text(LONGEST_ENTRY - 4)}\u{1F600} and on`];
    const entries = entriesOf({ session: "s1", n: 1, typed, texts });
    expect(entries.map((e) => e.text.length)).toEqual([LONGEST_ENTRY - 1, 9]);
    expect(entries[1]!.text.startsWith("\u{1F600}")).toBe(true);
    expect(entries.map((e) => e.text).join("")).toBe(`t\n\n${texts[0]}`);
  });

  it("asks each part for its own count of pieces, 125 for a full part, and leaves whole parts alone", async () => {
    const texts = [text(2 * LONGEST_ENTRY)];
    const entries = entriesOf({ session: "s1", n: 1, typed: "t", texts });
    expect(entries.map((e) => e.pieces)).toEqual([125, 125, 1]);
    const hub = await startHub();
    const palace = await hub.open();
    for (const e of entries) await palace.add(ROOM, e.label, e.text, LIMIT);
    const { saver } = saverOf(hub, palace);
    const { turn, saved } = turnOf(hub.record, 1, "t", texts);
    saver.hand(turn);
    await saver.run(never());
    expect(saved).toEqual([1]);
    expect(steps(hub.record).slice(3)).toEqual([
      ...entries.map((e) => ({ is: "look-up", label: e.label })),
      { is: "saved", label: label(1), by: "test" },
    ]);
  });

  // The stand-in stops after the nth add (step 18's --stop-after): later requests are held, unanswered and changing
  // nothing, until the gate file is made, and are answered again after it.
  const cutOff = async (adds: number) => {
    const dir = await folder();
    const gate = path.join(dir, "gate");
    const hub = await startHub(["--stop-after", `mempalace_add_drawer=${adds}`, "--gate", gate]);
    const texts = [text(2 * LONGEST_ENTRY + 100)];
    const { saver } = saverOf(hub, await hub.open(), { timeout: SHORT });
    const { turn, saved } = turnOf(hub.record, 1, "t", texts);
    saver.hand(turn);
    await saver.run(never());
    return { hub, saver, saved, open: () => writeFileSync(gate, "") };
  };

  it("finishes a three-part turn cut off after its first add: parts 2 and 3 added, then one record", async () => {
    const { hub, saver, saved, open } = await cutOff(1);
    expect([saver.unsaved, saved]).toEqual([1, []]);
    // The look-up and add of part 1, then the look-up of part 2, held.
    const before = steps(hub.record);
    expect(before).toEqual([
      { is: "look-up", label: part(1, 1, 3) },
      { is: "add", label: part(1, 1, 3) },
      { is: "look-up", label: part(1, 2, 3) },
    ]);
    open();
    saver.send();
    await saver.run(never());
    expect(saved).toEqual([1]);
    expect(steps(hub.record).slice(before.length)).toEqual([
      { is: "look-up", label: part(1, 1, 3) },
      { is: "look-up", label: part(1, 2, 3) },
      { is: "add", label: part(1, 2, 3) },
      { is: "look-up", label: part(1, 3, 3) },
      { is: "add", label: part(1, 3, 3) },
      { is: "saved", label: label(1), by: "test" },
    ]);
  });

  it("counts a three-part turn with two parts in as one unsaved turn, and none once the third is in", async () => {
    const { saver, saved, open } = await cutOff(2);
    expect([saver.unsaved, saved]).toEqual([1, []]);
    open();
    saver.send();
    await saver.run(never());
    expect([saver.unsaved, saved]).toEqual([0, [1]]);
  });

  it("removes and adds again only the part found with the wrong count of pieces", async () => {
    const texts = [text(2 * LONGEST_ENTRY + 100)];
    const entries = entriesOf({ session: "s1", n: 1, typed: "t", texts });
    const hub = await startHub();
    const palace = await hub.open();
    await palace.add(ROOM, entries[0]!.label, entries[0]!.text, LIMIT);
    await palace.add(ROOM, entries[1]!.label, "a piece of part 2", LIMIT);
    await palace.add(ROOM, entries[2]!.label, entries[2]!.text, LIMIT);
    const { saver } = saverOf(hub, palace);
    const { turn, saved } = turnOf(hub.record, 1, "t", texts);
    saver.hand(turn);
    await saver.run(never());
    expect(saved).toEqual([1]);
    expect(steps(hub.record).slice(3)).toEqual([
      { is: "look-up", label: part(1, 1, 3) },
      { is: "look-up", label: part(1, 2, 3) },
      { is: "removal", label: part(1, 2, 3) },
      { is: "add", label: part(1, 2, 3) },
      { is: "look-up", label: part(1, 3, 3) },
      { is: "saved", label: label(1), by: "test" },
    ]);
  });

  it("records a turn whose two parts are the same text, the second answered already_exists", async () => {
    // "t\n\n" and 99,997 more characters, twice: both parts read the same.
    const half = text(LONGEST_ENTRY - 3, "z");
    const texts = [`${half}t`, half];
    const entries = entriesOf({ session: "s1", n: 1, typed: "t", texts });
    expect(entries[0]!.text).toBe(entries[1]!.text);
    const hub = await startHub();
    const palace = await hub.open();
    const { saver } = saverOf(hub, palace);
    const { turn, saved } = turnOf(hub.record, 1, "t", texts);
    saver.hand(turn);
    await saver.run(never());
    expect([saved, saver.unsaved]).toEqual([[1], 0]);
    expect(await palace.entries(ROOM, LIMIT)).toEqual({ is: "counted", entries: 1 });
  });
});

describe("the saver, two windows", { timeout: 30_000 }, () => {
  it("sends nothing for a turn while another window's saver holds it between parts, then adds nothing", async () => {
    const dir = await folder();
    const gate = path.join(dir, "gate");
    const hub = await startHub(["--pause-after", "mempalace_add_drawer=1", "--gate", gate]);
    const texts = [text(2 * LONGEST_ENTRY + 100)];
    const { saver } = saverOf(hub, await hub.open());
    const { turn, saved } = turnOf(hub.record, 1, "t", texts);
    saver.hand(turn);
    const first = saver.run(never());
    // Part 1 is in; the look-up of part 2 waits for the gate.
    await until(() => steps(hub.record).length === 3, "the first saver to be between parts");
    const other = await child(hub, { session: "s1", n: 1, typed: "t", texts }, true);
    expect(await other.next()).toBe("busy");
    // Three of the other's tries for the save lock, at the lock retry (M3), with nothing sent meanwhile.
    await sleep(1_500);
    expect(steps(hub.record)).toHaveLength(3);
    writeFileSync(gate, "");
    await first;
    expect(saved).toEqual([1]);
    expect(await other.next()).toBe("done 0");
    const all = steps(hub.record);
    const mine = all.findIndex((s) => s.is === "saved");
    expect(all.slice(0, mine).filter((s) => s.is === "add").map((s) => s.label)).toEqual([1, 2, 3].map((k) =>
      part(1, k, 3)));
    // The other window's, once the first let go: three look-ups and its record, no add and no removal.
    expect(all.slice(mine + 1).map((s) => s.is)).toEqual(["look-up", "look-up", "look-up", "saved"]);
  });

  it("leaves one whole entry when two windows save the same half-saved turn at once, recorded only once whole",
    async () => {
      const hub = await startHub();
      const palace = await hub.open();
      await palace.add(ROOM, label(1), "a piece of it", LIMIT);
      const given = { session: "s1", n: 1, typed: "go", texts: [text(1_700)] };
      const two = [await child(hub, given), await child(hub, given)];
      expect(await Promise.all(two.map((c) => c.next()))).toEqual(["done 0", "done 0"]);
      const all = steps(hub.record).slice(1);
      const first = all.findIndex((s) => s.is === "saved");
      expect(all.slice(0, first).map((s) => s.is)).toEqual(["look-up", "removal", "add"]);
      expect(all.slice(first + 1).map((s) => s.is)).toEqual(["look-up", "saved"]);
      expect(await palace.pieces(label(1), LIMIT)).toEqual({ is: "counted", pieces: 3 });
      expect(await palace.entries(ROOM, LIMIT)).toEqual({ is: "counted", entries: 1 });
    });

  it("adds a turn whole after the first window's saver dies between its removal and add, then records it", async () => {
    const dir = await folder();
    const gate = path.join(dir, "gate");
    // The look-up and the removal are answered; the add after them is held.
    const hub = await startHub(["--stop-after", "mempalace_delete_by_source=2", "--gate", gate]);
    const palace = await hub.open();
    await palace.add(ROOM, label(1), "a piece of it", LIMIT);
    const given = { session: "s1", n: 1, typed: "go", texts: [text(1_700)] };
    const first = await child(hub, given);
    await until(() => steps(hub.record).length === 4, "the first saver's add after its removal");
    first.p.kill("SIGKILL");
    await first.closed;
    writeFileSync(gate, "");
    const { saver } = saverOf(hub, palace);
    const { turn, saved } = turnOf(hub.record, 1, given.typed, given.texts);
    saver.hand(turn);
    await saver.run(never());
    expect(saved).toEqual([1]);
    expect(steps(hub.record).slice(1)).toEqual([
      { is: "look-up", label: label(1) },
      { is: "removal", label: label(1) },
      { is: "add", label: label(1) }, // held, and never applied
      { is: "look-up", label: label(1) },
      { is: "add", label: label(1) },
      { is: "saved", label: label(1), by: "test" },
    ]);
    expect(await palace.pieces(label(1), LIMIT)).toEqual({ is: "counted", pieces: 3 });
  });
});

// The user's own older MemPalace may have no exact-label look-up (the plan's table "What each palace must offer").
describe("the saver, a palace without exact-label look-up", () => {
  it("adds a turn once and records it, sending no look-up or removal", async () => {
    const hub = await startHub(["--lack", "mempalace_delete_by_source"]);
    const { saver } = saverOf(hub, await open(hub.url, "use"));
    const { turn, saved } = turnOf(hub.record, 1, "go", ["an answer"]);
    saver.hand(turn);
    await saver.run(never());
    expect(saved).toEqual([1]);
    expect(steps(hub.record)).toEqual([{ is: "add", label: label(1) }, { is: "saved", label: label(1), by: "test" }]);
  });

  it("adds a long turn's parts once each, in order, then records it", async () => {
    const hub = await startHub(["--lack", "mempalace_delete_by_source"]);
    const { saver } = saverOf(hub, await open(hub.url, "use"));
    const { turn, saved } = turnOf(hub.record, 1, "t", [text(LONGEST_ENTRY + 10)]);
    saver.hand(turn);
    await saver.run(never());
    expect(saved).toEqual([1]);
    expect(steps(hub.record)).toEqual([
      { is: "add", label: part(1, 1, 2) },
      { is: "add", label: part(1, 2, 2) },
      { is: "saved", label: label(1), by: "test" },
    ]);
  });
});
