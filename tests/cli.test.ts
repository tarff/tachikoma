import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { onPath } from "../src/exec/env.js";

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
  return {
    argv: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, path.resolve("src/cli.tsx"), ...words],
    options: {
      cwd: env.cwd ?? top,
      env: { ...process.env, TACHI_LEAD: "", ANTHROPIC_API_KEY: "", TACHI_INSTRUCTIONS_TOP: top, USERPROFILE: home, HOME: home, CODEX_HOME: "", ...git, ...env },
    },
  };
}

// A pretend home folder holding ~/.tachikoma/settings.json, given to tachi() as its HOME and USERPROFILE.
function homeWith(settings: string) {
  const home = mkdtempSync(path.join(tmpdir(), "tachi-cli-home-"));
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
    expect(r.stderr).toMatch(/^settings\.json: "mode" must be one of: ask, project, auto \(got "x"\)/);
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

  // Release 7 plan, Task 7: until Task 21 builds the sandbox, asking for it stops the launch, never with copy mode too, so
  // never cannot start yet (choice 1). Eight starts.
  it("stops on --sandbox live or copy, from the flag or the settings file, as neither is built yet", { timeout: 60_000 }, () => {
    for (const how of ["live", "copy"]) {
      let r = tachi("--lead", "ollama:none", "--sandbox", how, "-p", "hi");
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(`--sandbox ${how} is not built yet\n`);
      r = tachi("--lead", "ollama:none", "-p", "hi", homeWith(`{"sandbox": "${how}"}`));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(`settings.json: "sandbox": ${how} is not built yet\n`);
    }
    let r = tachi("--lead", "ollama:none", "--sandbox", "copy", "--mode", "never", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("--sandbox copy is not built yet\n");
    r = tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"sandbox": "copy", "mode": "never"}'));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('settings.json: "sandbox": copy is not built yet\n');
    // A flag wins over the file, so --sandbox off starts.
    expect(tachi("--lead", "ollama:none", "--sandbox", "off", homeWith('{"sandbox": "copy"}')).stderr).toContain("Interactive mode needs a terminal; use -p");
    r = tachi("--lead", "ollama:none", "--sandbox", "x", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('--sandbox must be one of: off, live, copy (got "x")\n');
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
  // as below: the run gets as far as asking the model and fails there, with nothing sent anywhere.
  it("says at launch which kinds of the dangerous-command check are off, and nothing while none is", () => {
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
  // below: the run then gets as far as asking the model and fails there.
  it.skipIf(!onPath("git"))("says at launch when git's settings could not be read, and starts", () => {
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

  // Port 9, as above: the run gets as far as asking the model and fails there, with nothing sent anywhere.
  it("with -p, runs on the settings file's lead", () => {
    const r = tachi("-p", "hi", { ...homeWith('{"lead": "openai:none"}'), OPENAI_API_KEY: "x", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" });
    expect(r.stderr).toContain("Could not reach http://127.0.0.1:9/v1");
  });
});
