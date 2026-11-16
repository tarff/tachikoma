import { describe, expect, it } from "vitest";
import {
  dueNotes,
  isDateNote,
  isSetup,
  isSetupNote,
  localDate,
  sameSetup,
  setupNote,
  toldAfter,
} from "../../src/core/setup.js";
import type { Part, Setup } from "../../src/core/types.js";

describe("localDate", () => {
  // The local date, not UTC's (design, "The date"): just after midnight here is still yesterday in UTC west of it.
  it("gives the local date as YYYY-MM-DD", () => {
    expect(localDate(new Date(2026, 10, 18, 0, 5))).toBe("2026-11-18");
    expect(localDate(new Date(2026, 0, 2, 23, 59))).toBe("2026-01-02");
  });
});

const OFF: Setup = { sandbox: "off", git: "repo" };
const LIVE_OFF: Setup = { sandbox: "live", network: "off", git: "repo" };
const LIVE_ON: Setup = { sandbox: "live", network: "on", git: "repo" };
const COPY_OFF: Setup = { sandbox: "copy", network: "off", git: "copy" };
const COPY_ON: Setup = { sandbox: "copy", network: "on", git: "copy" };
const HOST = { root: "C:\\proj", platform: "win32" as const };
const OPEN = "This session was resumed under another setup.";
const CLOSE = "Earlier replies about the setup were right at the time.";
const TO_BOX = "Commands now run with bash in /work; earlier they ran with PowerShell in C:\\proj.";
const TO_HOST = "Commands now run with PowerShell in C:\\proj; earlier they ran with bash in /work.";
const COPY = "The sandbox is now a copy of the project.";
const LIVE = "The sandbox is now a live link to the project.";
const COPY_GIT =
  "The project is a git repository made for this sandbox copy; its one commit holds the project as copied.";
const REPO = "The project is a git repository.";
const WEB_ON = "Shell commands can reach the web now; earlier they could not.";
const WEB_OFF = "Shell commands cannot reach the web now; earlier they could.";
const note = (...said: string[]) => [OPEN, ...said].join(" ");
const UNRECORDED = "This session was resumed, and its earlier sandbox setup was not recorded.";
const unrecorded = (...said: string[]) => [UNRECORDED, ...said].join(" ");

describe("setupNote", () => {
  // Design, "Another setup": a sentence for each fact that differs, in its order, then the closing one.
  it("says each direction of each change", () => {
    const cases: [Setup, Setup, string][] = [
      [OFF, LIVE_OFF, note(TO_BOX, LIVE, WEB_OFF, CLOSE)],
      [OFF, LIVE_ON, note(TO_BOX, LIVE, CLOSE)],
      [OFF, COPY_ON, note(TO_BOX, COPY, COPY_GIT, CLOSE)],
      [OFF, COPY_OFF, note(TO_BOX, COPY, COPY_GIT, WEB_OFF, CLOSE)],
      [LIVE_OFF, OFF, note(TO_HOST, WEB_ON, CLOSE)],
      [LIVE_ON, OFF, note(TO_HOST, CLOSE)],
      [COPY_ON, OFF, note(TO_HOST, REPO, CLOSE)],
      [COPY_OFF, OFF, note(TO_HOST, REPO, WEB_ON, CLOSE)],
      [LIVE_ON, COPY_ON, note(COPY, COPY_GIT, CLOSE)],
      [COPY_OFF, LIVE_OFF, note(LIVE, REPO, CLOSE)],
      [LIVE_OFF, LIVE_ON, note(WEB_ON, CLOSE)],
      [LIVE_ON, LIVE_OFF, note(WEB_OFF, CLOSE)],
      [
        OFF,
        { ...LIVE_OFF, git: "outside" },
        note(
          TO_BOX,
          LIVE,
          "The project is a git repository, but git does not work in the sandbox: " +
            "its .git points to a folder outside the project.",
          WEB_OFF,
          CLOSE,
        ),
      ],
    ];
    for (const [before, now, said] of cases) {
      expect(setupNote(before, now, HOST), `${JSON.stringify(before)} -> ${JSON.stringify(now)}`).toBe(said);
    }
  });

  it("gives the design's example word for word", () => {
    expect(setupNote(LIVE_OFF, COPY_ON, HOST)).toBe(
      "This session was resumed under another setup. The sandbox is now a copy of the project. The project is a git " +
        "repository made for this sandbox copy; its one commit holds the project as copied. Shell commands can " +
        "reach the web now; earlier they could not. Earlier replies about the setup were right at the time.",
    );
  });

  // Decision 12 (choice 4): the same sandbox setting and network is the same setup, git or not.
  it("says nothing for the same setup, git alone included", () => {
    expect(setupNote(OFF, OFF, HOST)).toBeUndefined();
    expect(setupNote({ sandbox: "off", git: "none" }, OFF, HOST)).toBeUndefined();
    expect(setupNote(LIVE_OFF, { ...LIVE_OFF, git: "none" }, HOST)).toBeUndefined();
  });

  // Choice 1: the host's shell as the shell line names it.
  it("names the host's shell as the shell line does on macOS and Linux", () => {
    expect(setupNote(OFF, LIVE_ON, { root: "/home/u/proj", platform: "linux" })).toBe(
      note("Commands now run with bash in /work; earlier they ran with sh in /home/u/proj.", LIVE, CLOSE),
    );
  });

  // Design, "Sessions saved before this change": `box` alone. An unknown earlier fact is said without its "earlier"
  // half, and the note closes only when a known fact differs.
  it("claims nothing of an earlier setup it does not know", () => {
    const on = { sandbox: "on" } as const;
    expect(setupNote(on, LIVE_OFF, HOST)).toBe(unrecorded(LIVE, REPO, "Shell commands cannot reach the web now."));
    expect(setupNote(on, COPY_ON, HOST)).toBe(unrecorded(COPY, COPY_GIT, "Shell commands can reach the web now."));
    expect(setupNote(on, OFF, HOST)).toBe(note(TO_HOST, REPO, "Shell commands can reach the web now.", CLOSE));
    expect(setupNote({ sandbox: "off" }, OFF, HOST)).toBeUndefined();
    expect(setupNote({ sandbox: "off" }, COPY_ON, HOST)).toBe(note(TO_BOX, COPY, COPY_GIT, CLOSE));
  });

  // Task 3's code review; the user's choice: only an old session's "on" resumed in the sandbox opens saying its earlier
  // setup was not recorded; resumed with no sandbox, where commands run is known to differ.
  it("opens as under another setup when an old session's sandbox is now off", () => {
    expect(setupNote({ sandbox: "on" }, OFF, HOST)?.startsWith(`${OPEN} `)).toBe(true);
    expect(setupNote({ sandbox: "on" }, COPY_OFF, HOST)?.startsWith(`${UNRECORDED} `)).toBe(true);
  });
});

