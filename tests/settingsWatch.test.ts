import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type KeysLoaded, readKeybindings } from "../src/keybindings.js";
import { type Loaded, readSettings, settingsDir } from "../src/settings.js";
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
  // The step, once it has read `start`.
  const from = (start: string) => {
    const step = changes(readSettings);
    step(start);
    return step;
  };

  // So an edit made before the watcher started, during the instruction files' question say, is not missed.
  it("calls back with the first text it reads, whatever it is", () => {
    expect(changes(readSettings)('{"mode": "ask"}')).toEqual({ settings: { mode: "ask" }, warnings: [] });
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

  it("reports a broken file once per broken text, and again after good text", () => {
    const step = from("{}");
    const broken = step('{"mode": ');
    expect(broken && "problem" in broken && broken.problem).toMatch(/^settings\.json is not valid JSON: /);
    expect(step("")).toBeNull();
    expect(step('{"mode": ')).toBeNull(); // the same broken text again, after the editor's empty write
    expect(step('{"mode": "x"}')).toEqual({ problem: 'settings.json: "mode" must be one of: ask, project (got "x")' });
    expect(step('{"mode": "project"}')).toEqual({ settings: { mode: "project" }, warnings: [] });
    expect(step('{"mode": ')).toEqual(broken);
  });

  // Release 6 plan, Task 11: the keys file follows the same rules.
  it("skips an empty keys file", () => {
    const step = changes(readKeybindings);
    expect(ctrlT(step(MOVED))).toEqual({ problems: [], ctrlT: null });
    expect(step("")).toBeNull();
    expect(ctrlT(step("{}"))).toEqual({ problems: [], ctrlT: { action: "app:toggleTodos" } });
  });
});

describe("watchSettings", () => {
  // Choice 16: on a first launch neither ~/.tachikoma nor the file is there yet.
  it("makes the folder, then calls back with a file written there", async () => {
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
  });

  // Choice 26, the user's: an editor that saves by renaming a new file over the old one leaves no file for a moment,
  // which is skipped, as an empty one is. Each event reads both files (settingsWatch.ts), so a change to the keys file,
  // once called back, shows the settings file was read as it then was.
  it("skips a missing settings file, so an editor's rename over it with the same text changes nothing", async () => {
    const home = temp();
    mkdirSync(settingsDir(home));
    writeFileSync(fileOf(home), '{"maxTasks": 2}');
    const seen: Loaded[] = [];
    const keys: KeysLoaded[] = [];
    const stop = watchSettings(
      home,
      (next) => seen.push(next),
      (next) => keys.push(next),
      () => {},
    );
    onTestFinished(stop);
    const read = async (change: () => void) => {
      const before = keys.length;
      change();
      writeFileSync(keysOf(home), keys.length % 2 ? "{}" : MOVED);
      await vi.waitFor(() => expect(keys.length).toBeGreaterThan(before), WATCHED);
    };
    await read(() => unlinkSync(fileOf(home)));
    await read(() => writeFileSync(fileOf(home), '{"maxTasks": 2}'));
    expect(seen).toEqual([{ settings: { maxTasks: 2 }, warnings: [] }]);
    writeFileSync(fileOf(home), '{"maxTasks": 3}');
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ settings: { maxTasks: 3 }, warnings: [] }), WATCHED);
    expect(seen).toHaveLength(2);
  });

  // Choice 26, the user's: the keys file the same way, so its problems are not said again at each such save. A change
  // to the settings file, once called back, shows the keys file was read as it then was.
  it("skips a missing keys file, so an editor's rename over it with the same text changes nothing", async () => {
    const home = temp();
    mkdirSync(settingsDir(home));
    writeFileSync(keysOf(home), MOVED);
    const seen: Loaded[] = [];
    const keys: KeysLoaded[] = [];
    const stop = watchSettings(
      home,
      (next) => seen.push(next),
      (next) => keys.push(next),
      () => {},
    );
    onTestFinished(stop);
    const read = async (change: () => void) => {
      const before = seen.length;
      change();
      writeFileSync(fileOf(home), `{"maxTasks": ${before + 1}}`);
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(before), WATCHED);
    };
    await read(() => unlinkSync(keysOf(home)));
    await read(() => writeFileSync(keysOf(home), MOVED));
    expect(keys.map(ctrlT)).toEqual([{ problems: [], ctrlT: null }]);
    writeFileSync(keysOf(home), "{}");
    await vi.waitFor(() => expect(keys.map(ctrlT).at(-1)).toEqual({ problems: [], ctrlT: { action: "app:toggleTodos" } }), WATCHED);
    expect(keys).toHaveLength(2);
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
  it("keeps the settings and the keys, as for removed files, and stops watching once the folder itself is removed", async () => {
    const home = temp();
    const seen: Loaded[] = [];
    const keys: KeysLoaded[] = [];
    let gone = 0;
    const stop = watchSettings(
      home,
      (next) => seen.push(next),
      (next) => keys.push(next),
      () => gone++,
    );
    onTestFinished(stop);
    writeFileSync(fileOf(home), '{"maxTasks": 2}');
    writeFileSync(keysOf(home), MOVED);
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ settings: { maxTasks: 2 }, warnings: [] }), WATCHED);
    await vi.waitFor(() => expect(keys.map(ctrlT)).toEqual([{ problems: [], ctrlT: null }]), WATCHED);
    rmSync(settingsDir(home), { recursive: true });
    await vi.waitFor(() => expect(gone).toBe(1), WATCHED);
    expect(seen).toEqual([{ settings: { maxTasks: 2 }, warnings: [] }]);
    expect(keys).toHaveLength(1);
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
    mkdirSync(settingsDir(home));
    writeFileSync(fileOf(home), "{}"); // a missing file is not called back (choice 26)
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
  it("calls back with the keys file at once, and with each change to it, but not once it is removed", async () => {
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
    expect(settings).toEqual([]); // the settings file, missing so far, skipped (choice 26)
    unlinkSync(keysOf(home));
    writeFileSync(fileOf(home), '{"maxTasks": 2}');
    await vi.waitFor(() => expect(settings).toHaveLength(1), WATCHED); // read with the keys file missing
    expect(keys).toHaveLength(2); // no other callback, the settings file's events among them
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
