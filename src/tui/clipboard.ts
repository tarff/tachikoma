// Copying (release 5 design, "Copying"): Tachikoma sends OSC 52 and also runs the system's own tool, as it cannot tell
// whether the terminal took the OSC 52.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { errorText } from "../core/types.js";
import { commandEnv, system32 } from "../exec/env.js";
import type { Picture, Read } from "./pictures.js";

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
  // Linux with no display, as over SSH, has no clipboard of its own to set: the terminal's OSC 52 alone copies (the
  // user's choice, 2026-10-27).
  if (platform === "linux" && env.WAYLAND_DISPLAY) return { command: "wl-copy", args: [], input: text, name: "wl-copy" };
  if (platform === "linux" && env.DISPLAY) return { command: "xclip", args: ["-selection", "clipboard"], input: text, name: "xclip" };
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

// A reader of the clipboard's picture (release 6 design, "Pictures"): its command, and how its output becomes the PNG's
// bytes.
export interface Reader {
  command: string;
  args: string[];
  output: (out: Buffer) => Buffer;
  name: string;
}

// Where the Windows reader reads the clipboard. Exported so a test can put a picture of its own in its place, leaving
// the user's clipboard unread.
export const GET_IMAGE = "[Windows.Forms.Clipboard]::GetImage()";

// The system's reader (release 6 plan, choice 11), each asking for PNG. Windows as the release 6 probe read it: Windows
// PowerShell 5.1 by its full path, as systemTool's, under -STA, as Windows Forms' Clipboard works only on a thread in
// that mode (.NET's Clipboard class docs), the PNG written as base64, as text, with nothing written for no picture; a
// failure is written as its message alone, as systemTool's is. macOS's osascript answers with the data in AppleScript's
// own form, «data PNGf» and the bytes in hex. Linux as systemTool chooses its tool.
export function imageReader(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Reader | null {
  if (platform === "win32") {
    const read =
      `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $img = ${GET_IMAGE}; if ($img) { $ms = New-Object IO.MemoryStream; ` +
      "$img.Save($ms, [Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray())) }";
    return {
      command: system32("WindowsPowerShell/v1.0/powershell.exe"),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; try { ${read} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
      ],
      output: (out) => Buffer.from(out.toString("latin1"), "base64"),
      name: "PowerShell",
    };
  }
  const bytes = (out: Buffer) => out;
  if (platform === "darwin") {
    const output = (out: Buffer) => Buffer.from(/PNGf([0-9a-f]*)/i.exec(out.toString("latin1"))?.[1] ?? "", "hex");
    return { command: "osascript", args: ["-e", "get the clipboard as «class PNGf»"], output, name: "osascript" };
  }
  if (platform === "linux" && env.WAYLAND_DISPLAY) return { command: "wl-paste", args: ["--type", "image/png"], output: bytes, name: "wl-paste" };
  const xclip = ["-selection", "clipboard", "-t", "image/png", "-o"];
  if (platform === "linux" && env.DISPLAY) return { command: "xclip", args: xclip, output: bytes, name: "xclip" };
  return null;
}

// One run of the reader: the PNG it gives (each reader asks for PNG, imageReader), "none" when it gives nothing, or why
// it failed, in runTool's words. It never throws, so every read ends in one of these (pictures.ts, Pictures.set).
export function readImage(tool: Reader): Promise<Read> {
  return new Promise((resolve) => {
    const child = spawn(tool.command, tool.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: commandEnv() });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ failed: err.code === "ENOENT" ? `${tool.name} not found` : `${tool.name} failed: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      const why = stderr.trim().split(/\r?\n/)[0] || (code === null ? `stopped by ${signal}` : `exit code ${code}`);
      if (code !== 0) return resolve({ failed: `${tool.name} failed: ${why}` });
      const data = tool.output(Buffer.concat(out));
      resolve(data.length ? { mediaType: "image/png", data } : "none");
    });
  });
}

// A paste that is only paths to pictures, one a line, with or without quotes (release 6 design, "From pasted paths"):
// the paths, or null. Whether the files are there is the caller's to ask.
export function imagePaths(paste: string): string[] | null {
  const lines = paste
    .split(/\r\n?|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => /^(["'])(.*)\1$/.exec(l)?.[2] ?? l);
  return lines.length && lines.every((l) => /\.(png|jpe?g|gif|webp)$/i.test(l)) ? lines : null;
}

const startsWith = (data: Buffer, at: number, bytes: number[] | string) => {
  const b = Buffer.from(bytes);
  return data.subarray(at, at + b.length).equals(b);
};

// A picture's type from its first bytes: PNG specification, "PNG signature"; ITU-T T.81 (JPEG), Table B.1's SOI marker
// X'FFD8', then another marker, each starting with X'FF' (B.1.1.2); GIF89a specification, "17. Header"; RFC 9649
// (WebP), "RIFF Header": "RIFF", the size's 4 bytes, then "WEBP".
function typeOf(data: Buffer): Picture["mediaType"] | null {
  if (startsWith(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(data, 0, "GIF87a") || startsWith(data, 0, "GIF89a")) return "image/gif";
  if (startsWith(data, 0, "RIFF") && startsWith(data, 8, "WEBP")) return "image/webp";
  return null;
}

// The picture in a file a paste named, its type from its first bytes, not its name (release 6 plan, Task 15). It never
// throws, as readImage.
export async function pictureFile(file: string): Promise<Read> {
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch (err) {
    return { failed: errorText(err) };
  }
  const mediaType = typeOf(data);
  return mediaType ? { mediaType, data } : { failed: "not a PNG, JPEG, GIF or WebP picture" };
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

  // With no tool for this system, OSC 52 alone copies, which is not a problem to report: the App says so in its own words
  // (the user's choice, 2026-10-27).
  get terminalOnly(): boolean {
    return this.#run === null;
  }

  copy(text: string): void {
    this.#write(osc52(text));
    if (this.#run === null) return;
    this.#copies++;
    if (this.#running) this.#waiting = text;
    else this.#start(this.#run, text);
  }

  #start(run: (text: string) => Promise<void>, text: string): void {
    const copy = this.#copies;
    this.#running = true;
    // A report that throws still lets the queue move on; the throw itself is left to surface.
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