describe("dueNotes and toldAfter", () => {
  const date = (d: string) => ({ type: "text", text: `Today's date is now ${d}.`, from: "note", note: { date: d } });
  it("gives the date note first, then the setup note, only when each is due", () => {
    expect(dueNotes({ date: "2026-11-17", setup: OFF }, OFF, "2026-11-17", HOST)).toEqual([]);
    expect(dueNotes({ date: "2026-11-17", setup: OFF }, OFF, "2026-11-18", HOST)).toEqual([date("2026-11-18")]);
    expect(dueNotes({ setup: OFF }, OFF, "2026-11-18", HOST)).toEqual([date("2026-11-18")]); // never told: due
    expect(dueNotes({ date: "2026-11-17", setup: OFF }, LIVE_ON, "2026-11-18", HOST)).toEqual([
      date("2026-11-18"),
      { type: "text", text: note(TO_BOX, LIVE, CLOSE), from: "note", note: { setup: LIVE_ON } },
    ]);
    expect(dueNotes({ date: "2026-11-17", setup: OFF }, LIVE_ON, "2026-11-17", HOST)).toEqual([
      { type: "text", text: note(TO_BOX, LIVE, CLOSE), from: "note", note: { setup: LIVE_ON } },
    ]);
    expect(dueNotes({ date: "2026-11-17", setup: { sandbox: "on" } }, LIVE_ON, "2026-11-17", HOST)).toEqual([
      {
        type: "text",
        text: unrecorded(LIVE, REPO, "Shell commands can reach the web now."),
        from: "note",
        note: { setup: LIVE_ON },
      },
    ]);
  });

  it("reads what a message's notes told, the last of each kind winning, and nothing else", () => {
    const parts = [
      { type: "text", text: "hi" },
      date("2026-11-16"),
      { type: "text", text: "w", from: "note", note: { setup: LIVE_OFF } },
      date("2026-11-18"),
      { type: "text", text: "x", from: "note", note: { setup: { sandbox: "box" } } }, // not a setup: skipped
      { type: "text", text: "y", from: "note", note: { setup: COPY_ON } },
      { type: "text", text: "z", from: "hooks", note: { date: "2030-01-01" } }, // not a note: skipped
      { type: "text", text: "d", from: "note", note: null }, // damaged: skipped
      { type: "text", text: "e", from: "note", note: { date: 5 } }, // damaged: skipped
    ];
    expect(toldAfter({ date: "2026-11-17", setup: OFF }, parts)).toEqual({ date: "2026-11-18", setup: COPY_ON });
    expect(toldAfter({ setup: { sandbox: "on" } }, [])).toEqual({ setup: { sandbox: "on" } });
  });

  it("knows a setup when it sees one", () => {
    for (const s of [OFF, LIVE_OFF, COPY_ON]) expect(isSetup(s)).toBe(true);
    const others = [
      undefined,
      { sandbox: "on" },
      { sandbox: "live", git: "repo" },
      { sandbox: "off", git: "maybe" },
      { sandbox: "copy", network: "maybe", git: "copy" },
    ];
    for (const s of others) expect(isSetup(s)).toBe(false);
  });

  // Task 3's code review: a damaged saved note, as a shortening may meet among restored messages, is neither, and
  // asking does not throw.
  it("tells a date note from a setup note", () => {
    const setup = { type: "text", text: "s", from: "note", note: { setup: LIVE_ON } } as const;
    expect([isDateNote(date("2026-11-18") as Part), isSetupNote(date("2026-11-18") as Part)]).toEqual([true, false]);
    expect([isDateNote(setup), isSetupNote(setup)]).toEqual([false, true]);
    const others = [
      { type: "text", text: "hi" },
      { type: "text", text: "n", from: "note", note: null },
      { type: "text", text: "x", from: "note", note: "x" },
    ] as unknown as Part[];
    for (const p of others) expect([isDateNote(p), isSetupNote(p)]).toEqual([false, false]);
  });

  it("compares the sandbox setting and the box's network, never git", () => {
    expect(sameSetup({ sandbox: "off" }, OFF)).toBe(true);
    expect(sameSetup({ sandbox: "on" }, LIVE_OFF)).toBe(false);
    expect(sameSetup(LIVE_OFF, LIVE_ON)).toBe(false);
    expect(sameSetup(LIVE_OFF, { ...LIVE_OFF, git: "outside" })).toBe(true);
  });
});
