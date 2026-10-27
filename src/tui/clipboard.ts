// Copying (release 5 design, "Copying"): Tachikoma sends OSC 52 and also runs the system's own tool, as it cannot tell
// whether the terminal took the OSC 52.
import { spawn } from "node:child_process";
import { errorText } from "../core/types.js";
import { commandEnv, system32 } from "../exec/env.js";

export const osc52 = (text: string): string => `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;

export interface Tool {
  command: string;
  args: string[];
  input: (text: string) => string;
  name: string;
}

// PowerShell's part that turns the base64 on its input back into text. Exported so a test can run it alone, without
// Set-Clipboard, leaving the user's clipboard as it was.
export const DECODE = "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))";

// The system's tool (release 5 plan, choice 8). On Windows the text goes to Set-Clipboard through PowerShell's input,
// base64-encoded, so no command line limit applies and no console code page can change it; PowerShell is named by its
// full path, so a program of the same name earlier on PATH is not run instead (exec/env.ts, system32). A failure is
// written as its message alone: PowerShell's own report starts with the cmdlet's name and is cut at the console's
// width. It is written in UTF-8, as runTool reads stderr, so a message in another language stays readable.
export function systemTool(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Tool | null {
  const text = (t: string) => t;
  if (platform === "win32") {
    const set = `try { ${DECODE} | Set-Clipboard -ErrorAction Stop } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    return {
      command: system32("WindowsPowerShell/v1.0/powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${set}`],
      input: (t) => Buffer.from(t, "utf8").toString("base64"),
      name: "Set-Clipboard",
    };
  }
  if (platform === "darwin") return { command: "pbcopy", args: [], input: text, name: "pbcopy" };
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) return { command: "wl-copy", args: [], input: text, name: "wl-copy" };
    return { command: "xclip", args: ["-selection", "clipboard"], input: text, name: "xclip" };
  }
  return null;
}

// One run of the tool with the text on its input. It is done when the tool exits with 0, without waiting for its output
// to close: xclip and wl-copy leave a process of their own behind holding the clipboard, which keeps their stderr open,
// so it is closed on Tachikoma's side, or the open pipe would keep Tachikoma running after its last work until another
// program took the clipboard. A tool that fails has not left one, so its stderr is read to the end for the reason.
export function runTool(tool: Tool): (text: string) => Promise<void> {
  return (text) =>
    new Promise((resolve, reject) => {
      const child = spawn(tool.command, tool.args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true, env: commandEnv() });
      let stderr = "";
      child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(new Error(err.code === "ENOENT" ? `${tool.name} not found` : `${tool.name} failed: ${err.message}`));
      });
      child.on("exit", (code) => {
        if (code !== 0) return;
        child.stderr!.destroy();
        resolve();
      });
      child.on("close", (code, signal) => {
        const why = stderr.trim().split(/\r?\n/)[0] || (code === null ? `stopped by ${signal}` : `exit code ${code}`);
        if (code !== 0) reject(new Error(`${tool.name} failed: ${why}`));
      });
      // A tool that ends before reading all its input, or never starts, breaks the pipe; its exit says what happened.
      child.stdin!.on("error", () => {});
      child.stdin!.end(tool.input(text));
    });
}

// The newest copy wins (release 5 design): OSC 52 is written at once, so the terminal gets copies in order. The tool runs
// one copy at a time; a copy made while one runs waits, replacing any copy already waiting. A run that ends after a newer
// copy was made has just put older text on the clipboard, so the newest copy's OSC 52 is written again at once, before
// its own run. A failure is reported only for the newest copy.
export class Clipboard {
  #write: (s: string) => void;
  #run: ((text: string) => Promise<void>) | null;
  #report: (problem: string) => void;
  #running = false;
  #waiting: string | null = null;
  #copies = 0;

  constructor(write: (s: string) => void, run: ((text: string) => Promise<void>) | null, report: (problem: string) => void) {
    this.#write = write;
    this.#run = run;
    this.#report = report;
  }

  copy(text: string): void {
    this.#write(osc52(text));
    if (this.#run === null) return this.#report("no clipboard tool for this system");
    this.#copies++;
    if (this.#running) this.#waiting = text;
    else this.#start(this.#run, text);
  }

  #start(run: (text: string) => Promise<void>, text: string): void {
    const copy = this.#copies;
    this.#running = true;
    // The next copy runs even when the report throws.
    run(text)
      .catch((err: unknown) => {
        if (copy === this.#copies) this.#report(errorText(err));
      })
      .finally(() => this.#ended(run));
  }

  #ended(run: (text: string) => Promise<void>): void {
    this.#running = false;
    const next = this.#waiting;
    if (next === null) return;
    this.#waiting = null;
    this.#write(osc52(next));
    this.#start(run, next);
  }
}
