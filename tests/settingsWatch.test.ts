import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type KeysLoaded, readKeybindings } from "../src/keybindings.js";
import { type Loaded, lastSaved, readSettings, settingsDir } from "../src/settings.js";
import { changes, watchSettings } from "../src/settingsWatch.js";

// Each folder watch the watcher starts, kept so a test can make one report an error; otherwise node:fs's own. With
// `refuse` set, the next watch throws it instead, as Linux's limit on watches would.
const watches = vi.hoisted(() => [] as FSWatcher[]);
const refuse = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const watch = (...args: Parameters<typeof fs.watch>) => {
    const err = refuse.next;
    refuse.next = null;
    if (err) throw err;
    return watches[watches.push(fs.watch(...args)) - 1];
  };
  return { ...fs, watch };
});

const temp = () => mkdtempSync(path.join(tmpdir(), "tachi-watch-"));
const fileOf = (home: string) => path.join(settingsDir(home), "settings.json");
const keysOf = (home: string) => path.join(settingsDir(home), "keybindings.json");
// What a keys file read gives, as the problems and the key Ctrl+T is, so two reads can be compared.
const ctrlT = (k: KeysLoaded | null | undefined) =>
  k && ("problem" in k ? k : { problems: k.problems, ctrlT: k.table.press({ key: "t", ctrl: true, alt: false, shift: false }, ["Chat", "Global"], 0) });
const MOVED = '{"bindings": [{"context": "Global", "bindings": {"ctrl+t": null}}]}';
// fs.watch reported each of 400 writes within 5 ms on this machine (measured 2026-10-28); 2 s is as long as
// app.test.tsx's until() waits (40 ticks of 50 ms), room for a busy machine.
const WATCHED = { timeout: 2_000 };

// Release 6 plan, Task 9: what the watcher makes of each text it reads, in order.
describe("changes", () => {
  const file = path.join(temp(), "settings.json");
  // The step, once it has read `start`.
  const from = (start: string | null) => {
    const step = changes(file, readSettings);
    step(start);
    return step;
  };

  // So an edit made before the watcher started, during the instruction files' question say, is not missed.
  it("calls back with the first text it reads, whatever it is", () => {
    expect(changes(file, readSettings)('{"mode": "ask"}')).toEqual({ settings: { mode: "ask" }, warnings: [] });
    expect(changes(file, readSettings)(null)).toEqual({ settings: {}, warnings: [] });
  });

  it("calls back only when the text differs from the last it read", () => {
    const step = from('{"mode": "ask"}');
    expect(step('{"mode": "ask"}')).toBeNull();
    expect(step('{"mode": "project"}')).toEqual({ settings: { mode: "project" }, warnings: [] });
    expect(step('{"mode": "project"}')).toBeNull();
  });

  // Choice 3: editors such as Notepad empty the file before writing it.
  it("skips an empty file, so an editor's empty write and then its full text are one change", () => {
    const step = from('{"mode": "ask"}');
    expect(step("")).toBeNull();
    expect(step('{"mode": "project"}')).toEqual({ settings: { mode: "project" }, warnings: [] });
  });

  // As the launch reads them (settings.ts, entriesOf): a byte-order mark alone, or only spaces and line breaks.
  it("skips every text the launch calls empty, not only one with no characters", () => {
    const step = from('{"mode": "ask"}');
    for (const text of [String.fromCharCode(0xfeff), " ", "\r\n", " \t\n "]) expect(step(text)).toBeNull();
    expect(step('{"mode": "project"}')).toEqual({ settings: { mode: "project" }, warnings: [] });
  });

  it("takes a removed file as {}", () => {
    const step = from('{"mode": "project"}');
    expect(step(null)).toEqual({ settings: {}, warnings: [] });
    expect(step(null)).toBeNull();
  });

  it("reports a broken file once per broken text, and again after good text", () => {
    const step = from("{}");
    const broken = step('{"mode": ');
    expect(broken && "problem" in broken && broken.problem).toMatch(/^settings\.json is not valid JSON: /);
    expect(step("")).toBeNull();
    expect(step('{"mode": ')).toBeNull(); // the same broken text again, after the editor's empty write
    expect(step('{"mode": "x"}')).toEqual({ problem: 'settings.json: "mode" must be one of: ask, project, never (got "x")' });
    expect(step('{"mode": "project"}')).toEqual({ settings: { mode: "project" }, warnings: [] });
    expect(step('{"mode": ')).toEqual(broken);
  });

  // saveSetting records the text it wrote (tests/settings.test.ts); set here, as a save would, so no folder is made
  // private.
  it("passes over Tachikoma's own last save once, so the same text written later by hand is a change", () => {
    const own = '{\n  "lead": "ollama:a"\n}\n';
    const step = from("{}");
    lastSaved.set(file, own);
    expect(step(own)).toBeNull();
    expect(lastSaved.has(file)).toBe(false);
    expect(step('{"lead": "ollama:b"}')).toEqual({ settings: { lead: "ollama:b" }, warnings: [] });
    expect(step(own)).toEqual({ settings: { lead: "ollama:a" }, warnings: [] });
  });

  // Release 6 plan, Task 11: the keys file follows the same rules, a removed one being {}, the default keys.
  it("takes a removed keys file as {}, the default keys, and skips an empty one", () => {
    const step = changes(path.join(path.dirname(file), "keybindings.json"), readKeybindings);
    expect(ctrlT(step(MOVED))).toEqual({ problems: [], ctrlT: null });
    expect(step("")).toBeNull();
    expect(ctrlT(step(null))).toEqual({ problems: [], ctrlT: { action: "app:toggleTodos" } });
  });
});

