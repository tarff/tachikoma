import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { boxProtection, dropOnExit, keptForReview, type Network, sandboxReady, sandboxStart } from "../src/clilib.js";
import { projectFile } from "../src/core/datadir.js";
import { openSession, sessionsDir } from "../src/core/sessions.js";
import { readTranscript } from "../src/core/transcript.js";
import { onPath } from "../src/exec/env.js";
import type { DockerRun } from "../src/sandbox/docker.js";
import { NOT_BUILT, NOT_INSTALLED, NOT_RUNNING } from "../src/sandbox/image.js";
import { removeTree } from "./helpers.js";

// Docker's answer for an image with no bash (node:22-alpine, as the quality review gave it).
const NO_BASH = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "bash": executable file not found in $PATH: unknown';

// Runs the real command through tsx, in a fresh project folder with a pretend home folder, and with
// the walk for instruction files starting at a fresh folder of its own, so no case reads the user's
// files. Every case here stops before any model answers. The launch reads git's settings (release 7 plan, Task 8), so
// git is given empty system and user settings files of the test's own, and every variable it finds a home folder by
// (HOME, HOMEDRIVE and HOMEPATH, USERPROFILE, XDG_CONFIG_HOME) names the pretend one: no case has git read the user's.
function tachi(...args: (string | Record<string, string>)[]) {
  const { argv, options } = launch(args);
  const r = spawnSync(process.execPath, argv, { ...options, input: "x\n", encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// tachi(), without blocking: for a case whose model is a stand-in served by this test (release 7 plan, Task 10).
function tachiLater(...args: (string | Record<string, string>)[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { argv, options } = launch(args);
  const child = spawn(process.execPath, argv, options);
  onTestFinished(() => void child.kill()); // a run still going when the test ends, as a failing one can leave it
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdin.end("x\n");
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function launch(args: (string | Record<string, string>)[]) {
  const env = args.find((a) => typeof a === "object") ?? {};
  const words = args.filter((a) => typeof a === "string");
  const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-"));
  onTestFinished(() => removeTree(top));
  const home = path.join(top, "home");
  mkdirSync(home);
  const system = path.join(top, "system.gitconfig");
  const global = path.join(top, "global.gitconfig");
  for (const file of [system, global]) writeFileSync(file, "");
  const git = {
    GIT_CONFIG_SYSTEM: system,
    GIT_CONFIG_GLOBAL: global,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  // Tachikoma's data folder, two levels inside the test's own, unless the case gives one: no case writes the user's error
  // log, or from release 8a on their saved sessions (release 8a plan, Task 2).
  const data = path.join(top, "data", "tachikoma");
  return {
    argv: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, path.resolve("src/cli.tsx"), ...words],
    options: {
      cwd: env.cwd ?? top,
      env: {
        ...process.env, TACHI_LEAD: "", ANTHROPIC_API_KEY: "", TACHI_INSTRUCTIONS_TOP: top, USERPROFILE: home, HOME: home, CODEX_HOME: "",
        TACHI_DATA_DIR: data, ...git, ...env,
      },
    },
  };
}

// A pretend home folder holding ~/.tachikoma/settings.json, given to tachi() as its HOME and USERPROFILE.
function homeWith(settings: string) {
  const home = mkdtempSync(path.join(tmpdir(), "tachi-cli-home-"));
  onTestFinished(() => removeTree(home));
  mkdirSync(path.join(home, ".tachikoma"));
  writeFileSync(path.join(home, ".tachikoma", "settings.json"), settings);
  return { USERPROFILE: home, HOME: home };
}

// Each start takes about a second; with the whole suite running, two starts took up to 5 s (2026-10-23),
// past Vitest's default. 15 s, as for the other tests that start processes (tests/exec/local.test.ts).
describe("tachi", { timeout: 15_000 }, () => {
  it("names --fallback when its value is bad", () => {
    const r = tachi("--lead", "ollama:none", "--fallback", "nope", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^--fallback: /);
  });

  it("names --worker when its value is bad, and takes TACHI_WORKER too", () => {
    expect(tachi("--lead", "ollama:none", "--worker", "nope", "-p", "hi").stderr).toMatch(/^--worker: /);
    expect(tachi("--lead", "ollama:none", "-p", "hi", { TACHI_WORKER: "nope" }).stderr).toMatch(/^--worker: /);
  });

  it("takes --max-tasks only as a whole number from 1", () => {
    for (const bad of ["0", "x", "1.5", "1e1", " 8 ", "0x10"]) {
      const r = tachi("--lead", "ollama:none", "--max-tasks", bad, "-p", "hi");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`--max-tasks must be a whole number from 1 (got "${bad}")`);
    }
  });

  it("refuses a blank prompt instead of sending it", () => {
    for (const prompt of ["", "  "]) {
      const r = tachi("--lead", "ollama:none", "-p", prompt);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("-p needs a prompt");
    }
  });

  it("allows --raw only with -p, and without --json, which is already exact", () => {
    for (const args of [["--lead", "ollama:none", "--raw"], ["--lead", "ollama:none", "-p", "hi", "--json", "--raw"]]) {
      const r = tachi(...args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--raw works only with -p, and not with --json");
    }
  });

  // Release 8a final review (user, 2026-11-07): it would otherwise be ignored without a word.
  it("allows --fork-session only with -c or -r", () => {
    const r = tachi("--lead", "ollama:none", "-p", "hi", "--fork-session");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--fork-session works only with -c or -r");
  });

  it("warns that --raw output is not made safe for a terminal", () => {
    const r = tachi("--lead", "ollama:none", "-p", "hi", "--raw");
    expect(r.stderr).toContain("warning: --raw prints the answer exactly as the model wrote it");
  });

  it("asks for the Anthropic key before starting", () => {
    const r = tachi("--lead", "anthropic:claude-opus-5-5", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Set ANTHROPIC_API_KEY to use anthropic");
  });

  it("signs out of ChatGPT on its own, and says when nobody was signed in", () => {
    const data = path.join(mkdtempSync(path.join(tmpdir(), "tachi-cli-")), "data");
    const r = tachi("logout", "chatgpt", { TACHI_DATA_DIR: data });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("Not signed in to ChatGPT.");
  });

  it("explains login's usage instead of starting a sign-in", () => {
    expect(tachi("login", "openai").stderr).toContain("Only ChatGPT has a login: `tachi login chatgpt`. Other providers use an API key.");
    const r = tachi("login", "chatgpt", "--account", "x");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Usage: tachi login chatgpt [--new | --account <number>]");
  });

  // Only the usage, so Docker is never run: the command's steps are tested with a stand-in Docker (tests/sandbox).
  it("explains tachi sandbox's usage, before any launch check", () => {
    const r = tachi("sandbox", "make");
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe("Usage: tachi sandbox build");
  });

  it("with -p, leaves out instruction files from outside the project and says which, printing nothing about the rest", () => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-"));
    const proj = path.join(top, "proj");
    mkdirSync(proj);
    writeFileSync(path.join(top, "secret.md"), "secret");
    writeFileSync(path.join(proj, "CLAUDE.md"), `@${path.join(top, "secret.md")}`);
    const r = tachi("--lead", "ollama:none", "-p", "hi", { cwd: proj, TACHI_INSTRUCTIONS_TOP: top });
    expect(r.stderr).toContain(`note: 1 instruction file from outside the project left out, since nobody can approve it in -p mode: ${path.join(top, "secret.md")}, imported by ${path.join(proj, "CLAUDE.md")}`);
    expect(r.stderr).not.toContain("Instructions:");
  });

  it("lists --classic and /screen in the help", () => {
    const help = tachi("--help").stdout;
    expect(help).toMatch(/^ {2}--classic /m);
    expect(help).toMatch(/\/screen switches between full\s+screen\s+and\s+classic/);
  });

  it("lists tachi review in the help", () => {
    expect(tachi("--help").stdout).toMatch(/^ {2}tachi review \[<name> \[--discard\]\] +list the copies kept for review, open one, or discard one$/m);
  });

  it("lists /settings, /keybindings and /vim in the help", () => {
    const help = tachi("--help").stdout;
    expect(help).toMatch(/\/settings opens the settings file in your editor,\s+\/keybindings opens the\s+keys file in your editor/);
    expect(help).toMatch(/\/vim\s+switches\s+vim\s+mode\s+in\s+this\s+window,/);
  });

  // Release 6 plan, Task 23: Esc and Ctrl+T are actions the keys file can move (release 6 design, "Keys become named
  // actions"); Ctrl-C and Ctrl-D are reserved (bindings.ts, RESERVED).
  it("says in the help that Esc and Ctrl+T can be moved in the keys file, and Ctrl-C and Ctrl-D cannot", () => {
    expect(tachi("--help").stdout).toMatch(/Esc\s+and\s+Ctrl\+T\s+can\s+be\s+moved\s+in\s+the\s+keys\s+file;\s+Ctrl-C\s+and\s+Ctrl-D\s+cannot\./);
  });

  // Final review: the help showed --lead as needed, and never named the settings file.
  it("shows --lead as optional in the help, and says the options from --lead to --scroll-speed can be set in the settings file", () => {
    const help = tachi("--help").stdout;
    expect(help).toMatch(/^ {2}tachi \[--lead <provider:model>\] \[options\] +interactive session$/m);
    expect(help).toMatch(/^ {2}tachi \[--lead <provider:model>\] -p "<prompt>" +run one prompt, print the answer, exit$/m);
    const file = path.join("~", ".tachikoma", "settings.json"); // this machine's separator
    expect(help).toContain(`\n  Options --lead to --scroll-speed can also be set in ${file}; a flag or variable wins.\n`);
  });

  it("lists --scroll-speed in the help, and stops on a bad one, from the option or, in interactive mode, TACHI_SCROLL_SPEED", () => {
    expect(tachi("--help").stdout).toMatch(/^ {2}--scroll-speed <n> /m);
    let r = tachi("--lead", "ollama:none", "--scroll-speed", "abc", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--scroll-speed must be a number above 0, up to 20 (got "abc")');
    r = tachi("--lead", "ollama:none", { TACHI_SCROLL_SPEED: "21" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('TACHI_SCROLL_SPEED must be a number above 0, up to 20 (got "21")');
  });

  // Port 9, as below: the run gets as far as asking the model and fails there, with nothing sent anywhere.
  it("with -p, ignores TACHI_SCROLL_SPEED, as it does TACHI_CLASSIC", () => {
    const r = tachi("--lead", "openai:none", "-p", "hi", { TACHI_SCROLL_SPEED: "abc", OPENAI_API_KEY: "x", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" });
    expect(r.stderr).not.toContain("TACHI_SCROLL_SPEED");
    expect(r.stderr).toContain("Could not reach http://127.0.0.1:9/v1");
  });

  // Port 9 is one fetch refuses to connect to at all, so the run gets as far as asking the model and fails there,
  // with nothing sent anywhere.
  it("with -p, writes no screen or mouse codes", () => {
    const r = tachi("--lead", "openai:none", "-p", "hi", { OPENAI_API_KEY: "x", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" });
    expect(r.stderr).toContain("Could not reach http://127.0.0.1:9/v1");
    expect(r.stdout + r.stderr).not.toContain("\u001b[?"); // how the second screen's, the mouse's and the cursor's codes begin
  });

  // Release 8a plan, Task 2: the data folder is checked in the env given to the child, before it starts, so a launch
  // without one never writes the user's own error log; the user's folder is never listed. Port 9, as above.
  it("with -p, logs a provider error in the test's own data folder", () => {
    const { argv, options } = launch(["--lead", "openai:none", "-p", "hi", { OPENAI_API_KEY: "x", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" }]);
    const data = path.join(options.cwd, "data", "tachikoma");
    expect(options.env.TACHI_DATA_DIR).toBe(data);
    const r = spawnSync(process.execPath, argv, { ...options, input: "x\n", encoding: "utf8" });
    expect(r.stderr).toContain("Could not reach http://127.0.0.1:9/v1");
    const rows = readFileSync(projectFile("errors", options.cwd, data), "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!).message).toContain("Could not reach http://127.0.0.1:9/v1");
  });

  it("refuses interactive mode without a terminal, before starting the interface", () => {
    const r = tachi("--lead", "ollama:none");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
    expect(r.stderr).not.toContain("    at "); // no stack trace
  });

  // Release 6 design, "The settings file". The stand-in terminal stops an interactive start, as above, once the lead is made.
  it("takes the lead from the settings file when no flag gives one", () => {
    const r = tachi(homeWith('{"lead": "ollama:none"}'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
  });

  it("with no lead anywhere, says how to set one in the settings file", () => {
    const r = tachi();
    expect(r.code).toBe(1);
    const file = path.join("~", ".tachikoma", "settings.json"); // this machine's separator
    expect(r.stderr).toContain(`No lead model given. Pass --lead, set TACHI_LEAD, or put "lead": "<provider:model>" in ${file}.`);
  });

  // Release 5's order: no lead, a blank -p, --raw, then the flags; the settings file's own
  // problem, new in release 6, before them all.
  it("says what is wrong in release 5's order, the settings file's own problem first", () => {
    let r = tachi("--mode", "x");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^No lead model given\./);
    r = tachi("--lead", "ollama:none", "-p", "", "--mode", "x");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^-p needs a prompt\n/);
    r = tachi("--lead", "ollama:none", "-p", "hi", "--raw", "--mode", "x");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^warning: --raw prints the answer exactly as the model wrote it; .*\n--mode must be one of: /);
    r = tachi("--mode", "x", homeWith('{"effort": "x"}'));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^settings\.json: "effort" must be one of: /);
  });

  it("stops on a broken settings file, with its problem", () => {
    let r = tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"mode": "x"}'));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^settings\.json: "mode" must be one of: ask, project, auto, never \(got "x"\)/);
    r = tachi("--lead", "ollama:none", "-p", "hi", homeWith("{"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^settings\.json is not valid JSON: /);
  });

  // Release 7 plan, Task 7 and choice 1: `never` only with copy mode, so nothing reaches the folder before the user has
  // reviewed it, from the flag or the file, with -p and without; live link is not enough. Without -p the stand-in terminal
  // would stop the start later, so the refusal comes first. Seven starts.
  it("refuses never mode without --sandbox copy, from --mode or the settings file, with and without -p", { timeout: 60_000 }, () => {
    const needs = "never needs --sandbox copy, so nothing reaches your folder before you have reviewed it; launch with --sandbox copy --mode never.\n";
    const flag = [["--mode", "never", "-p", "hi"], ["--mode", "never"], ["--mode", "never", "--sandbox", "live", "-p", "hi"]];
    for (const args of flag) {
      const r = tachi("--lead", "ollama:none", ...args);
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(`--mode ${needs}`);
    }
    for (const r of [tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"mode": "never"}')), tachi("--lead", "ollama:none", homeWith('{"mode": "never"}'))]) {
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(`settings.json: "mode": ${needs}`);
    }
    // A flag still wins over the file, so --mode ask starts, and so does auto.
    expect(tachi("--lead", "ollama:none", "--mode", "ask", homeWith('{"mode": "never"}')).stderr).toContain("Interactive mode needs a terminal; use -p");
    expect(tachi("--lead", "ollama:none", "--mode", "auto").stderr).toBe('Interactive mode needs a terminal; use -p "<prompt>" to run one prompt.\n');
  });

  // Release 7 plan, Task 21: copy mode is built, so it launches, and never with it, from the flag or the settings file.
  // PATH is an empty folder of the test's own, so the launch stops at its Docker step with Docker not installed, having
  // passed the mode's check, and no case here runs Docker. The project is a folder of its own, beside the pretend home, so
  // choice 13's refusal does not come first. Five starts.
  it("launches copy mode, and never with it, from the flag or the settings file, as far as Docker", { timeout: 60_000 }, () => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-"));
    onTestFinished(() => removeTree(top));
    const proj = path.join(top, "proj");
    const empty = path.join(top, "empty");
    mkdirSync(proj);
    mkdirSync(empty);
    const where = { cwd: proj, PATH: empty, Path: empty, TACHI_DATA_DIR: path.join(top, "data") };
    const notInstalled = `${NOT_INSTALLED}\n`;
    for (const r of [
      tachi("--lead", "ollama:none", "--sandbox", "copy", "-p", "hi", where),
      tachi("--lead", "ollama:none", "--sandbox", "copy", "--mode", "never", "-p", "hi", where),
      tachi("--lead", "ollama:none", "-p", "hi", { ...where, ...homeWith('{"sandbox": "copy", "mode": "never"}') }),
    ]) {
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(notInstalled);
    }
    // A flag wins over the file, so --sandbox off starts.
    expect(tachi("--lead", "ollama:none", "--sandbox", "off", homeWith('{"sandbox": "copy"}')).stderr).toContain("Interactive mode needs a terminal; use -p");
    const r = tachi("--lead", "ollama:none", "--sandbox", "x", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('--sandbox must be one of: off, live, copy (got "x")\n');
  });

  // Choice 29: headless copy mode names the copy kept for review on stderr, after the answer (cli.tsx).
  it("words the headless line naming the copy kept for review", () => {
    expect(keptForReview("0d6c1f2e")).toBe("Changes kept for review: tachi review 0d6c1f2e");
  });

  // Task 16: live link's first step is choice 13's refusal, before Docker is asked anything. Here the project folder holds
  // the pretend home folder, so the real command stops there, and no case here reaches Docker. Two starts.
  it("refuses live link on a folder that holds the home folder, from the flag or the settings file, before Docker", { timeout: 60_000 }, () => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-"));
    const home = path.join(top, "home");
    mkdirSync(path.join(home, ".tachikoma"), { recursive: true });
    writeFileSync(path.join(home, ".tachikoma", "settings.json"), '{"sandbox": "live"}');
    const where = { cwd: top, HOME: home, USERPROFILE: home, TACHI_DATA_DIR: path.join(tmpdir(), "tachi-cli-no-data") };
    const refusal =
      `The sandbox cannot run on ${top}: it holds Tachikoma's settings folder, which must never be in the box. ` +
      "Start Tachikoma in a project folder.\n";
    for (const r of [tachi("--lead", "ollama:none", "--sandbox", "live", "-p", "hi", where), tachi("--lead", "ollama:none", "-p", "hi", where)]) {
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(refusal);
    }
  });

  // Release 7 plan, choice 22: the network setting acts only in the sandbox, so --network without it is said once at
  // launch, and the session starts. The file's entry is not warned of, as only a flag is typed for this launch. Four starts.
  it("warns that --network was ignored without the sandbox, and starts", { timeout: 60_000 }, () => {
    const started = 'Interactive mode needs a terminal; use -p "<prompt>" to run one prompt.\n'; // the stand-in terminal stops it there
    for (const net of ["on", "off"]) {
      const r = tachi("--lead", "ollama:none", "--network", net);
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(`--network acts only with the sandbox on; it was ignored\n${started}`);
    }
    expect(tachi("--lead", "ollama:none", homeWith('{"network": "on"}')).stderr).toBe(started);
    const r = tachi("--lead", "ollama:none", "--network", "x", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('--network must be one of: off, on (got "x")\n');
  });

  // Release 7 plan, Task 7: the judge is made at launch, as --worker is, so a bad one stops it in its own words.
  it("names --judge, or the settings file's judge, when its value is bad", () => {
    const bad = 'Expected <provider>:<model>, e.g. anthropic:claude-opus-5-5 (got "nope")\n';
    let r = tachi("--lead", "ollama:none", "--judge", "nope", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`--judge: ${bad}`);
    r = tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"judge": "nope"}'));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`settings.json: "judge": ${bad}`);
  });

  it("describes the four modes and --sandbox, --network and --judge in the help, one line each", () => {
    const help = tachi("--help").stdout;
    expect(help).toContain(
      [
        "  --mode <mode>     when to ask before acting (default: ask):",
        "                    ask: before each write and shell command, and before anything outside the project",
        "                    project: before shell commands and anything outside the project",
        "                    auto: reads and edits in the project run, the judge model decides the rest,",
        "                          and dangerous commands ask you",
        "                    never: never ask; only with --sandbox copy, where you review changes at the end",
        "  --sandbox <how>   off | live | copy (default: off): commands run in Docker on this folder or a copy",
        "  --network <net>   off | on (default: off): whether commands in the sandbox can reach the internet",
        "  --judge <spec>    the model that judges in auto mode; the lead's model unless set",
        "",
      ].join("\n"),
    );
  });

  // The security review's finding 2: a bad value in the settings file reaches stderr with its control characters as
  // escapes, so an OSC 52 in it cannot set the clipboard, nor any other code act on the terminal. Nine starts.
  it("prints the settings file's problems and warnings with control characters as escapes", { timeout: 60_000 }, () => {
    const osc = "\\u001b]52;c;ZWNobyBwd25lZA==\\u0007"; // ESC and BEL, as JSON writes them
    const runs = [
      ...["mode", "effort", "screen", "editorMode"].map((name) => tachi("--lead", "ollama:none", "-p", "hi", homeWith(`{"${name}": "${osc}"}`))),
      tachi("--lead", "ollama:none", "-p", "hi", homeWith(`{"status": ["${osc}"]}`)),
      tachi("-p", "hi", homeWith(`{"lead": "${osc}"}`)),
      tachi("--lead", "ollama:none", "-p", "hi", homeWith(`{"fallback": "${osc}"}`)),
      tachi("--lead", "ollama:none", "-p", "", homeWith(`{"${osc}": 1}`)), // a warning, then -p's own problem
      tachi("--lead", "ollama:none", "-p", "hi", homeWith("\u001b]52;c;ZWNobyBwd25lZA==\u0007")), // not JSON: the parser quotes its first 10 characters
    ];
    for (const r of runs) {
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("\\u001b]52;c;ZWN");
      expect(r.stderr).not.toMatch(/[\u001b\u0007]/);
    }
  });

  it("warns of an unknown settings entry on stderr, and starts", () => {
    const r = tachi(homeWith('{"lead": "ollama:none", "leed": "x"}'));
    expect(r.stderr).toContain('settings.json: "leed" is not a setting; it was left out\n');
    expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
  });

  it("starts on a settings file that begins with a byte-order mark, as Windows PowerShell 5.1 writes it", () => {
    const r = tachi(homeWith(`${String.fromCharCode(0xfeff)}{"lead": "ollama:none"}`));
    expect(r.stderr).not.toContain("settings.json");
    expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
  });

  it("starts with the defaults on an empty settings file, or one of only spaces and line breaks", () => {
    for (const text of ["", " \r\n "]) {
      const r = tachi("--lead", "ollama:none", homeWith(text));
      expect(r.stderr).not.toContain("settings.json");
      expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
    }
  });

  it("with -p, still stops on a bad scrollSpeed in the settings file, which is checked whole", () => {
    const r = tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"scrollSpeed": 50}'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('settings.json: "scrollSpeed" must be a number above 0, up to 20 (got "50")');
  });

  it("lets a flag win over the settings file", () => {
    const r = tachi("--lead", "ollama:none", homeWith('{"lead": "nope"}'));
    expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
  });

  it("names the settings entry when a model it gives is bad", () => {
    expect(tachi("-p", "hi", homeWith('{"lead": "nope"}')).stderr).toMatch(/^settings\.json: "lead": Expected <provider>:<model>/);
    expect(tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"fallback": "nope"}')).stderr).toMatch(/^settings\.json: "fallback": Expected/);
    expect(tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"worker": "nope"}')).stderr).toMatch(/^settings\.json: "worker": Expected/);
  });

  // Release 7 plan, Task 4: while any kind of the dangerous-command check is off, each launch says so in one line. Port 9,
  // as below: the run gets as far as asking the model and fails there, with nothing sent anywhere. Each such launch makes
  // its own data folder private for the error log, 6.8-7.4 s alone (2026-11-06; release 8a plan, Task 2), so the case
  // has the describe's 15 s for each of its three launches.
  it("says at launch which kinds of the dangerous-command check are off, and nothing while none is", { timeout: 45_000 }, () => {
    const unreachable = { OPENAI_API_KEY: "x", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" };
    const run = (rules: string) => tachi("-p", "hi", { ...homeWith(`{"lead": "openai:none", "dangerousCommands": ${rules}}`), ...unreachable });
    const off = run('{"off": ["installing software", "sending files out"]}');
    expect(off.stderr).toMatch(/^The dangerous-command check is off for: installing software, sending files out; in auto and never, those commands run without it\.\n/);
    expect(off.stderr).toContain("Could not reach http://127.0.0.1:9/v1");
    for (const none of ['{"add": ["make deploy"]}', '{"off": []}']) expect(run(none).stderr).not.toContain("dangerous-command check");
  });

  it("stops the launch on a bad dangerousCommands entry", () => {
    const r = tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"dangerousCommands": {"off": ["installing"]}}'));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^settings\.json: "dangerousCommands\.off" must be a list of: wiping or formatting disks, .* \(got "installing"\)\n$/);
  });

  // Release 7 plan, Task 8: when git's settings cannot be read at launch, it says so in one line and starts, with only the
  // fixed list protecting. The user settings file here is the test's own, of 12,000 entries of 100 letters, so git's
  // listing of it passes Node's execFile maxBuffer (1 MiB) and the run fails as git killed by a signal would. Port 9, as
  // below: the run then gets as far as asking the model and fails there. 15 s for each of its two launches, as above.
  it.skipIf(!onPath("git"))("says at launch when git's settings could not be read, and starts", { timeout: 30_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-cli-git-"));
    const big = path.join(dir, "big.gitconfig");
    writeFileSync(big, `[sample]\n${Array.from({ length: 12_000 }, (_, i) => `\tkey${i} = ${"x".repeat(100)}\n`).join("")}`);
    const unreachable = { OPENAI_API_KEY: "x", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" };
    const r = tachi("--lead", "openai:none", "-p", "hi", { GIT_CONFIG_GLOBAL: big, ...unreachable });
    expect(r.stderr).toMatch(/^git's settings could not be read \(stdout maxBuffer length exceeded\); only the fixed list of protected paths applies\n/);
    expect(r.stderr).toContain("Could not reach http://127.0.0.1:9/v1");
    expect(tachi("--lead", "openai:none", "-p", "hi", unreachable).stderr).not.toContain("git's settings");
  });

  // Release 7 plan, choice 65: in -p, a judge that cannot be reached refuses the action as a no does, says so on stderr,
  // and fails no run. The lead and the judge are a stand-in for OpenAI's chat completions that this test serves on the
  // loopback address: the lead asks to read a made-up file outside the project, then answers; the judge's request fails.
  it("with -p in auto, says a judge's error on stderr, refuses the action, and still ends as the run did", async () => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-"));
    const proj = path.join(top, "proj");
    mkdirSync(proj);
    const notes = path.join(top, "elsewhere", "notes.txt");
    const sent: { model: string; messages: { role: string; content?: unknown }[] }[] = [];
    // An async handler, as FakeOpenAI's, answering 500 if it throws, so a mistake here fails the run, not the test file.
    const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body) as (typeof sent)[number];
      sent.push(request);
      const json = (status: number, o: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (request.model === "judge") return void json(400, { error: { message: "the judge is down", type: "invalid_request_error" } });
      const first = !request.messages.some((m) => m.role === "tool");
      const call = { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: notes }) } };
      const message = first ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: "done" };
      json(200, { id: "r", object: "chat.completion", created: 0, model: request.model, choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    };
    const server = http.createServer(
      (req, res) =>
        void handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      server.close();
      server.closeAllConnections();
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const r = await tachiLater("--lead", "openai:lead", "--judge", "openai:judge", "--mode", "auto", "-p", "read the notes", { cwd: proj, OPENAI_API_KEY: "x", OPENAI_BASE_URL: url });
    expect(r.stderr).toBe("judge: 400 the judge is down\n");
    expect(r.stdout).toBe("done\n");
    expect(r.code).toBe(0);
    expect(sent.map((x) => x.model)).toEqual(["lead", "judge", "lead"]);
    expect(sent[2]!.messages.at(-1)).toMatchObject({ role: "tool", content: "Error: The judge refused: the judge could not be reached: 400 the judge is down" }); // the provider marks a refused call so
  });

  // Release 8b plan, Task 6 (the user's choice, 2026-11-09): a call a PreToolUse hook refused fails a -p run, as a refusal
  // the gate's ask reports does. The lead is a stand-in served on the loopback address, as above: it asks to read a file in
  // the project, which -p would read unasked, then answers. The hook is a Node script of the test's own, in exec form.
  it.each([
    ["a deny", { permissionDecision: "deny", permissionDecisionReason: "not the notes" }, "Error: not the notes"],
    [
      "an ask -p cannot put",
      { permissionDecision: "ask", permissionDecisionReason: "Sure?" },
      "Error: Not allowed: a PreToolUse hook asked for this call to be approved (Sure?), and -p cannot ask.",
    ],
  ])("with -p, fails the run with exit code 1 when a PreToolUse hook refuses a call: %s", async (_name, decided, told) => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-hook-"));
    onTestFinished(() => removeTree(top));
    const proj = path.join(top, "proj");
    mkdirSync(proj);
    writeFileSync(path.join(proj, "notes.txt"), "made-up notes\n");
    const script = path.join(top, "hook.cjs");
    writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...decided } }))});`);
    const hooks = { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: process.execPath, args: [script] }] }] };
    const sent: { messages: { role: string; content?: unknown }[] }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (d: string) => (body += d));
      req.on("end", () => {
        const request = JSON.parse(body) as (typeof sent)[number];
        sent.push(request);
        const first = !request.messages.some((m) => m.role === "tool");
        const call = { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) } };
        const message = first ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: "done" };
        const choice = { index: 0, finish_reason: first ? "tool_calls" : "stop", message };
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
        const answer = { id: "r", object: "chat.completion", created: 0, model: "lead", choices: [choice], usage };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      server.close();
      server.closeAllConnections();
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const env = { cwd: proj, OPENAI_API_KEY: "x", OPENAI_BASE_URL: url, ...homeWith(JSON.stringify({ hooks })) };
    const r = await tachiLater("--lead", "openai:lead", "-p", "read the notes", env);
    expect(r).toMatchObject({ code: 1, stdout: "done\n" });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: told });
  });

  // Release 8b plan, Task 8 and choice 9: a prompt a UserPromptSubmit hook blocked, and any hook's continue: false, end a
  // -p run with exit code 1 and the grey line as a note on its error output. The lead is the stand-in above, which asks to
  // read a file, then answers.
  it.each([
    ["a UserPromptSubmit hook blocks the prompt", "UserPromptSubmit", { decision: "block", reason: "not today" }, 0, "A UserPromptSubmit hook blocked the prompt: not today"],
    ["a PreToolUse hook stops the turn", "PreToolUse", { continue: false, stopReason: "enough" }, 1, "A PreToolUse hook stopped the turn: enough"],
  ])("with -p, fails the run with exit code 1 when %s, with its line", async (_name, event, said, requests, line) => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-hook-"));
    onTestFinished(() => removeTree(top));
    const proj = path.join(top, "proj");
    mkdirSync(proj);
    writeFileSync(path.join(proj, "notes.txt"), "made-up notes\n");
    const script = path.join(top, "hook.cjs");
    writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(said))});`);
    const hooks = { [event]: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] };
    let asked = 0;
    const server = http.createServer((req, res) => {
      req.resume().on("end", () => {
        const call = { id: `c${++asked}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) } };
        const message = { role: "assistant", content: null, tool_calls: [call] };
        const choice = { index: 0, finish_reason: "tool_calls", message };
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "r", object: "chat.completion", created: 0, model: "lead", choices: [choice], usage }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      server.close();
      server.closeAllConnections();
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const env = { cwd: proj, OPENAI_API_KEY: "x", OPENAI_BASE_URL: url, ...homeWith(JSON.stringify({ hooks })) };
    const r = await tachiLater("--lead", "openai:lead", "-p", "read the notes", env);
    expect(r).toEqual({ code: 1, stdout: "", stderr: `note: ${line}\n` });
    expect(asked).toBe(requests);
  });

  // Port 9, as above: the run gets as far as asking the model and fails there, with nothing sent anywhere.
  it("with -p, runs on the settings file's lead", () => {
    const r = tachi("-p", "hi", { ...homeWith('{"lead": "openai:none"}'), OPENAI_API_KEY: "x", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" });
    expect(r.stderr).toContain("Could not reach http://127.0.0.1:9/v1");
  });
});

// Release 8a plan, Task 6: saved sessions at launch. The model is a stand-in for OpenAI's chat completions served by the
// test on the loopback address, as above, answering "done" to each request (or `status` with an error) and keeping what
// each was sent. Each case has its own project and data folder, two levels inside a fresh temporary folder; its sessions
// are saved by a launch or written by hand as a Transcript writes them.
describe("tachi's saved sessions", { timeout: 15_000 }, () => {
  type Sent = { messages: { role: string; content?: unknown }[] };
  async function standIn(status = 200) {
    const sent: Sent[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (d: string) => (body += d));
      req.on("end", () => {
        sent.push(JSON.parse(body));
        const json = (code: number, o: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
        if (status !== 200) return json(status, { error: { message: "the stand-in refused", type: "invalid_request_error" } });
        const message = { role: "assistant", content: "done" };
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
        json(200, { id: "r", object: "chat.completion", created: 0, model: "lead", choices: [{ index: 0, finish_reason: "stop", message }], usage });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      server.close();
      server.closeAllConnections();
    });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, sent };
  }
  // A project and data folder of the case's own, and its sessions folder, as the launch finds it.
  function place() {
    const top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-cli-saved-")));
    onTestFinished(() => removeTree(top));
    const proj = path.join(top, "proj");
    const data = path.join(top, "data", "tachikoma");
    mkdirSync(proj);
    return { proj, data, dir: sessionsDir(proj, data) };
  }
  const at = "2026-11-06T00:00:00.000Z";
  const start = (id: string, lead = "openai:lead") => ({
    t: "start", at, v: 1, id, project: "p", lead, version: "0.8.0", print: false, system: "Saved prompt.",
    tools: [],
  });
  const message = (role: "user" | "assistant", text: string) => ({ t: "message", at, message: { role, parts: [{ type: "text", text }] } });
  const write = (dir: string, id: string, lines: object[], tail = "") => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join("") + tail);
    return file;
  };
  const texts = (s: Sent) => JSON.stringify(s.messages);
  // A launch's place and model, with TACHI_LEAD as its lead.
  const where = (proj: string, data: string, url: string) => ({
    cwd: proj,
    TACHI_DATA_DIR: data,
    TACHI_LEAD: "openai:lead",
    OPENAI_API_KEY: "x",
    OPENAI_BASE_URL: url,
  });
  // The help's lines for the new options (Task 6's draft, for the user's approval).
  const HELP_SESSIONS = [
    "  -c, --continue    reopen the newest session saved in this folder (with -p, the newest -p run)",
    "  -r, --resume [<id or name>]  reopen a saved session by its id or name, or pick one from a list",
    "  -n, --name <name>  name this session, to reopen it with --resume <name>",
    "  --fork-session    with -c or -r, open a copy of the session and leave the saved one as it was",
    "",
  ].join("\n");

  // Release 8a plan, Task 13 (user, 2026-11-06: "Show the line, send anyway"): a summary for the /autocompact size that
  // fails, the request then sent as it is and answered, fails no -p run. The first reply reports a million prompt tokens,
  // so the next request is over the settings file's size; the summary request is refused; the window is not known.
  it("with -p, says a failed shortening for the /autocompact size, sends the request as it is, and still succeeds", async () => {
    const { proj, data } = place();
    writeFileSync(path.join(proj, "notes.txt"), "made-up notes\n");
    const sent: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (d: string) => (body += d));
      req.on("end", () => {
        const { messages } = JSON.parse(body) as Sent;
        const json = (code: number, o: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
        const summary = JSON.stringify(messages.at(-1)).includes("Summarise this conversation");
        const first = !messages.some((m) => m.role === "tool");
        sent.push(summary ? "summary" : first ? "first" : "after the call");
        if (summary) return json(400, { error: { message: "the stand-in refused", type: "invalid_request_error" } });
        const call = { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) } };
        const message = first ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: "done" };
        const usage = { prompt_tokens: first ? 1_000_000 : 1, completion_tokens: 1, total_tokens: 2 };
        const choice = { index: 0, finish_reason: first ? "tool_calls" : "stop", message };
        json(200, { id: "r", object: "chat.completion", created: 0, model: "lead", choices: [choice], usage });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      server.close();
      server.closeAllConnections();
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const r = await tachiLater("-p", "read the notes", { ...where(proj, data, url), ...homeWith('{"autoCompactWindow": 1000}') });
    expect(sent).toEqual(["first", "summary", "after the call"]);
    expect(r).toMatchObject({ code: 0, stdout: "done\n", stderr: "The conversation could not be shortened (400 the stand-in refused); it is unchanged.\n" });
  });

  it("saves a -p run, named with -n, and -p -c carries it on with both prompts' history", { timeout: 30_000 }, async () => {
    const { url, sent } = await standIn();
    const { proj, data, dir } = place();
    const env = { cwd: proj, TACHI_DATA_DIR: data, OPENAI_API_KEY: "x", OPENAI_BASE_URL: url };
    const first = await tachiLater("--lead", "openai:lead", "-p", "hi", "-n", "first run", env);
    expect(first).toMatchObject({ code: 0, stdout: "done\n", stderr: "" });
    const [file] = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    const lines = readFileSync(path.join(dir, file!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.slice(0, 2)).toMatchObject([{ t: "start", lead: "openai:lead", version, print: true, project: proj }, { t: "name", name: "first run" }]);
    const again = await tachiLater("--lead", "openai:lead", "-p", "again", "-c", env);
    expect(again).toMatchObject({ code: 0, stdout: "done\n", stderr: "Resumed: first run.\n" });
    expect(sent[1]!.messages.slice(1)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
      { role: "user", content: "again" },
    ]);
    expect(readdirSync(dir).filter((n) => n.endsWith(".jsonl"))).toEqual([file]);
  });

  // These stop before any session is written, so none makes a folder private.
  it("says when there is nothing to continue or resume, or no such session, and that -r alone needs a terminal", () => {
    const { proj, data } = place();
    const env = { cwd: proj, TACHI_DATA_DIR: data };
    for (const [args, line] of [
      [["-p", "hi", "-c"], "No saved session to continue in this folder."],
      [["-r", "nope", "-p", "hi"], "No session named or numbered nope in this folder; tachi --resume lists them."],
      [["-r"], "tachi --resume needs a terminal to list sessions; give it a session's id or name."],
      [["-p", "hi", "-r"], "tachi --resume needs a terminal to list sessions; give it a session's id or name."],
    ] as const) {
      const r = tachi("--lead", "ollama:none", ...args, env);
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(`${line}\n`);
    }
  });

  it("opens a session by its name, sending its history", async () => {
    const { url, sent } = await standIn();
    const { proj, data, dir } = place();
    write(dir, "a1", [start("a1"), message("user", "first"), message("assistant", "one"), { t: "name", at, name: "the fix" }]);
    write(dir, "b2", [start("b2"), message("user", "second"), message("assistant", "two")]);
    const r = await tachiLater("-p", "next", "-r", "the fix", where(proj, data, url));
    expect(r).toMatchObject({ code: 0, stderr: "Resumed: the fix.\n" });
    expect(sent[0]!.messages).toEqual([
      { role: "system", content: "Saved prompt." },
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "next" },
    ]);
  });

  // The lock is held by this test's own process, which is running, so to the launch it is another window's.
  it("opens a copy of a session another window has open, saying so, and leaves the original as it was", async () => {
    const { url } = await standIn();
    const { proj, data, dir } = place();
    const file = write(dir, "held", [start("held"), message("user", "first"), message("assistant", "one")]);
    const before = readFileSync(file, "utf8");
    const lock = openSession(dir, "held");
    onTestFinished(() => lock?.release());
    const r = await tachiLater("-p", "next", "-r", "held", where(proj, data, url));
    expect(r).toMatchObject({ code: 0, stderr: "Opened a copy: that session is open in another window.\nResumed: first.\n" });
    expect(readFileSync(file, "utf8")).toBe(before);
    const copies = readdirSync(dir).filter((n) => n.endsWith(".jsonl") && n !== "held.jsonl");
    expect(copies).toHaveLength(1);
    expect(readFileSync(path.join(dir, copies[0]!), "utf8")).toContain('"next"');
  });

  it("with --fork-session, opens a copy and leaves the original as it was", async () => {
    const { url } = await standIn();
    const { proj, data, dir } = place();
    const file = write(dir, "orig", [start("orig"), message("user", "first"), message("assistant", "one")]);
    const before = readFileSync(file, "utf8");
    const r = await tachiLater("-p", "next", "-r", "orig", "--fork-session", where(proj, data, url));
    expect(r).toMatchObject({ code: 0, stderr: "Resumed: first.\n" });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir).filter((n) => n.endsWith(".jsonl"))).toHaveLength(2);
  });

  // TACHI_LEAD is not --lead, so the saved lead is tried first (release 8a design, "Resuming"). The stand-in refuses the
  // request, so the error log's row shows whose session it was.
  it("falls back to the launch's lead when the saved one is not set up, saying so, and logs under the resumed id", async () => {
    const { url, sent } = await standIn(400);
    const { proj, data, dir } = place();
    write(dir, "gone", [start("gone", "anthropic:claude-opus-5-5"), message("user", "first"), message("assistant", "one")]);
    const r = await tachiLater("-p", "next", "-r", "gone", where(proj, data, url));
    const line = "The session's lead, anthropic:claude-opus-5-5, is not set up (Set ANTHROPIC_API_KEY to use anthropic); openai:lead leads instead.";
    expect(r.stderr).toBe(`Resumed: first.\n${line}\nprovider: 400 the stand-in refused\n`);
    expect(sent).toHaveLength(1);
    const rows = readFileSync(projectFile("errors", proj, data), "utf8").trim().split("\n");
    expect(rows.map((row) => JSON.parse(row).session)).toEqual(["gone"]);
  });

  it("resumes a transcript with a torn last line, whose next lines are read whole afterwards", async () => {
    const { url, sent } = await standIn();
    const { proj, data, dir } = place();
    const torn = '{"t":"message","at":"2026-11-06T00:00:00.000Z","mess';
    const file = write(dir, "torn", [start("torn"), message("user", "first"), message("assistant", "one")], torn);
    const r = await tachiLater("-p", "next", "-r", "torn", where(proj, data, url));
    expect(r).toMatchObject({ code: 0, stderr: "Resumed: first.\n1 damaged lines of this session were skipped.\n" });
    expect(sent[0]!.messages.slice(1).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const read = readTranscript(file, path.join(dir, "torn", "pictures"));
    if ("problem" in read) throw new Error(read.problem);
    expect(read.damaged).toBe(1);
    expect(read.messages.map((m) => m.parts)).toEqual(["first", "one", "next", "done"].map((text) => [{ type: "text", text }]));
  });

  it("tells the model of a subagent that had not finished and of a call a crash left without its result", async () => {
    const { url, sent } = await standIn();
    const { proj, data, dir } = place();
    const call = { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "read_file", input: { path: "notes.txt" } }] };
    const subagent = { t: "subagent", at, id: "t1", description: "look around", file: "t1.jsonl" };
    write(dir, "crashed", [start("crashed"), message("user", "go"), { t: "message", at, message: call }, subagent]);
    const r = await tachiLater("-p", "next", "-r", "crashed", where(proj, data, url));
    expect(r.code).toBe(0);
    const request = texts(sent[0]!);
    expect(request).toContain("Outcome unknown: the session ended while this was running, or before its result was saved.");
    expect(request).toContain("Subagent t1 (look around) had not finished when the session ended; its answer was lost.");
    // Told now, so marked in its file, and not told again (user, 2026-11-06: "Report once").
    expect(readFileSync(path.join(dir, "crashed", "subagents", "t1.jsonl"), "utf8")).toContain('"state":"lost"');
  });

  // Release 8a plan, choice 4 (Task 6 spec review): a resume with another lead records it, so the next one opens with it.
  it("opens with the lead a resume's --lead last gave", { timeout: 30_000 }, async () => {
    const { url, sent } = await standIn();
    const { proj, data, dir } = place();
    write(dir, "s1", [{ ...start("s1"), print: true }, message("user", "first"), message("assistant", "one")]);
    expect((await tachiLater("-p", "next", "-r", "s1", "--lead", "openai:other", where(proj, data, url))).code).toBe(0);
    expect((await tachiLater("-p", "again", "-c", where(proj, data, url))).code).toBe(0);
    expect(sent.map((s) => (s as Sent & { model: string }).model)).toEqual(["other", "other"]);
  });

  // Task 6's quality review: a window cannot start without a terminal, so it is refused before a held session is copied.
  // The lock is this test process's own, as above.
  it("refuses -c without a terminal before copying a session another window has open", () => {
    const { proj, data, dir } = place();
    write(dir, "held", [start("held"), message("user", "first"), message("assistant", "one")]);
    const lock = openSession(dir, "held");
    onTestFinished(() => lock?.release());
    const r = tachi("--lead", "ollama:none", "-c", { cwd: proj, TACHI_DATA_DIR: data });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('Interactive mode needs a terminal; use -p "<prompt>" to run one prompt.\n');
    expect(readdirSync(dir).filter((n) => n.endsWith(".jsonl"))).toEqual(["held.jsonl"]);
  });

  // Release 8a design, "When something goes wrong": a session that cannot be read starts nothing. PATH is an empty folder
  // of the test's own, so a launch that went on to the sandbox would stop at its Docker step with Docker not installed;
  // no case here runs Docker.
  it("starts no sandbox for a session it cannot read", () => {
    const { proj, data, dir } = place();
    const empty = path.join(path.dirname(proj), "empty");
    mkdirSync(empty);
    const file = write(dir, "broken", [{ t: "not a start line" }]);
    const r = tachi("--lead", "ollama:none", "--sandbox", "copy", "-p", "hi", "-r", "broken", { cwd: proj, TACHI_DATA_DIR: data, PATH: empty, Path: empty });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`${file} could not be read as a session (its first line is missing or damaged).\n`);
    expect(existsSync(path.join(data, "copies"))).toBe(false);
    expect(readdirSync(dir)).toEqual(["broken.jsonl"]);
  });

  // Moved here from Task 5: the transcript's folder is a file of the test's own, inside its data folder, so the start
  // line cannot be written. The run still answers and ends as it did; the line is said alone.
  it("with -p, says the Saving fails line alone when the transcript cannot be written, and exits 0", async () => {
    const { url } = await standIn();
    const { proj, data, dir } = place();
    mkdirSync(path.dirname(dir), { recursive: true });
    writeFileSync(dir, "not a folder");
    const r = await tachiLater("--lead", "openai:lead", "-p", "hi", { cwd: proj, TACHI_DATA_DIR: data, OPENAI_API_KEY: "x", OPENAI_BASE_URL: url });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("done\n");
    const rest = "It cannot be resumed, and a conversation too long for the model will end with an error.";
    expect(r.stderr).toMatch(/^Saving this session stopped: .+\.jsonl could not be written \(.+\)\. /);
    expect(r.stderr.endsWith(`). ${rest}\n`)).toBe(true);
    expect(r.stderr.split("\n")).toHaveLength(2); // one line
    expect(r.stderr).toContain(dir);
  });

  it("lists -c, -r, -n and --fork-session in the help", () => {
    expect(tachi("--help").stdout).toContain(HELP_SESSIONS);
  });
});

// Release 7 plan, Task 16: live link's launch, in-process, with Docker a stand-in that records its calls and answers by
// them (choice 69), git's settings given, and the letter-case check (choice 104) and the submodules (choice 123) given, so
// no case here runs Docker or git.
describe("live link's launch, with a stand-in Docker", () => {
  afterEach(() => vi.unstubAllEnvs());
  type Answer = { code: number; out: string; err: string } | "missing";
  const ok = (out = ""): Answer => ({ code: 0, out, err: "" });
  const STEPS = [
    "home", "case", "missing", "stopped", "image", "git-throws", "git-missing", "submodules-throws",
    "submodules", "room", "limits", "start", "no-bash", "node-missing", "node-old",
  ] as const;
  type Step = (typeof STEPS)[number];
  // This PC's `docker info`, the parts read (executor.test.ts), with the limit flags given.
  const INFO = (more: Record<string, unknown> = {}) =>
    JSON.stringify({ NCPU: 24, MemTotal: 33518923776, SecurityOptions: [], MemoryLimit: true, CpuCfsQuota: true, PidsLimit: true, ...more });

  function stand(broken: Set<Step>, info = INFO()) {
    const calls: string[][] = [];
    const run: DockerRun = async (args) => {
      calls.push(args);
      if (broken.has("missing")) return "missing";
      const [verb] = args;
      if (verb === "version") return broken.has("stopped") ? { code: 1, out: "", err: "error during connect: the pipe is gone\n" } : ok("linux\n");
      if (verb === "image") return broken.has("image") ? { code: 1, out: "", err: "No such image\n" } : ok("sha256:0\n");
      if (verb === "info") return broken.has("room") ? { code: 1, out: "", err: "error during connect: busy\n" } : ok(`${info}\n`);
      if (verb === "run") return broken.has("start") ? { code: 125, out: "", err: "docker: Error response from daemon: invalid mount config.\n" } : ok("b0x\n");
      if (verb === "exec" && args.includes("/sys/fs/cgroup/memory.events")) return ok("oom_kill 0\n");
      if (verb === "exec" && args[1] === "-w") {
        if (args.at(-1)!.startsWith("curl")) return { code: 6, out: "", err: "" };
        // An image without bash (node:22-alpine): Docker's own words for the wrapper's bash.
        if (broken.has("no-bash")) return { code: 127, out: "", err: `${NO_BASH}
` };
        if (broken.has("node-missing")) return { code: 127, out: "", err: "bash: line 1: node: command not found\n" };
        return ok(broken.has("node-old") ? "v20.1.0 undefined" : "v24.22.2 function");
      }
      if (verb === "inspect") return ok("true\n");
      return ok();
    };
    return { run, calls };
  }

  // A project folder of the test's own, and the data folder beside it, or inside it for choice 13's step.
  // `made` adds to the project and the folder around it before the launch.
  async function launch(broken: Set<Step>, info?: string, network: Network = "off", made?: (top: string, root: string) => void) {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-box-"));
    onTestFinished(() => removeTree(top));
    const root = path.join(top, "project");
    mkdirSync(root);
    made?.(top, root);
    vi.stubEnv("TACHI_DATA_DIR", broken.has("home") ? path.join(root, "data") : path.join(top, "data"));
    const fake = stand(broken, info);
    const lines: string[] = [];
    const io = {
      out: (line: string) => lines.push(line),
      err: (line: string) => lines.push(line),
      signal: new AbortController().signal,
      run: fake.run,
      gitSettings: async () => {
        if (broken.has("git-throws")) throw new Error("git was ended by SIGKILL");
        return broken.has("git-missing") ? undefined : { files: [], hooksPaths: [], gitDirs: [], problems: [], lineEndings: {} };
      },
      ignoresCase: () => broken.has("case"),
      submodules: async () => {
        if (broken.has("submodules-throws")) throw new Error("git was ended by SIGKILL");
        return broken.has("submodules");
      },
    };
    const ready = await sandboxReady(root, io);
    if ("exit" in ready) return { root, exit: ready.exit, lines, calls: fake.calls, started: undefined };
    const limits = broken.has("limits") ? { cpus: 999 } : undefined;
    const started = await sandboxStart(root, ready, { network, limits, session: "s1" }, io);
    return { root, lines, calls: fake.calls, ...("exit" in started ? { exit: started.exit, started: undefined } : { exit: undefined, started }) };
  }

  const said = (step: Step, root: string): string =>
    ({
      home: `The sandbox cannot run on ${root}: it holds Tachikoma's data folder, which must never be in the box. Start Tachikoma in a project folder.`,
      missing: NOT_INSTALLED,
      stopped: NOT_RUNNING,
      image: NOT_BUILT,
      "git-throws": "Live link is refused: git's settings could not be read (git was ended by SIGKILL). Launch with --sandbox copy instead.",
      case:
        "Live link is refused: this folder ignores letter case, as Windows and macOS do by default, so the box could reach git's files by " +
        "another spelling. Launch with --sandbox copy instead.",
      "git-missing": "Live link needs git on this PC to read git's settings; use --sandbox copy, or install git.",
      "submodules-throws": "Live link is refused: git's settings could not be read (git was ended by SIGKILL). Launch with --sandbox copy instead.",
      submodules:
        "Live link is refused: this project has git submodules, whose git settings the box could change for git on your " +
        "machine to run. Launch with --sandbox copy instead.",
      room: "The sandbox could not read Docker's CPUs and memory: error during connect: busy",
      limits: 'settings.json: "sandboxLimits": "cpus" is 999, but Docker has 24 CPUs. Lower it, or give Docker more memory or CPUs.',
      start: "The sandbox could not start: docker: Error response from daemon: invalid mount config.",
      "no-bash": `The sandbox's image could not run Tachikoma's check in the box (${NO_BASH}). The box needs bash, util-linux's setsid and Node 22.5 or newer.`,
      "node-missing": "The sandbox's image has no node, which Tachikoma's file tools need in the box.",
      "node-old": "The sandbox's image has node v20.1.0, but Tachikoma's file tools need Node 22.5 or newer in the box.",
    })[step];

  // A Ctrl-C during the git step stops the launch as one during the image's does (image.ts, 128 + SIGINT's number), with
  // nothing more said, whether git was ended by it or had already answered.
  it("stops on a Ctrl-C during git's settings, saying nothing more", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "tachi-cli-box-"));
    onTestFinished(() => removeTree(root));
    vi.stubEnv("TACHI_DATA_DIR", path.join(tmpdir(), "tachi-cli-no-data"));
    for (const answered of [false, true]) {
      const stop = new AbortController();
      const lines: string[] = [];
      const fake = stand(new Set());
      const got = await sandboxReady(root, {
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
        signal: stop.signal,
        run: fake.run,
        ignoresCase: () => false,
        submodules: async () => false,
        gitSettings: async () => {
          stop.abort();
          if (!answered) throw new Error("git was ended by SIGINT");
          return { files: [], hooksPaths: [], gitDirs: [], problems: [], lineEndings: {} };
        },
      });
      expect(got).toEqual({ exit: 130 });
      expect(lines).toEqual([]);
    }
  });

  // Each step's refusal with that step and every later one broken, so each is said before all that follow.
  it("refuses in the launch order, each step before every later one, with exit 1", async () => {
    for (const [i, step] of STEPS.entries()) {
      const r = await launch(new Set(STEPS.slice(i)));
      expect(r.lines, step).toEqual([said(step, r.root)]);
      expect(r.exit, step).toBe(1);
    }
  });

  it("removes the box when the node check stops the launch", async () => {
    for (const step of ["no-bash", "node-missing", "node-old"] as const) {
      const r = await launch(new Set([step]));
      expect(r.calls.at(-1), step).toEqual(["rm", "-f", "b0x"]);
    }
  });

  it("asks Docker nothing before choice 13's refusal, and builds nothing headless", async () => {
    expect((await launch(new Set(["home"]))).calls).toEqual([]);
    expect((await launch(new Set(["image"]))).calls.some((c) => c[0] === "build")).toBe(false);
  });

  it("starts the box after the leftover boxes are removed, with live link's mounts and git settings, and says how", async () => {
    const r = await launch(new Set());
    expect(r.exit).toBeUndefined();
    const verbs = r.calls.map((c) => c[0]);
    expect(verbs.indexOf("ps")).toBeLessThan(verbs.indexOf("run"));
    const run = r.calls.find((c) => c[0] === "run")!;
    expect(run.slice(run.indexOf("--network"), run.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    expect(run).toContain("GIT_CONFIG_KEY_0=safe.directory");
    expect(run.slice(run.indexOf("--tmpfs"), run.indexOf("--tmpfs") + 2)).toEqual(["--tmpfs", "/work/.tachikoma"]);
    expect(run[run.indexOf("-v") + 1]).toBe(`${r.root}:/work`);
    expect(r.lines).toEqual([]);
    const started = r.started!;
    expect(started.lines).toEqual([`Sandbox: live link on ${r.root}, network off, limits 4g, 4 CPUs, 1024 processes.`]);
    expect([started.root, started.workspace.root]).toEqual(["/work", "/work"]);
    expect(started.system).toContain("The project root is /work.");
    expect(started.system).toContain("Shell commands run with bash on linux.");
    expect(started.subagentSystem).toContain("The project root is /work.");
    expect(started.gate).toEqual({ root: "/work", home: "/tmp", shell: "bash" });
    expect(started.shellTool.spec.description).toContain("with bash");
  });

  it("starts with the network on as bridge, saying so", async () => {
    const r = await launch(new Set(), undefined, "on");
    const run = r.calls.find((c) => c[0] === "run")!;
    expect(run.slice(run.indexOf("--network"), run.indexOf("--network") + 2)).toEqual(["--network", "bridge"]);
    expect(r.started!.lines[0]).toContain(", network on, ");
  });

  it("says each limit Docker cannot apply, after the launch line (choice 83)", async () => {
    const r = await launch(new Set(), INFO({ MemoryLimit: false, PidsLimit: false }));
    expect(r.started!.lines.slice(1)).toEqual([
      "Docker cannot limit the box's memory on this machine, so the box runs without that limit.",
      "Docker cannot limit the box's processes on this machine, so the box runs without that limit.",
    ]);
  });

  // Choice 107 (design, "Live link"): a .git file naming a git folder outside the project, which is not mounted, so git
  // does not work in the box; one naming a folder inside it, or a .git folder, says nothing.
  it("says when .git is a file naming a git folder outside the project", async () => {
    const line = "Git does not work in the box here: .git points to a git folder outside the project. Commit on this computer.";
    const pointing = (where: (top: string, root: string) => string) => (top: string, root: string) => {
      mkdirSync(where(top, root), { recursive: true });
      writeFileSync(path.join(root, ".git"), `gitdir: ${where(top, root)}
`);
    };
    const outside = await launch(new Set(), undefined, "off", pointing((top) => path.join(top, "main", ".git", "worktrees", "project")));
    expect(outside.started!.lines.slice(1)).toEqual([line]);
    const inside = await launch(new Set(), undefined, "off", pointing((_, root) => path.join(root, "repo.git")));
    expect(inside.started!.lines).toHaveLength(1);
    const folder = await launch(new Set(), undefined, "off", (_, root) => mkdirSync(path.join(root, ".git")));
    expect(folder.started!.lines).toHaveLength(1);
  });

  // Choice 21: with the network off, every failed command gets the line, as which failures were the network's cannot be told.
  it("adds the network line to a failed command's result with the network off, and not with it on", async () => {
    const line = "(The box's network is off, so nothing in it can reach the internet. To allow it, launch with --network on.)";
    const failing = async (network: Network) => {
      const r = await launch(new Set<Step>(), undefined, network);
      return r.started!.executor.exec("curl -sS http://example.invalid/", "/work");
    };
    expect((await failing("off")).stderr).toBe(line);
    expect((await failing("on")).stderr).toBe("");
  });
});

// Release 7 plan, Task 21: copy mode's launch, in-process, with Docker a stand-in as above, and git's settings given. The
// data folder is the test's, so the copy is made there; nothing runs Docker or git.
describe("copy mode's launch, with a stand-in Docker", () => {
  afterEach(() => vi.unstubAllEnvs());
  const ok = (out = "") => ({ code: 0, out, err: "" });
  const INFO = JSON.stringify({ NCPU: 24, MemTotal: 33518923776, SecurityOptions: [], MemoryLimit: true, CpuCfsQuota: true, PidsLimit: true });
  const LINE = /^Sandbox: copy of (.+) \(2 files, \d+\.\d s\), network off, limits 4g, 4 CPUs, 1024 processes\. Your folder is not touched until you review the changes\.$/;
  // Docker's words when the image has no git: the box's git runs as a docker exec of its own (DockerRun), with no shell.
  const NO_GIT = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "git": executable file not found in $PATH: unknown';
  const git = (...args: string[]) => ["exec", "-w", "/work", "b0x", "git", ...args];
  const COMMIT = git("-c", "user.name=Tachikoma", "-c", "user.email=tachikoma@localhost", "commit", "-q", "--allow-empty", "-m", "The project as Tachikoma copied it");

  // `broken`: "git" for git's settings that cannot be read on the host, "commit" for the box's git missing. `head`: the
  // text of a .git/HEAD made by hand in the project, which the snapshot leaves out; no .git when not given.
  async function launch(broken: "git" | "commit" | null = null, head?: string, abortAtCopy = false) {
    const top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-cli-copy-")));
    onTestFinished(() => removeTree(top));
    const root = path.join(top, "project");
    const elsewhere = path.join(top, "elsewhere");
    mkdirSync(path.join(root, ".husky"), { recursive: true });
    mkdirSync(elsewhere);
    writeFileSync(path.join(root, "a.txt"), "made-up text\n");
    writeFileSync(path.join(root, ".husky", "pre-commit"), "made-up hook\n");
    symlinkSync(elsewhere, path.join(root, "out"), "junction"); // a link to outside the project, left out of the copy
    if (head !== undefined) {
      mkdirSync(path.join(root, ".git"));
      writeFileSync(path.join(root, ".git", "HEAD"), head);
    }
    const data = path.join(top, "data");
    vi.stubEnv("TACHI_DATA_DIR", data);
    const calls: string[][] = [];
    const run: DockerRun = async (args) => {
      calls.push(args);
      const [verb] = args;
      if (verb === "version") return ok("linux\n");
      if (verb === "image") return ok("sha256:0\n");
      if (verb === "info") return ok(`${INFO}\n`);
      if (verb === "run") return ok("b0x\n");
      if (verb === "exec" && args.includes("/sys/fs/cgroup/memory.events")) return ok("oom_kill 0\n");
      if (verb === "exec" && args[4] === "git") return broken === "commit" ? { code: 127, out: "", err: `${NO_GIT}\n` } : ok();
      if (verb === "exec" && args[1] === "-w") return ok("v24.22.2 function"); // the node check
      if (verb === "inspect") return ok("true\n"); // the box still runs
      return ok();
    };
    const lines: string[] = [];
    const notes: string[] = [];
    const stop = new AbortController();
    const io = {
      out: (line: string) => lines.push(line),
      err: (line: string) => lines.push(line),
      // With `abortAtCopy`, a Ctrl-C as the copy starts, as cli.tsx's SIGINT listener aborts the launch's signal.
      note: (line: string) => (notes.push(line), abortAtCopy && stop.abort()),
      signal: stop.signal,
      run,
      gitSettings: async (r: string) => {
        if (broken === "git") throw new Error("git was ended by SIGKILL");
        return { files: [], hooksPaths: [path.join(r, "hooks")], gitDirs: [], problems: [], lineEndings: {} };
      },
      ignoresCase: () => {
        throw new Error("copy mode asks nothing about letter case (choice 104 is live link's)");
      },
      submodules: async () => {
        throw new Error("copy mode asks nothing about submodules (choice 123 is live link's)");
      },
    };
    const ready = await sandboxReady(root, io, { session: "s1" });
    if ("exit" in ready && !abortAtCopy) throw new Error(lines.join("\n"));
    if ("exit" in ready) return { top, root, data, lines, notes, calls, started: ready };
    const started = await sandboxStart(root, ready, { network: "off", limits: undefined, session: "s1" }, io);
    return { top, root, data, lines, notes, calls, started };
  }

  it("copies the project, mounts only the copy's work folder, makes it one commit, and says how", async () => {
    const r = await launch();
    expect(r.lines).toEqual([]);
    // The user's choice: a grey line while the folder is copied, naming it as the launch line does.
    expect(r.notes).toEqual([`Copying ${r.root} for the sandbox...`]);
    if ("exit" in r.started) throw new Error("the launch stopped");
    const folder = path.join(r.data, "copies", "s1");
    const work = path.join(folder, "work");
    expect(readFileSync(path.join(work, "a.txt"), "utf8")).toBe("made-up text\n");
    // Under its holding name: cli.tsx keeps the copy, naming it manifest.json, only once the session starts (dropOnExit).
    expect(JSON.parse(readFileSync(path.join(folder, "manifest.pending.json"), "utf8"))).toMatchObject({ session: "s1", pid: process.pid, root: r.root });
    expect(existsSync(path.join(folder, "manifest.json"))).toBe(false);
    expect(r.started.copy).toMatchObject({ folder, manifest: { session: "s1" } });
    // Nothing is made in the project: live link's .tachikoma is not needed here.
    expect(readdirSync(r.root).sort()).toEqual([".husky", "a.txt", "out"]);
    const runArgs = r.calls.find((c) => c[0] === "run")!;
    expect(runArgs.filter((a) => a === "-v")).toHaveLength(1);
    expect(runArgs[runArgs.indexOf("-v") + 1]).toBe(`${work}:/work`);
    expect(runArgs).not.toContain("--tmpfs");
    expect(runArgs).toContain("tachikoma.session=s1");
    expect(runArgs).toContain("GIT_CONFIG_KEY_0=safe.directory");
    // After the node check, the box makes /work a repository of one commit by Tachikoma (choice 24), each git run an
    // argument list of its own; with no branch on the host, git's own default.
    const execs = r.calls.filter((c) => c[0] === "exec" && c[1] === "-w");
    expect(execs[0]!.at(-1)).toMatch(/^node /);
    expect(execs.slice(1)).toEqual([git("init", "-q"), git("add", "-A"), COMMIT]);
    expect(r.started.lines[0]).toMatch(LINE);
    expect(LINE.exec(r.started.lines[0]!)![1]).toBe(r.root);
    expect(r.started.lines.slice(1)).toEqual(["Left out, never applied: out (a link that leads outside the project)"]);
    // The gate's protection is the box's view of git's paths, as in live link.
    expect(r.started.protection).toEqual({ hooks: ["/work/hooks"], files: [] });
    expect([r.started.root, r.started.workspace.root]).toEqual(["/work", "/work"]);
  });

  // The user's choice: the box's repository takes the host's branch, read as the status line reads it, given to git as
  // one word that cannot be an option. A detached HEAD, or a name outside git's plain letters, leaves git's default.
  it("names the box's branch after the host's, and leaves git's default where there is none to take", { timeout: 60_000 }, async () => {
    const init = async (head: string) => (await launch(null, head)).calls.find((c) => c[4] === "git" && c[5] === "init");
    expect(await init("ref: refs/heads/feature/made-up-1.2_x\n")).toEqual(git("init", "-q", "--initial-branch=feature/made-up-1.2_x"));
    for (const head of [
      "0123456789abcdef0123456789abcdef01234567\n", // detached
      "ref: refs/heads/-q\n",
      "ref: refs/heads/a..b\n",
      "ref: refs/heads/a b\n",
      "ref: refs/heads/x;y\n",
      "ref: refs/heads/topic.lock\n",
      "ref: refs/heads/a.lock/b\n", // git refuses .lock at the end of any part
      "ref: refs/heads/.hidden\n",
    ]) {
      expect(await init(head), head).toEqual(git("init", "-q"));
    }
  });

  // The quality review: Ctrl-C during the copy stops the snapshot at its next entry, and the launch ends as a Ctrl-C does,
  // saying nothing; the exit handler then removes the half-made copy.
  it("stops the copy on Ctrl-C, ending with 130, and the exit handler removes what was made", async () => {
    const r = await launch(null, undefined, true);
    expect(r.started).toEqual({ exit: 130 });
    expect(r.lines).toEqual([]);
    const folder = path.join(r.data, "copies", "s1");
    expect(existsSync(folder)).toBe(true);
    const proc = new EventEmitter();
    const said: string[] = [];
    dropOnExit(folder, proc, (line) => said.push(line));
    proc.emit("exit");
    expect(existsSync(folder)).toBe(false);
    expect(said).toEqual(["Removing the copy..."]); // half made, so no manifest to count
  });

  it("goes on with the fixed list when git's settings cannot be read, and says so", async () => {
    const r = await launch("git");
    expect(r.lines).toEqual(["git's settings could not be read (git was ended by SIGKILL); only the fixed list of protected paths applies"]);
    expect("exit" in r.started).toBe(false);
  });

  // The copy is removed by the launch's one cleanup at exit (dropOnExit, below), as cli.tsx ends the launch here.
  it("stops when the box cannot make its commit, removing the box", async () => {
    const r = await launch("commit");
    expect(r.started).toEqual({ exit: 1 });
    expect(r.lines).toEqual([`The sandbox could not make the copy a git repository in the box (${NO_GIT}).`]);
    expect(r.calls.at(-1)).toEqual(["rm", "-f", "b0x"]);
  });
});

// Task 21's review: a copy made at launch goes when the process ends before the session starts, however it ends (a
// refusal, Ctrl-C at a question or while the box starts), from one "exit" handler; once kept, it stays. Removing it can
// take a while, so a line says so first, counting the manifest's files as the review does (the user's words).
describe("dropOnExit", () => {
  it("removes the copy at exit, saying so first, never following a link out of it, until it is kept", () => {
    const top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-cli-drop-")));
    onTestFinished(() => removeTree(top));
    const outside = path.join(top, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "kept.txt"), "made-up\n");
    const made = (name: string) => {
      const folder = path.join(top, "copies", name);
      mkdirSync(path.join(folder, "work", "sub"), { recursive: true });
      writeFileSync(path.join(folder, "manifest.pending.json"), JSON.stringify({ entries: { sub: { type: "folder" }, "sub/a.txt": { type: "file" } } }));
      writeFileSync(path.join(folder, "work", "sub", "a.txt"), "made-up\n");
      symlinkSync(outside, path.join(folder, "work", "link"), "junction");
      return folder;
    };
    const proc = new EventEmitter();
    const said: string[] = [];
    const say = (line: string) => said.push(line);
    const dropped = made("s1");
    dropOnExit(dropped, proc, say);
    const kept = made("s2");
    dropOnExit(kept, proc, say)();
    dropOnExit(path.join(top, "copies", "never-made"), proc, say); // a snapshot that failed before making its folder
    proc.emit("exit");
    expect(said).toEqual(["Removing the copy (1 file)..."]);
    expect(existsSync(dropped)).toBe(false);
    // Kept, it takes its final name, so `tachi review` lists it from now on.
    expect(existsSync(path.join(kept, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(kept, "manifest.pending.json"))).toBe(false);
    expect(readFileSync(path.join(outside, "kept.txt"), "utf8")).toBe("made-up\n");
  });

  // The quality review: a removal that fails is said, with the review's line, so the folder can be deleted by hand.
  it("says when the copy could not be removed", () => {
    const top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-cli-drop-")));
    onTestFinished(() => removeTree(top));
    const folder = path.join(top, "copies", "s1");
    mkdirSync(folder, { recursive: true });
    const proc = new EventEmitter();
    const said: string[] = [];
    dropOnExit(folder, proc, (line) => said.push(line), () => {
      throw new Error("made-up failure");
    });
    proc.emit("exit");
    expect(said).toEqual(["Removing the copy...", `The copy could not be removed (made-up failure); delete ${folder} by hand.`]);
  });
});

// Task 21: the real command in copy mode with -p, end to end, with Docker a stand-in swapped in for src/sandbox/docker.ts
// by a resolve hook of the test's own (tests/standin), so no Docker is reached, no box is started and no program is
// planted. PATH is an empty folder, so nothing else is found either; the lead is a stand-in for OpenAI's chat completions
// served on the loopback address, which answers at once with no tool call.
describe("tachi in copy mode with -p, with a stand-in Docker", { timeout: 60_000 }, () => {
  // `change`: the lead's stand-in writes a file into the copy's work/ before it answers, as the box would.
  async function copyRun(standin: "ok" | "start-fails" | "stuck", change = false) {
    const top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-cli-e2e-")));
    onTestFinished(() => removeTree(top));
    const proj = path.join(top, "proj");
    const empty = path.join(top, "empty");
    const data = path.join(top, "data");
    mkdirSync(proj);
    mkdirSync(empty);
    writeFileSync(path.join(proj, "notes.txt"), "made-up notes\n");
    const server = http.createServer((req, res) => {
      req.resume().on("end", () => {
        if (change) for (const session of readdirSync(path.join(data, "copies"))) writeFileSync(path.join(data, "copies", session, "work", "new.txt"), "made-up\n");
        const message = { role: "assistant", content: "done" };
        const body = { id: "r", object: "chat.completion", created: 0, model: "lead", choices: [{ index: 0, finish_reason: "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      server.close();
      server.closeAllConnections();
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const env = { cwd: proj, PATH: empty, Path: empty, TACHI_DATA_DIR: data, OPENAI_API_KEY: "x", OPENAI_BASE_URL: url, TACHI_TEST_STANDIN_DOCKER: standin };
    const { argv, options } = launch(["--lead", "openai:lead", "--sandbox", "copy", "-p", "hi", env]);
    argv.splice(2, 0, "--import", pathToFileURL(path.resolve("tests/standin/register.mjs")).href); // after tsx's loader
    const child = spawn(process.execPath, argv, options);
    onTestFinished(() => void child.kill());
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.stdin.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, stdout, stderr, proj, copies: path.join(data, "copies") };
  }

  it("answers, then names the copy kept for review on stderr, keeping it and leaving the folder untouched", async () => {
    const r = await copyRun("ok", true);
    expect(r.stdout).toBe("done\n");
    expect(r.code).toBe(0);
    const lines = r.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe(`Copying ${r.proj} for the sandbox...`); // not a terminal, so not grey
    expect(lines[1]).toBe("Starting the sandbox...");
    expect(lines[2]).toMatch(/^Sandbox: copy of .+ \(1 file, \d+\.\d s\), network off, /);
    const [session] = readdirSync(r.copies);
    expect(lines.at(-1)).toBe(`Changes kept for review: tachi review ${session}`);
    expect(existsSync(path.join(r.copies, session!, "manifest.json"))).toBe(true);
    expect(readdirSync(r.proj)).toEqual(["notes.txt"]);
    // The plan's test: `tachi review` lists the copy kept.
    expect(tachi("review", { TACHI_DATA_DIR: path.dirname(r.copies) }).stdout).toContain(`  ${session}  ${r.proj}  `);
  });

  // Choice 121 (the user's): with nothing to review, the copy is removed, and said so in place of the kept line.
  it("removes the copy when the session changed nothing, saying so on stderr", async () => {
    const r = await copyRun("ok");
    expect(r.stdout).toBe("done\n");
    expect(r.code).toBe(0);
    const lines = r.stderr.trimEnd().split("\n");
    expect(lines.slice(-2)).toEqual(["Removing the copy (1 file)...", "Nothing changed in the copy, so it was removed."]);
    expect(readdirSync(r.copies)).toEqual([]);
    expect(readdirSync(r.proj)).toEqual(["notes.txt"]);
  });

  // As leave() says it in the interface (queue.ts): a box Docker still lists keeps the copy, which is not looked at.
  it("says the box could not be removed, then names the copy kept, when Docker still lists the box", async () => {
    const r = await copyRun("stuck");
    expect(r.code).toBe(0);
    const lines = r.stderr.trimEnd().split("\n");
    const [session] = readdirSync(r.copies);
    expect(lines.slice(-2)).toEqual(["The box could not be removed, so the copy was not reviewed.", `Changes kept for review: tachi review ${session}`]);
    expect(existsSync(path.join(r.copies, session!, "manifest.json"))).toBe(true);
  });

  it("removes the copy when the launch stops after it was made", async () => {
    const r = await copyRun("start-fails");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("The sandbox could not start: docker: Error response from daemon: made-up failure.");
    expect(readdirSync(r.copies)).toEqual([]);
  });
});

// Task 21: `tachi review` run as the real command, with no terminal, so the list and what refuses without one; opening and
// discarding are tested in-process (tests/sandbox/copies.test.ts), and with real Docker (tests/sandbox/copy.test.ts).
// Nothing here reaches Docker: the list never asks it, and the rest stop before.
describe("tachi review", { timeout: 15_000 }, () => {
  // A data folder holding one copy, s1, of a made-up project, made by hand as the snapshot leaves one, and none private.
  function dataWithCopy() {
    const top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-cli-review-")));
    onTestFinished(() => removeTree(top));
    const data = path.join(top, "data");
    const folder = path.join(data, "copies", "s1");
    for (const sub of ["base", "work"]) mkdirSync(path.join(folder, sub), { recursive: true });
    const manifest = { session: "s1", pid: 0, root: path.join(top, "project"), at: "2026-11-05T03:04:00.000Z", entries: {}, leftOut: [] };
    writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(path.join(folder, "work", "new.txt"), "made-up text\n");
    return { data, folder, root: manifest.root };
  }

  it("says when no copies are waiting", () => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-review-"));
    onTestFinished(() => removeTree(top));
    const r = tachi("review", { TACHI_DATA_DIR: path.join(top, "data") });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("No copies are waiting.\n");
  });

  it("lists the copies waiting", () => {
    const w = dataWithCopy();
    const r = tachi("review", { TACHI_DATA_DIR: w.data });
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Copies waiting for review (tachi review <name> opens one):");
    const d = new Date("2026-11-05T03:04:00.000Z"); // the manifest's, in this machine's time, as the child's
    const two = (n: number) => String(n).padStart(2, "0");
    const time = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
    expect(lines[1]).toBe(`  s1  ${w.root}  ${time}  1 change`);
  });

  it("names a copy that is not waiting", () => {
    const w = dataWithCopy();
    const r = tachi("review", "s2", { TACHI_DATA_DIR: w.data });
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe("No copy named s2 is waiting; tachi review lists them.");
  });

  it("opens and discards nothing without a terminal, saying why", () => {
    const w = dataWithCopy();
    for (const args of [["s1"], ["s1", "--discard"]]) {
      const r = tachi("review", ...args, { TACHI_DATA_DIR: w.data });
      expect(r.code).toBe(1);
      expect(r.stderr.trim()).toBe("tachi review s1 needs a terminal; with none, nothing is applied or discarded.");
      expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
    }
  });

  it("explains its usage", () => {
    const r = tachi("review", "s1", "--all");
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe("Usage: tachi review [<name> [--discard]]");
  });
});

// From Task 14's review: the write tools look at /work paths in the box, so the hooks folders and settings files git's
// settings name inside the project are given as the box sees them; those outside it the box cannot reach.
describe("boxProtection", () => {
  it("gives the project's protected paths as /work paths, leaving out those outside it", () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-cli-prot-")));
    const p = { hooks: [path.join(root, ".husky", "_"), path.join(tmpdir(), "elsewhere-hooks")], files: [path.join(root, "team.gitconfig")] };
    expect(boxProtection(root, p)).toEqual({ hooks: ["/work/.husky/_"], files: ["/work/team.gitconfig"] });
  });
});
