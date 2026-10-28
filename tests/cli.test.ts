import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Runs the real command through tsx, in a fresh project folder with a pretend home folder, and with
// the walk for instruction files starting at a fresh folder of its own, so no case reads the user's
// files. Every case here stops before any model answers.
function tachi(...args: (string | Record<string, string>)[]) {
  const env = args.find((a) => typeof a === "object") ?? {};
  const words = args.filter((a) => typeof a === "string");
  const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-"));
  const home = path.join(top, "home");
  mkdirSync(home);
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, path.resolve("src/cli.tsx"), ...words], {
    cwd: env.cwd ?? top,
    input: "x\n",
    encoding: "utf8",
    env: { ...process.env, TACHI_LEAD: "", ANTHROPIC_API_KEY: "", TACHI_INSTRUCTIONS_TOP: top, USERPROFILE: home, HOME: home, CODEX_HOME: "", ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
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

  it("stops on a broken settings file, with its problem", () => {
    let r = tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"mode": "x"}'));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^settings\.json: "mode" must be one of: ask, project, never \(got "x"\)/);
    r = tachi("--lead", "ollama:none", "-p", "hi", homeWith("{"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^settings\.json is not valid JSON: /);
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

  it("lets a flag win over the settings file", () => {
    const r = tachi("--lead", "ollama:none", "--mode", "project", homeWith('{"lead": "nope", "mode": "never"}'));
    expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
  });

  it("names the settings entry when a model it gives is bad", () => {
    expect(tachi("-p", "hi", homeWith('{"lead": "nope"}')).stderr).toMatch(/^settings\.json: "lead": Expected <provider>:<model>/);
    expect(tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"fallback": "nope"}')).stderr).toMatch(/^settings\.json: "fallback": Expected/);
    expect(tachi("--lead", "ollama:none", "-p", "hi", homeWith('{"worker": "nope"}')).stderr).toMatch(/^settings\.json: "worker": Expected/);
  });

  // Port 9, as above: the run gets as far as asking the model and fails there, with nothing sent anywhere.
  it("with -p, runs on the settings file's lead", () => {
    const r = tachi("-p", "hi", { ...homeWith('{"lead": "openai:none"}'), OPENAI_API_KEY: "x", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" });
    expect(r.stderr).toContain("Could not reach http://127.0.0.1:9/v1");
  });
});
