import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateDir } from "../../src/auth/private.js";
import { projectFile } from "../../src/core/datadir.js";
import { copySession, findSession, listSessions, openSession, sessionPaths, sessionsDir, sweep } from "../../src/core/sessions.js";
import { type Line, readTranscript, Transcript } from "../../src/core/transcript.js";
import type { Message } from "../../src/core/types.js";
import { removeTree } from "../helpers.js";

// Release 8a plan, Task 4. Everything is inside one fresh temporary folder, as privateDir needs (plan, "Rules for every
// task"). Only the copies go through privateDir, which starts PowerShell on Windows, so they share one sessions folder
// made private once; the other cases write their files by hand into folders of their own, as nothing they call makes a
// folder private.
describe("sessions", { timeout: 15_000 }, () => {
  let top: string;
  let data: string;
  let shared: string;
  let folders = 0;
  beforeAll(async () => {
    top = await mkdtemp(path.join(tmpdir(), "tachi-sessions-"));
    data = path.join(top, "data", "tachikoma");
    shared = sessionsDir(top, data);
    privateDir(shared);
  });
  afterAll(() => removeTree(top));
  // A plain folder of its own for one case, standing for one project's sessions folder.
  const folder = () => {
    const dir = path.join(top, "plain", `p${++folders}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const DAY = 24 * 60 * 60 * 1000;
  const startLine = (id: string, print = false): Omit<Extract<Line, { t: "start" }>, "at"> => ({
    t: "start",
    v: 1,
    id,
    project: "C:\\a project",
    lead: "fake:a",
    version: "0.8.0",
    print,
    system: "Be brief.",
    tools: [],
  });
  const prompt = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });
  const said = (text: string): Message => ({ role: "assistant", parts: [{ type: "text", text }] });
  const at = "2026-11-06T00:00:00.000Z";
  // A session's file as a Transcript writes it, last changed `changed`.
  const session = (dir: string, id: string, o: { print?: boolean; prompt?: string; names?: string[]; changed?: Date } = {}) => {
    const lines: object[] = [{ ...startLine(id, o.print), at }];
    if (o.prompt !== undefined) lines.push({ t: "message", at, message: prompt(o.prompt) }, { t: "message", at, message: said("Done.") });
    for (const name of o.names ?? []) lines.push({ t: "name", at, name });
    const file = path.join(dir, `${id}.jsonl`);
    writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    if (o.changed) utimesSync(file, o.changed, o.changed);
    return file;
  };
  const read = (file: string, pictures: string) => {
    const r = readTranscript(file, pictures);
    if ("problem" in r) throw new Error(r.problem);
    return r;
  };

  it("is the data folder's sessions folder, named as the project's error log is", () => {
    expect(sessionsDir(top, data)).toBe(projectFile("sessions", top, data).replace(/\.jsonl$/, ""));
    expect(path.dirname(sessionsDir(top, data))).toBe(path.join(data, "sessions"));
  });

  describe("the list", () => {
    it("is newest first, and leaves out -p sessions unless asked for them and sessions without messages", () => {
      const dir = folder();
      const now = Date.now();
      session(dir, "old", { prompt: "first", changed: new Date(now - 3 * DAY) });
      session(dir, "new", { prompt: "third", changed: new Date(now - DAY) });
      session(dir, "mid", { prompt: "second", changed: new Date(now - 2 * DAY) });
      session(dir, "printed", { prompt: "from -p", print: true, changed: new Date(now) });
      session(dir, "empty", { changed: new Date(now) });
      expect(listSessions(dir, { print: false }).map((r) => r.id)).toEqual(["new", "mid", "old"]);
      expect(listSessions(dir, { print: true }).map((r) => r.id)).toEqual(["printed", "new", "mid", "old"]);
    });

    it("shows each session's last name, first prompt, lead, size and last change", () => {
      const dir = folder();
      const changed = new Date(Date.now() - DAY);
      const file = session(dir, "s1", { prompt: "fix the build", names: ["first name", "build fix"], changed });
      appendFileSync(file, `${JSON.stringify({ t: "lead", at, lead: "fake:b" })}\n`);
      utimesSync(file, changed, changed);
      expect(listSessions(dir, { print: false })).toEqual([
        { id: "s1", name: "build fix", firstPrompt: "fix the build", lead: "fake:b", changed, size: readFileSync(file).length, print: false },
      ]);
    });

    // Folders that cannot be listed or read stand in for the session's pictures and subagents: the list reads only the
    // transcript's lines (release 8a plan, choice 9), so it never comes to them. Each is a link to itself, which gives
    // ELOOP, so no permission is changed.
    it("reads only the transcript, never the session's pictures or subagents", () => {
      const dir = folder();
      const file = session(dir, "s1", { prompt: "hi" });
      appendFileSync(file, `${JSON.stringify({ t: "subagent", at, id: "t1", description: "find it", file: "t1.jsonl" })}\n`);
      const look = { role: "user", parts: [{ type: "image", id: 1, mediaType: "image/png", file: "1.png" }] };
      appendFileSync(file, `${JSON.stringify({ t: "message", at, message: look })}\n`);
      mkdirSync(path.join(dir, "s1"));
      for (const name of ["pictures", "subagents"]) symlinkSync(path.join(dir, "s1", name), path.join(dir, "s1", name), "junction");
      expect(listSessions(dir, { print: false })).toMatchObject([{ id: "s1", firstPrompt: "hi" }]);
    });

    it("leaves out a session whose start line is torn", () => {
      const dir = folder();
      const file = session(dir, "torn", { prompt: "hi" });
      const lines = readFileSync(file, "utf8").split("\n");
      lines[0] = lines[0]!.slice(0, lines[0]!.length / 2);
      writeFileSync(file, lines.join("\n"));
      session(dir, "whole", { prompt: "hi" });
      expect(listSessions(dir, { print: true }).map((r) => r.id)).toEqual(["whole"]);
    });

    it("is empty for a project with no sessions folder", () => {
      expect(listSessions(path.join(top, "no such folder"), { print: true })).toEqual([]);
    });
  });

  describe("findSession", () => {
    it("finds an exact id, every session a name belongs to, and nothing for neither", () => {
      const dir = folder();
      const now = Date.now();
      session(dir, "a1", { prompt: "one", names: ["shared"], changed: new Date(now - 2 * DAY) });
      session(dir, "b2", { prompt: "two", names: ["shared"], changed: new Date(now - DAY) });
      session(dir, "c3", { prompt: "three", names: ["alone"], changed: new Date(now) });
      expect(findSession(dir, "a1")).toMatchObject({ id: "a1", name: "shared" });
      expect(findSession(dir, "alone")).toMatchObject({ id: "c3" });
      const both = findSession(dir, "shared");
      expect(Array.isArray(both) && both.map((r) => r.id)).toEqual(["b2", "a1"]);
      expect(findSession(dir, "nothing")).toBeNull();
    });
  });

  describe("openSession", () => {
    it("holds a session's lock until released, and refuses it meanwhile", () => {
      const dir = folder();
      session(dir, "s1", { prompt: "hi" });
      const open = openSession(dir, "s1");
      expect(open).not.toBeNull();
      expect(readFileSync(path.join(dir, "s1.lock"), "utf8")).toBe(String(process.pid));
      expect(openSession(dir, "s1")).toBeNull();
      open!.release();
      expect(existsSync(path.join(dir, "s1.lock"))).toBe(false);
    });
  });

  describe("copySession", () => {
    it("makes an independent copy, under a new id, whose pictures read back and whose finished subagent is finished", () => {
      const file = path.join(shared, "orig.jsonl");
      const pictures = path.join(shared, "orig", "pictures");
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
      const look: Message = { role: "user", parts: [{ type: "text", text: "look at " }, { type: "image", id: 1, mediaType: "image/png", data: bytes }] };
      const t = new Transcript(file, pictures);
      t.write(startLine("orig"));
      t.write({ t: "message", message: look });
      t.write({ t: "subagent", id: "t1", description: "find it", file: "t1.jsonl" });
      t.write({ t: "message", message: said("Found it.") });
      expect(t.failed).toBeNull();
      // The subagent's file, finished with its answer, then a line a crash cut short.
      const subagents = path.join(shared, "orig", "subagents");
      mkdirSync(subagents, { recursive: true });
      writeFileSync(
        path.join(subagents, "t1.jsonl"),
        [{ ...startLine("t1"), at }, { t: "message", at, message: prompt("find it") }, { t: "message", at, message: said("It is in b.txt.") }]
          .map((l) => `${JSON.stringify(l)}\n`)
          .join("") + '{"t":"mess',
      );
      // A link in the session's folder, to a folder outside it, which a copy leaves out.
      const outside = path.join(top, "outside-copy");
      mkdirSync(outside);
      writeFileSync(path.join(outside, "secret.txt"), "not a session's");
      symlinkSync(outside, path.join(shared, "orig", "elsewhere"), "junction");
      appendFileSync(file, '{"t":"message","at":"2026-11-06T00:00:00.000Z","mess'); // the window's next line, cut short

      const id = copySession(shared, "orig");
      expect(id).not.toBe("orig");
      const copy = path.join(shared, `${id}.jsonl`);
      const r = read(copy, path.join(shared, id, "pictures"));
      expect(r.start.id).toBe(id);
      expect(r.damaged).toBe(0);
      expect(r.messages).toEqual([look, said("Found it.")]);
      expect(r.unfinished).toEqual([]);
      expect(readFileSync(path.join(shared, id, "subagents", "t1.jsonl"), "utf8").endsWith("\n")).toBe(true);
      expect(readdirSync(path.join(shared, id)).sort()).toEqual(["pictures", "subagents"]);
      // Independent: the original goes on, and the copy does not change.
      const before = readFileSync(copy, "utf8");
      t.mend();
      t.write({ t: "message", message: prompt("and then?") });
      writeFileSync(path.join(pictures, "1.png"), "changed");
      expect(readFileSync(copy, "utf8")).toBe(before);
      expect(readFileSync(path.join(shared, id, "pictures", "1.png"))).toEqual(bytes);
      // A session whose own folder is a link: the copy leaves it out, and what it points at is untouched.
      session(shared, "linked", { prompt: "hi" });
      symlinkSync(outside, path.join(shared, "linked"), "junction");
      const linked = copySession(shared, "linked");
      expect(read(path.join(shared, `${linked}.jsonl`), path.join(shared, linked, "pictures")).start.id).toBe(linked);
      expect(existsSync(path.join(shared, linked))).toBe(false);
      expect(readdirSync(outside)).toEqual(["secret.txt"]);
    });

    // Release 8a plan, Task 6: a copy that fails partway leaves nothing behind, its folder removed before its transcript,
    // as the sweep removes them. The failure is a file standing where the copy's folder goes.
    it("removes a copy that failed partway, and copies nothing from a source with no whole first line", () => {
      session(shared, "partway", { prompt: "hi" });
      mkdirSync(path.join(shared, "partway", "pictures"), { recursive: true });
      writeFileSync(path.join(shared, "taken"), "in the copy's folder's place");
      expect(() => copySession(shared, "partway", "taken")).toThrow(/EEXIST/);
      expect(existsSync(path.join(shared, "taken.jsonl"))).toBe(false);
      expect(existsSync(path.join(shared, "taken"))).toBe(false);
      for (const [id, text] of [["torn", '{"t":"start","v":1,"id":"to'], ["damaged", "not a line\n"]]) {
        writeFileSync(path.join(shared, `${id}.jsonl`), text!);
        expect(() => copySession(shared, id!, `${id}-copy`)).toThrow(/^its first line is missing or damaged$/);
        expect(existsSync(path.join(shared, `${id}-copy.jsonl`))).toBe(false);
      }
    });
  });

  it("names a session's transcript and pictures folder inside the sessions folder", () => {
    expect(sessionPaths(shared, "s1")).toEqual({ file: path.join(shared, "s1.jsonl"), pictures: path.join(shared, "s1", "pictures") });
  });

  describe("the sweep", () => {
    // A data folder of its own, holding one project's sessions folder.
    const place = () => {
      const own = folder();
      const dir = path.join(own, "sessions", "project");
      mkdirSync(dir, { recursive: true });
      return { data: own, dir };
    };
    const now = new Date();
    const old = new Date(now.getTime() - 31 * DAY);
    const age = (p: string, when: Date) => utimesSync(p, when, when);

    it("deletes every project's sessions unchanged for longer than the days, with their folders and locks, and keeps a newer one", async () => {
      const { data, dir } = place();
      age(session(dir, "old", { prompt: "hi" }), old);
      // A lock left by a window that has ended: its pid is no longer running.
      const gone = spawn(process.execPath, ["-e", ""]);
      await new Promise((r) => gone.on("close", r));
      writeFileSync(path.join(dir, "old.lock"), String(gone.pid));
      mkdirSync(path.join(dir, "old", "pictures"), { recursive: true });
      writeFileSync(path.join(dir, "old", "pictures", "1.png"), "bytes");
      age(session(dir, "new", { prompt: "hi" }), new Date(now.getTime() - 29 * DAY));
      const other = path.join(data, "sessions", "other project");
      mkdirSync(other);
      age(session(other, "older", { prompt: "hi" }), old);
      expect(sweep(data, 30, now)).toEqual([]);
      expect(readdirSync(dir)).toEqual(["new.jsonl"]);
      expect(readdirSync(other)).toEqual([]);
    });

    it("keeps an old session whose lock another window holds", () => {
      const { data, dir } = place();
      age(session(dir, "open", { prompt: "hi" }), old);
      writeFileSync(path.join(dir, "open.lock"), String(process.ppid)); // running, and not this process
      expect(sweep(data, 30, now)).toEqual([]);
      expect(readdirSync(dir).sort()).toEqual(["open.jsonl", "open.lock"]);
    });

    it("removes a link in a session's folder without following it", () => {
      const { data, dir } = place();
      age(session(dir, "old", { prompt: "hi" }), old);
      const outside = path.join(top, "outside-sweep");
      mkdirSync(outside);
      writeFileSync(path.join(outside, "keep.txt"), "kept");
      mkdirSync(path.join(dir, "old", "pictures"), { recursive: true });
      symlinkSync(outside, path.join(dir, "old", "pictures", "elsewhere"), "junction");
      // A session whose own folder is a link to the same place.
      age(session(dir, "away", { prompt: "hi" }), old);
      symlinkSync(outside, path.join(dir, "away"), "junction");
      expect(sweep(data, 30, now)).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
      expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("kept");
    });

    it("names a file it cannot delete in a line, and goes on with the rest", () => {
      const { data, dir } = place();
      // A folder in the transcript's place, which cannot be deleted as a file; no permission is changed.
      const stuck = path.join(dir, "stuck.jsonl");
      mkdirSync(stuck);
      age(stuck, old);
      age(session(dir, "old", { prompt: "hi" }), old);
      const lines = sweep(data, 30, now);
      expect(lines).toHaveLength(1);
      const quoted = stuck.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      expect(lines[0]).toMatch(new RegExp(`^An old session could not be deleted: ${quoted} \\((EPERM|EISDIR): .+\\)\\.$`));
      expect(readdirSync(dir)).toEqual(["stuck.jsonl"]);
    });

    it("names a sessions folder it cannot read in a line", () => {
      const data = folder();
      // A plain file where the sessions folder should be, so reading it fails; no permission is changed.
      const sessions = path.join(data, "sessions");
      writeFileSync(sessions, "not a folder");
      const lines = sweep(data, 30, now);
      expect(lines).toHaveLength(1);
      const quoted = sessions.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      expect(lines[0]).toMatch(new RegExp(`^An old session could not be deleted: ${quoted} \\(ENOTDIR: .+\\)\\.$`));
    });

    it("finds nothing to do in a data folder without sessions", () => {
      expect(sweep(path.join(top, "no such folder"), 30, now)).toEqual([]);
    });
  });
});
