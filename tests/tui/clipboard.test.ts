import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Clipboard, DECODE, osc52, runTool, systemTool, type Tool } from "../../src/tui/clipboard.js";
import { system32 } from "../../src/exec/env.js";

// Each tool's process, so a test can see what runTool left open.
vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return { ...cp, spawn: vi.fn(cp.spawn) };
});
const lastChild = () => vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcess;

const TEXT = "tachikoma é 日本語 🦀";
const base64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("osc52", () => {
  it("is ESC ] 52 ; c ; the text's UTF-8 in base64, then BEL", () => {
    expect(osc52(TEXT)).toBe(`\u001b]52;c;${base64(TEXT)}\u0007`);
  });
});

describe("systemTool", () => {
  it("on Windows, hands base64 to PowerShell's input, decoded and given to Set-Clipboard", () => {
    const tool = systemTool("win32", {})!;
    expect(tool.command.toLowerCase()).toMatch(/powershell\.exe$/);
    expect(tool.args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; try { ${DECODE} | Set-Clipboard -ErrorAction Stop } ` +
        "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
    ]);
    expect(tool.input(TEXT)).toBe(base64(TEXT));
    expect(tool.name).toBe("Set-Clipboard");
  });

  it("on macOS is pbcopy, and on Linux wl-copy with Wayland, otherwise xclip with X, each given the text itself", () => {
    expect(systemTool("darwin", {})).toMatchObject({ command: "pbcopy", args: [], name: "pbcopy" });
    expect(systemTool("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toMatchObject({ command: "wl-copy", args: [], name: "wl-copy" });
    expect(systemTool("linux", { DISPLAY: ":0" })).toMatchObject({ command: "xclip", args: ["-selection", "clipboard"], name: "xclip" });
    expect(systemTool("darwin", {})!.input(TEXT)).toBe(TEXT);
  });

  it("is none on Linux with no display, as over SSH", () => {
    expect(systemTool("linux", {})).toBeNull();
  });

  it("is none elsewhere", () => {
    expect(systemTool("aix", {})).toBeNull();
  });

  // DECODE alone, without Set-Clipboard, so the user's clipboard is not touched.
  it.runIf(process.platform === "win32")("on Windows, DECODE gives the text back from its base64", { timeout: 15_000 }, () => {
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${DECODE}`;
    const out = execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: base64(TEXT),
      encoding: "utf8",
    });
    expect(out.replace(/\r?\n$/, "")).toBe(TEXT);
  });

  // The tool's own script with Get-Item where Set-Clipboard is, failing on a path that does not exist, so the failure
  // path runs without touching the user's clipboard.
  it.runIf(process.platform === "win32")("on Windows, reports a failure in one line, in UTF-8, without the cmdlet's name", { timeout: 15_000 }, async () => {
    const tool = systemTool("win32", {})!;
    const stand = { ...tool, args: tool.args.map((a) => a.replace("Set-Clipboard", "Get-Item")) };
    expect(stand.args.join(" ")).not.toContain("Set-Clipboard");
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-clipboard-"));
    try {
      const missing = path.join(dir, "missing é 日本");
      await expect(runTool(stand)(missing)).rejects.toThrow(`Set-Clipboard failed: Cannot find path '${missing}' because it does not exist.`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runTool", () => {
  const node = (script: string): Tool => ({ command: process.execPath, args: ["-e", script], input: (t) => `${t}!`, name: "stand-in" });

  it("rejects with \"<name> not found\" for a command that does not exist", async () => {
    const tool: Tool = { command: "tachikoma-no-such-tool-7f3a", args: [], input: (t) => t, name: "xclip" };
    await expect(runTool(tool)("x")).rejects.toThrow(/^xclip not found$/);
  });

  it("gives the tool its input, and rejects with the first line of its stderr when it fails", async () => {
    const want = Buffer.from(`${TEXT}!`).toString("hex");
    const check =
      `let s=[];process.stdin.on("data",(d)=>s.push(d)).on("end",()=>{` +
      `const h=Buffer.concat(s).toString("hex");if(h!=="${want}"){console.error("got "+h);process.exit(1)}})`;
    await expect(runTool(node(check))(TEXT)).resolves.toBeUndefined();
    await expect(runTool(node(check))("other")).rejects.toThrow(/^stand-in failed: got /);
    const fails = node(`process.stdin.resume();console.error("no display\\nmore");process.exit(2)`);
    await expect(runTool(fails)("x")).rejects.toThrow(/^stand-in failed: no display$/);
  });

  // 4 MB: far more than a pipe holds (64 KB on Linux, pipe(7)), so the write is still going when the tool exits.
  const big = "x".repeat(4 * 1024 * 1024);

  it("is done when a tool exits with 0 without reading its input", async () => {
    await expect(runTool(node("process.exit(0)"))(big)).resolves.toBeUndefined();
  });

  it("reports a tool that fails without reading its input by its stderr", async () => {
    await expect(runTool(node(`process.stderr.write("boom\\n",()=>process.exit(3))`))(big)).rejects.toThrow(/^stand-in failed: boom$/);
  });

  // xclip and wl-copy leave a process behind that holds the clipboard and keeps the tool's stderr open; that pipe would
  // keep Tachikoma running after its last work until another program took the clipboard.
  it("leaves nothing open when a tool exits with 0 and leaves a process of its own behind", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-clipboard-"));
    const pidFile = path.join(dir, "helper.pid");
    // 30 s: longer than the test, so only the kill below ends the helper.
    const script =
      `const h=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],` +
      `{detached:true,stdio:["ignore","ignore","inherit"]});require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(h.pid));h.unref()`;
    try {
      await runTool(node(script))("x");
      expect(lastChild().stderr!.destroyed).toBe(true);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")));
      } catch {} // the helper did not start, or has gone
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A stand-in tool whose runs end when the test says, and one log of everything in order.
function standIn() {
  const log: string[] = [];
  const runs = new Map<string, { end: () => void; fail: (why: string) => void }>();
  const run = (text: string) => {
    log.push(`run ${text}`);
    return new Promise<void>((resolve, reject) => {
      runs.set(text, {
        end: () => {
          log.push(`end ${text}`);
          resolve();
        },
        fail: (why) => {
          log.push(`fail ${text}`);
          reject(new Error(why));
        },
      });
    });
  };
  const write = (s: string) => {
    expect(s.startsWith("\u001b]52;c;") && s.endsWith("\u0007")).toBe(true);
    log.push(`write ${Buffer.from(s.slice(7, -1), "base64").toString("utf8")}`); // 7: ESC ] 52 ; c ;
  };
  const reports: string[] = [];
  const clipboard = new Clipboard(write, run, (p) => reports.push(p));
  return { log, runs, clipboard, reports };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Clipboard", () => {
  it("runs one copy at a time, and only the newest of those made meanwhile, with OSC 52 written for each at once", async () => {
    const { log, runs, clipboard, reports } = standIn();
    clipboard.copy("A");
    clipboard.copy("B");
    clipboard.copy("C");
    expect(log).toEqual(["write A", "run A", "write B", "write C"]);
    runs.get("A")!.end();
    await settle();
    runs.get("C")!.end();
    await settle();
    expect(log.filter((l) => l.startsWith("run"))).toEqual(["run A", "run C"]);
    expect(log.at(-1)).toBe("end C");
    expect(log.filter((l) => l.startsWith("write")).slice(0, 3)).toEqual(["write A", "write B", "write C"]);
    expect(reports).toEqual([]);
  });

  it("reports a failure only when its copy is still the newest", async () => {
    const { runs, clipboard, reports } = standIn();
    clipboard.copy("A");
    clipboard.copy("C");
    runs.get("A")!.fail("xclip failed: A");
    await settle();
    expect(reports).toEqual([]);
    runs.get("C")!.fail("xclip failed: C");
    await settle();
    expect(reports).toEqual(["xclip failed: C"]);
  });

  it("writes the newest copy's OSC 52 again when an older run ends, before the newest's own run (the review, 2026-10-27)", async () => {
    const { log, runs, clipboard, reports } = standIn();
    clipboard.copy("A");
    clipboard.copy("B");
    runs.get("A")!.end(); // the stand-in clipboard now holds A
    await settle();
    runs.get("B")!.fail("Set-Clipboard failed: no");
    await settle();
    expect(log).toEqual(["write A", "run A", "write B", "end A", "write B", "run B", "fail B"]);
    expect(reports).toEqual(["Set-Clipboard failed: no"]);
    expect(log.filter((l) => l.startsWith("write")).at(-1)).toBe("write B"); // a terminal that takes OSC 52 holds B
  });

  it("with no tool, writes OSC 52 alone, reports nothing, and says it copies with the terminal only", () => {
    const writes: string[] = [];
    const reports: string[] = [];
    const clipboard = new Clipboard((s) => writes.push(s), null, (p) => reports.push(p));
    clipboard.copy("A");
    clipboard.copy("B");
    expect(writes).toEqual([osc52("A"), osc52("B")]);
    expect(reports).toEqual([]);
    expect(clipboard.terminalOnly).toBe(true);
    expect(standIn().clipboard.terminalOnly).toBe(false);
  });
});