describe("watchSettings", () => {
  // Choice 16: on a first launch neither ~/.tachikoma nor the file is there yet.
  it("makes the folder, then calls back with a file written there, and with {} once it is removed", async () => {
    const home = temp();
    const seen: Loaded[] = [];
    const stop = watchSettings(
      home,
      (next) => seen.push(next),
      () => {},
      () => {},
    );
    onTestFinished(stop);
    expect(existsSync(settingsDir(home))).toBe(true);
    writeFileSync(fileOf(home), '{"maxTasks": 2}');
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ settings: { maxTasks: 2 }, warnings: [] }), WATCHED);
    unlinkSync(fileOf(home));
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ settings: {}, warnings: [] }), WATCHED);
  });

  it("calls back at once with the file as it is when watching starts", () => {
    const home = temp();
    mkdirSync(settingsDir(home));
    writeFileSync(fileOf(home), '{"maxTasks": 2}');
    const seen: Loaded[] = [];
    onTestFinished(
      watchSettings(
        home,
        (next) => seen.push(next),
        () => {},
        () => {},
      ),
    );
    expect(seen).toEqual([{ settings: { maxTasks: 2 }, warnings: [] }]);
  });

  // On Windows a watch on a removed folder reports the removal over and over until it is closed (settingsWatch.ts).
  it("applies {} and stops watching once the folder itself is removed", async () => {
    const home = temp();
    const seen: Loaded[] = [];
    let gone = 0;
    const stop = watchSettings(
      home,
      (next) => seen.push(next),
      () => {},
      () => gone++,
    );
    onTestFinished(stop);
    writeFileSync(fileOf(home), '{"maxTasks": 2}');
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ settings: { maxTasks: 2 }, warnings: [] }), WATCHED);
    rmSync(settingsDir(home), { recursive: true });
    await vi.waitFor(() => expect(gone).toBe(1), WATCHED);
    expect(seen.at(-1)).toEqual({ settings: {}, warnings: [] });
  });

  // Node's fs.watch docs: on Windows "an EPERM error is reported when the watched directory is deleted"; an error with
  // no listener would end the session.
  it("stops watching, once, when the folder watch reports an error", () => {
    const home = temp();
    let gone = 0;
    onTestFinished(
      watchSettings(
        home,
        () => {},
        () => {},
        () => gone++,
      ),
    );
    const watcher = watches.at(-1)!;
    const error = Object.assign(new Error("EPERM: operation not permitted, watch"), { code: "EPERM" });
    watcher.emit("error", error);
    watcher.emit("error", error);
    expect(gone).toBe(1);
  });

  it("closes the folder watch when the first read's callback throws, as the caller is left nothing to close", async () => {
    const home = temp();
    expect(() =>
      watchSettings(
        home,
        () => {
          throw new Error("no");
        },
        () => {},
        () => {},
      ),
    ).toThrow("no");
    // FSWatcher emits "close" on the next tick after close() (node:fs, FSWatcher.close); left open, the test times out.
    await new Promise((resolve) => watches.at(-1)!.once("close", resolve));
  });

  // Release 6 plan, Task 11: one folder, two files.
  it("calls back with the keys file at once, with each change to it, and with the default keys once it is removed", async () => {
    const home = temp();
    mkdirSync(settingsDir(home));
    writeFileSync(keysOf(home), MOVED);
    const settings: Loaded[] = [];
    const keys: KeysLoaded[] = [];
    const stop = watchSettings(
      home,
      (next) => settings.push(next),
      (next) => keys.push(next),
      () => {},
    );
    onTestFinished(stop);
    expect(keys.map(ctrlT)).toEqual([{ problems: [], ctrlT: null }]);
    writeFileSync(keysOf(home), "");
    writeFileSync(keysOf(home), '{"bindings": [{"context": "Global", "bindings": {"ctrl+t": null, "ctrl+c": null}}]}');
    await vi.waitFor(() => expect(keys).toHaveLength(2), WATCHED);
    expect(ctrlT(keys[1])).toEqual({ problems: ['keybindings.json: Global "ctrl+c" is a reserved key; it was left out'], ctrlT: null });
    unlinkSync(keysOf(home));
    await vi.waitFor(() => expect(ctrlT(keys.at(-1))).toEqual({ problems: [], ctrlT: { action: "app:toggleTodos" } }), WATCHED);
    expect(keys).toHaveLength(3); // no other callback, the settings file's events among them
    expect(settings).toEqual([{ settings: {}, warnings: [] }]); // the settings file, missing throughout, read once
  });

  // Linux's limit on watches, say: the files as they are still apply, unwatched (choice 21).
  it("reads both files once when the watch cannot start, then throws", () => {
    const home = temp();
    mkdirSync(settingsDir(home));
    writeFileSync(fileOf(home), '{"maxTasks": 2}');
    writeFileSync(keysOf(home), MOVED);
    const settings: Loaded[] = [];
    const keys: KeysLoaded[] = [];
    onTestFinished(() => {
      refuse.next = null;
    });
    refuse.next = new Error("ENOSPC: System limit for number of file watchers reached");
    expect(() =>
      watchSettings(
        home,
        (next) => settings.push(next),
        (next) => keys.push(next),
        () => {},
      ),
    ).toThrow("ENOSPC");
    expect(settings).toEqual([{ settings: { maxTasks: 2 }, warnings: [] }]);
    expect(keys.map(ctrlT)).toEqual([{ problems: [], ctrlT: null }]);
  });
});
