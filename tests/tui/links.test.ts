import { describe, expect, it } from "vitest";
import { hyperlinks } from "../../src/tui/links.js";

// Clickable links plan, Task 1: whether the terminal takes OSC 8 links. FORCE_HYPERLINK as Claude Code 2.1.323 reads it
// (`t7e`, `ps`), then the supports-hyperlinks v3.2.0 checks, then Claude Code's own list (`cw`).
const on = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux", level = 3, tty = true) =>
  hyperlinks(env, tty, level, platform);

describe("hyperlinks", () => {
  describe("FORCE_HYPERLINK", () => {
    it("turns links on for any value but the off words, even with no TTY and nothing else set", () => {
      for (const value of ["1", "2", "true", "yes", "on", "nope", "   "]) {
        expect(on({ FORCE_HYPERLINK: value }, "win32", 3, false), value).toBe(true);
      }
    });

    it("turns links off for 0, false, no and off in any case or spacing, even in Windows Terminal", () => {
      for (const value of ["0", "00", "0abc", " 0", "-0", "false", "FALSE", "no", "No", "off", " Off "]) {
        expect(on({ FORCE_HYPERLINK: value, WT_SESSION: "x" }, "win32"), value).toBe(false);
      }
    });

    it("is as unset when empty", () => {
      expect(on({ FORCE_HYPERLINK: "", WT_SESSION: "x" }, "win32")).toBe(true);
      expect(on({ FORCE_HYPERLINK: "" }, "win32")).toBe(false);
    });
  });

  it("is off when the output is not a TTY and nothing forces it", () => {
    expect(on({ WT_SESSION: "x" }, "win32", 3, false)).toBe(false);
    expect(on({ WT_SESSION: "x" }, "linux", 3, false)).toBe(false);
  });

  it("on Windows, is on in Windows Terminal and ghostty only", () => {
    expect(on({ WT_SESSION: "x" }, "win32")).toBe(true);
    expect(on({}, "win32")).toBe(false); // the old console sets none of the variables
    // supports-hyperlinks' Windows build returns before its TERM_PROGRAM checks
    expect(on({ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.90.0" }, "win32")).toBe(false);
    expect(on({ TERM_PROGRAM: "WezTerm" }, "win32")).toBe(false);
    expect(on({ TERM_PROGRAM: "ghostty" }, "win32")).toBe(true); // Claude Code's own list
  });

  it("elsewhere, takes supports-hyperlinks' terminals and versions", () => {
    const program = (TERM_PROGRAM: string, TERM_PROGRAM_VERSION: string) => on({ TERM_PROGRAM, TERM_PROGRAM_VERSION });
    expect(program("vscode", "1.71.0")).toBe(false);
    expect(program("vscode", "1.72.0")).toBe(true);
    expect(program("vscode", "2.0.0")).toBe(true);
    expect(program("iTerm.app", "3.0.0")).toBe(true); // in Claude Code's list, whatever the version
    expect(program("WezTerm", "20200619")).toBe(false);
    expect(program("WezTerm", "20200620-160318-e00b076c")).toBe(true);
    expect(on({ VTE_VERSION: "0.50.0" })).toBe(false);
    expect(on({ VTE_VERSION: "5001" })).toBe(true); // reads as 0.50.1
    expect(on({ VTE_VERSION: "0.49.0" })).toBe(false);
    expect(on({ TERM: "alacritty" })).toBe(true);
  });

  it("in CI or with no colour, skips supports-hyperlinks' terminals but not Claude Code's list", () => {
    expect(on({ CI: "1", TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.90.0" })).toBe(false);
    expect(on({ CI: "1", TERM_PROGRAM: "kitty" })).toBe(true);
    expect(on({ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.90.0" }, "linux", 0)).toBe(false);
    expect(on({ WT_SESSION: "x" }, "linux", 0)).toBe(true);
  });

  it("takes each terminal in Claude Code's list", () => {
    for (const name of ["ghostty", "Hyper", "kitty", "alacritty", "iTerm.app", "iTerm2", "WarpTerminal"]) {
      expect(on({ TERM_PROGRAM: name }, "win32"), name).toBe(true);
    }
    expect(on({ LC_TERMINAL: "iTerm2" }, "win32")).toBe(true);
    expect(on({ TERMINAL_EMULATOR: "JetBrains-JediTerm" }, "win32")).toBe(true);
    expect(on({ TERM: "xterm-kitty" }, "win32")).toBe(true);
  });

  it("takes Windows Terminal inside tmux only by supports-hyperlinks' check, and tmux from 3.4", () => {
    // supports-hyperlinks' WT_SESSION check does not look at tmux; it stops at the colour check before it, and Claude
    // Code's own list skips WT_SESSION inside tmux
    expect(on({ WT_SESSION: "x", TMUX: "/tmp/tmux-1000/default,1,0" }, "linux", 3)).toBe(true);
    expect(on({ WT_SESSION: "x", TMUX: "/tmp/tmux-1000/default,1,0" }, "linux", 0)).toBe(false);
    const tmux = (TERM_PROGRAM_VERSION: string) => on({ TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION });
    expect(tmux("3.3a")).toBe(false);
    expect(tmux("3.4")).toBe(true);
    expect(tmux("4.0")).toBe(true);
  });
});
