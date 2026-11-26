import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupOf } from "../src/clilib.js";
import { Session } from "../src/core/session.js";
import { gitBranch } from "../src/tui/git.js";
import { Bus, FakeProvider, fileTempDir, reply, tempContext } from "./helpers.js";

// PR #23's review: a `.git` whose stat fails other than as missing (EACCES here) throws from statSync and lstatSync
// even with throwIfNoEntry false. The paths in `failing` fail so, with no permission changed: every other stat is the
// real one.
const failing = { stat: new Set<string>(), lstat: new Set<string>() };
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const denied = (p: unknown) =>
    Object.assign(new Error(`EACCES: permission denied, stat '${String(p)}'`), { code: "EACCES" });
  return {
    ...fs,
    statSync: ((p: unknown, ...rest: unknown[]) => {
      if (failing.stat.has(String(p))) throw denied(p);
      return (fs.statSync as (...args: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.statSync,
    lstatSync: ((p: unknown, ...rest: unknown[]) => {
      if (failing.lstat.has(String(p))) throw denied(p);
      return (fs.lstatSync as (...args: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.lstatSync,
  };
});

describe("an unreadable .git (PR #23's review)", () => {
  let top: string;
  beforeAll(() => {
    top = fileTempDir("tachi-unreadable-");
  });
  afterEach(() => {
    failing.stat.clear();
    failing.lstat.clear();
  });
  const repo = (...names: string[]) => {
    const d = path.join(top, ...names);
    mkdirSync(path.join(d, ".git"), { recursive: true });
    writeFileSync(path.join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
    return d;
  };
  const deny = (d: string, which: ("stat" | "lstat")[] = ["stat", "lstat"]) => {
    for (const w of which) failing[w].add(path.join(d, ".git"));
  };

  it("gives no branch, and does not look for one in the folders above", () => {
    repo("above");
    const d = repo("above", "project");
    deny(d);
    expect(gitBranch(d)).toBeNull();
  });

  it("is no repository with no sandbox or in live link, and setupOf does not throw", () => {
    const d = repo("own");
    deny(d);
    expect(setupOf(d, "off", "on")).toEqual({ sandbox: "off", git: "none" });
    expect(setupOf(d, "live", "on")).toEqual({ sandbox: "live", network: "on", git: "none" });
  });

  // gitFolderOutside's own lstat failing is taken as no git folder outside: the repository is then read as it is.
  it("takes live link's git folder as not outside when the check for one cannot read the .git", () => {
    const d = repo("lstat");
    deny(d, ["lstat"]);
    expect(setupOf(d, "live", "off").git).toBe("repo");
  });

  // The notes check reads the setup each message; that read throwing sent no notes, so a due date note was lost too.
  it("still lets the next message tell of a new date", async () => {
    const d = repo("notes");
    deny(d);
    const lead = new FakeProvider("a", [reply("ok")]);
    const session = new Session({
      lead, tools: [], system: "t", ctx: await tempContext(), bus: new Bus(),
      setup: { now: () => setupOf(d, "off", "on"), today: () => "2026-11-18", root: d, platform: process.platform },
    });
    session.load({
      id: "s", messages: [], system: "t", prompts: [], calls: [], nextPicture: 1, nextTask: 1,
      told: { date: "2026-11-17", setup: { sandbox: "off", git: "none" } },
    });
    await session.send("hi");
    expect(lead.seen[0]!.at(-1)!.parts).toEqual([
      { type: "text", text: "hi" },
      {
        type: "text",
        text: "This note is from Tachikoma, not the user: today's date is now 2026-11-18.",
        from: "note",
        note: { date: "2026-11-18" },
      },
    ]);
  });
});
