import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  Clipboard,
  DECODE,
  GET_IMAGE,
  imagePaths,
  imageReader,
  osc52,
  pictureFile,
  type Reader,
  readImage,
  runTool,
  systemTool,
  type Tool,
} from "../../src/tui/clipboard.js";
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

// A 1×1 PNG, made for these tests; it never comes from the clipboard.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const tempFolder = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tachi-pictures-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Release 6 plan, choice 11. Only the command lines are checked: no test reads the user's clipboard.
describe("imageReader", () => {
  it("on Windows, reads the picture through Windows Forms in PowerShell under -STA, writing it as PNG in base64", () => {
    const reader = imageReader("win32", {})!;
    expect(reader.command).toBe(system32("WindowsPowerShell/v1.0/powershell.exe"));
    expect(reader.args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; try { Add-Type -AssemblyName System.Windows.Forms, System.Drawing; " +
        `$img = ${GET_IMAGE}; if ($img) { $ms = New-Object IO.MemoryStream; $img.Save($ms, [Drawing.Imaging.ImageFormat]::Png); ` +
        "[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray())) } } " +
        "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
    ]);
    expect(GET_IMAGE).toBe("[Windows.Forms.Clipboard]::GetImage()");
    expect(reader.name).toBe("PowerShell");
    expect(reader.output(Buffer.from(PNG.toString("base64")))).toEqual(PNG);
  });

  it("on macOS asks osascript for the clipboard as PNG, which answers in hex, a failed coercion (-1700) caught", () => {
    const reader = imageReader("darwin", {})!;
    expect(reader).toMatchObject({
      command: "osascript",
      args: ["-e", "try", "-e", "get the clipboard as «class PNGf»", "-e", "on error number -1700", "-e", "end try"],
      name: "osascript",
    });
    expect(reader.output(Buffer.from(`«data PNGf${PNG.toString("hex").toUpperCase()}»\n`, "utf8"))).toEqual(PNG);
    expect(reader.output(Buffer.from("\n"))).toEqual(Buffer.alloc(0));
  });

  it("on Linux is wl-paste with Wayland, otherwise xclip with X, each asked for PNG and giving its bytes as they are", () => {
    const wayland = imageReader("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })!;
    expect(wayland).toMatchObject({ command: "wl-paste", args: ["--type", "image/png"], name: "wl-paste" });
    const x = imageReader("linux", { DISPLAY: ":0" })!;
    expect(x).toMatchObject({ command: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"], name: "xclip" });
    expect(wayland.output(PNG)).toEqual(PNG);
    expect(x.output(PNG)).toEqual(PNG);
  });

  it("is none on Linux with no display, and elsewhere", () => {
    expect(imageReader("linux", {})).toBeNull();
    expect(imageReader("aix", {})).toBeNull();
  });

  // The reader's own script with a picture made in PowerShell, or none, where the clipboard is read, so the script's
  // writing of the PNG runs without touching the user's clipboard.
  it.runIf(process.platform === "win32")("on Windows, writes a picture as PNG in base64, and nothing for no picture", { timeout: 15_000 }, async () => {
    const reader = imageReader("win32", {})!;
    const instead = (with_: string): Reader => ({ ...reader, args: reader.args.map((a) => a.replace(GET_IMAGE, with_)) });
    const made = instead("(New-Object Drawing.Bitmap 3, 2)");
    expect(made.args.join(" ")).not.toContain("Clipboard");
    const read = await readImage(made);
    expect(read).toMatchObject({ mediaType: "image/png" });
    const data = (read as { data: Buffer }).data;
    // The PNG signature's 8 bytes, then the IHDR chunk's length and type (4 each), then its width and height (PNG
    // specification, "PNG signature" and "IHDR Image header").
    expect(data.subarray(0, 8)).toEqual(PNG.subarray(0, 8));
    expect([data.readUInt32BE(16), data.readUInt32BE(20)]).toEqual([3, 2]);
    expect(await readImage(instead("$null"))).toBe("none");
  });
});

describe("readImage", () => {
  // A stand-in for a reader: a Node script in the test's own folder, its output read as Windows' reader reads its own.
  const standIn = (script: string): Reader => {
    const file = path.join(tempFolder(), "reader.mjs");
    writeFileSync(file, script);
    return { command: process.execPath, args: [file], output: imageReader("win32", {})!.output, name: "stand-in" };
  };

  it("gives the PNG the tool writes", async () => {
    await expect(readImage(standIn(`process.stdout.write(${JSON.stringify(PNG.toString("base64"))})`))).resolves.toEqual({ mediaType: "image/png", data: PNG });
  });

  it("is none when the tool writes nothing", async () => {
    await expect(readImage(standIn(""))).resolves.toBe("none");
  });

  it("fails with the first line of the tool's stderr, or its exit code, when it exits with another", async () => {
    await expect(readImage(standIn(`console.error("no access\\nmore"); process.exit(2)`))).resolves.toEqual({ failed: "stand-in failed: no access" });
    await expect(readImage(standIn("process.exit(3)"))).resolves.toEqual({ failed: "stand-in failed: exit code 3" });
  });

  it("fails as not found for a command that does not exist", async () => {
    const reader: Reader = { command: "tachikoma-no-such-tool-7f3a", args: [], output: (b) => b, name: "xclip" };
    await expect(readImage(reader)).resolves.toEqual({ failed: "xclip not found" });
  });

  // The real tools are not run: each stand-in writes the tool's own words, from its source (clipboard.ts, imageReader),
  // and exits with 1, as each does.
  const linux = (env: NodeJS.ProcessEnv, stderr: string): Reader => ({
    ...standIn(`process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`),
    none: imageReader("linux", env)!.none,
  });
  const WAYLAND = { WAYLAND_DISPLAY: "wayland-0" };
  const X = { DISPLAY: ":0" };

  it.each([
    "Nothing is copied\n",
    "No selection\n",
    "No suitable type of content copied\n",
    'Clipboard content is not available as requested type "image/png"\n' +
      'Use "wl-paste --list-types" to view available types.\n',
  ])("is none when wl-paste says the clipboard holds no PNG: %j", async (stderr) => {
    await expect(readImage(linux(WAYLAND, stderr))).resolves.toBe("none");
  });

  it.each([
    "Error: target image/png not available\n",
    "xclip: Error: There is no owner for the CLIPBOARD selection\n",
    "xclip: Error: Firefox cannot convert CLIPBOARD selection to target 'image/png'\n",
  ])("is none when xclip says the clipboard holds no PNG: %j", async (stderr) => {
    await expect(readImage(linux(X, stderr))).resolves.toBe("none");
  });

  it("still fails for anything else either tool says, and for those words from another tool", async () => {
    const failed = (why: string) => ({ failed: `stand-in failed: ${why}` });
    const wrong = [
      [WAYLAND, "Failed to connect to a Wayland server"],
      [WAYLAND, "Nothing is copied here"],
      [X, "Error: target image/jpeg not available"],
      [X, "Nothing is copied"],
    ] as const;
    for (const [env, why] of wrong) await expect(readImage(linux(env, `${why}\n`))).resolves.toEqual(failed(why));
    const noPatterns = { ...linux(X, "Nothing is copied\n"), none: undefined };
    await expect(readImage(noPatterns)).resolves.toEqual(failed("Nothing is copied"));
  });

  it("is none when osascript answers nothing, as after the caught -1700", async () => {
    const reader = { ...standIn('process.stdout.write("\\n")'), output: imageReader("darwin", {})!.output };
    await expect(readImage(reader)).resolves.toBe("none");
  });
});

// Release 6 design, "From pasted paths".
describe("imagePaths", () => {
  it("takes a path with or without quotes, a Windows one with spaces included", () => {
    expect(imagePaths(`"C:\\Users\\me\\My Pictures\\shot one.png"`)).toEqual(["C:\\Users\\me\\My Pictures\\shot one.png"]);
    expect(imagePaths("'/home/me/a b.webp'")).toEqual(["/home/me/a b.webp"]);
    expect(imagePaths("/home/me/a.gif")).toEqual(["/home/me/a.gif"]);
  });

  it("takes several, one a line, any letter case, blanks around them and blank lines left out", () => {
    expect(imagePaths("/a/one.PNG\r\n  \"/b/two.jpg\"  \n\n/c/three.jpeg\n")).toEqual(["/a/one.PNG", "/b/two.jpg", "/c/three.jpeg"]);
  });

  it("is null when any line is not a path to a picture, or there is none", () => {
    expect(imagePaths("/a/one.png\n/b/notes.txt")).toBeNull();
    expect(imagePaths("look at this")).toBeNull();
    expect(imagePaths("/a/one.png.txt")).toBeNull();
    expect(imagePaths(" \n ")).toBeNull();
  });

  it("on macOS and Linux, undoes a dragged path's backslashes, a doubled one left as one", () => {
    expect(imagePaths("/Users/me/My\\ Pic.png", "darwin")).toEqual(["/Users/me/My Pic.png"]);
    expect(imagePaths("/home/me/a\\\\b\\ c.png", "linux")).toEqual(["/home/me/a\\b c.png"]);
  });

  it("on Windows, keeps every backslash, as a path's separator", () => {
    expect(imagePaths("C:\\Users\\me\\pic.png", "win32")).toEqual(["C:\\Users\\me\\pic.png"]);
    expect(imagePaths("C:\\Users\\me\\My\\ Pic.png", "win32")).toEqual(["C:\\Users\\me\\My\\ Pic.png"]);
  });

  it("on macOS and Linux, keeps the backslashes of a Windows path, as WSL gives it", () => {
    expect(imagePaths("C:\\Users\\me\\pic.png", "linux")).toEqual(["C:\\Users\\me\\pic.png"]);
    expect(imagePaths('"C:\\x y\\a.png"', "linux")).toEqual(["C:\\x y\\a.png"]);
    expect(imagePaths("\\\\server\\share\\a.png", "linux")).toEqual(["\\\\server\\share\\a.png"]);
  });

  it("takes several on a line, split at spaces outside quotes and escapes, as a drag of several writes them", () => {
    const mac = ["/Users/me/My Pic.png", "/Users/me/b.png"];
    expect(imagePaths("/Users/me/My\\ Pic.png /Users/me/b.png ", "darwin")).toEqual(mac);
    expect(imagePaths("'/home/me/a b.png' '/home/me/c.png' ", "linux")).toEqual(["/home/me/a b.png", "/home/me/c.png"]);
    expect(imagePaths('"C:\\x y\\a.png" "C:\\b.png"', "win32")).toEqual(["C:\\x y\\a.png", "C:\\b.png"]);
    expect(imagePaths("C:\\a.png C:\\b.jpg", "win32")).toEqual(["C:\\a.png", "C:\\b.jpg"]);
    expect(imagePaths("a.png b.png", "linux")).toEqual(["a.png", "b.png"]);
    expect(imagePaths("a.png b.png", "win32")).toEqual(["a.png", "b.png"]);
  });

  it("takes a whole line with spaces as one path when its words are not all pictures", () => {
    expect(imagePaths("C:\\My Pictures\\a.png", "win32")).toEqual(["C:\\My Pictures\\a.png"]);
    expect(imagePaths("/home/me/a b.png", "linux")).toEqual(["/home/me/a b.png"]);
    // One path, which App finds is no file, so the paste stays text.
    expect(imagePaths("look at a.png", "linux")).toEqual(["look at a.png"]);
  });

  it("is null when the words are not all pictures and the line is no picture; words run together are one", () => {
    expect(imagePaths("a.png notes.txt", "linux")).toBeNull();
    expect(imagePaths('"/a/b.png" notes', "darwin")).toBeNull();
    expect(imagePaths('"/a/one.png""/b/two.png"', "linux")).toEqual(['/a/one.png""/b/two.png']);
    expect(imagePaths('"C:\\a.png" "C:\\b.txt"', "win32")).toBeNull();
  });
});

describe("pictureFile", () => {
  // The first bytes of each format, then a few more: PNG specification, "PNG signature"; ITU-T T.81 (JPEG), Table
  // B.1 (SOI) and B.1.1.2 (each marker starts with X'FF'); GIF89a specification, "17. Header"; RFC 9649 (WebP), "RIFF
  // Header".
  const KINDS = [
    ["image/png", PNG],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])],
    ["image/gif", Buffer.from("GIF87a\u0001\u0000", "latin1")],
    ["image/gif", Buffer.from("GIF89a\u0001\u0000", "latin1")],
    ["image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")])],
  ] as const;

  it.each(KINDS)("takes %s from the file's first bytes, not its name", async (mediaType, data) => {
    const file = path.join(tempFolder(), "named.png");
    writeFileSync(file, data);
    await expect(pictureFile(file)).resolves.toEqual({ mediaType, data });
  });

  it("fails for a file that is none of them, and for one it cannot read", async () => {
    const dir = tempFolder();
    const text = path.join(dir, "notes.png");
    writeFileSync(text, "hello");
    await expect(pictureFile(text)).resolves.toEqual({ failed: "not a PNG, JPEG, GIF or WebP picture" });
    const missing = path.join(dir, "missing.png");
    await expect(pictureFile(missing)).resolves.toEqual({ failed: `ENOENT: no such file or directory, open '${missing}'` });
  });

  // Near misses: JPEG's SOI with no marker after it, and a RIFF file that is not WebP (a WAVE sound).
  it.each([
    ["FF D8 00", Buffer.from([0xff, 0xd8, 0x00, 0xe0])],
    ["RIFF, 4 bytes, WAVE", Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WAVEfmt ")])],
  ])("fails for a file starting %s", async (_, data) => {
    const file = path.join(tempFolder(), "near.png");
    writeFileSync(file, data);
    await expect(pictureFile(file)).resolves.toEqual({ failed: "not a PNG, JPEG, GIF or WebP picture" });
  });
});
