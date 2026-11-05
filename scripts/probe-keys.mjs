// Shows what this terminal sends for each key, so Shift+Enter's handling comes from what Windows Terminal really sends,
// not a guess (release 7 plan, Task 22). Not part of Tachikoma: run by hand, in the terminal being checked.
//
//   node scripts/probe-keys.mjs            the kitty keyboard protocol, asked for as Tachikoma's Ink does
//   node scripts/probe-keys.mjs --win32    Windows Terminal's win32 input mode instead, with bracketed paste
//
// It asks the terminal for the kitty protocol (`CSI ? u`) and waits Ink's 200 ms for the answer (Ink's ink.js,
// confirmKittySupport), printing the answer or "no answer"; with one, it turns the protocol on with the flags Ink uses
// (disambiguateEscapeCodes, 1). Then it prints the bytes of each read until Ctrl-C, and turns the mode off again.
const win32 = process.argv.includes("--win32");
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Run this in a terminal.");
  process.exit(2);
}

const show = (buf) =>
  [...buf.toString("latin1")].map((c) => {
    const n = c.charCodeAt(0);
    return n === 0x1b ? "ESC" : n < 0x20 || n === 0x7f ? `^${String.fromCharCode(n ^ 0x40)}` : c;
  }).join("");
const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ");

// Ctrl-C as each mode sends it: the plain byte, kitty's `CSI 99;5u` (c with Ctrl), or a win32 record whose character is
// 3 on key-down (`CSI Vk;Sc;3;1;Cs;Rc _`).
const isCtrlC = (s) => s.includes("\x03") || s.includes("\x1b[99;5u") || /\x1b\[\d+;\d+;3;1;\d+;\d+_/.test(s);

let off = "";
function end() {
  process.stdout.write(off);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  console.log("\r\nDone.");
}

process.stdin.setRawMode(true);
process.stdin.resume();

if (win32) {
  // With bracketed paste on too, as Tachikoma has it, so a paste comes as it would there.
  process.stdout.write("\x1b[?9001h\x1b[?2004h");
  off = "\x1b[?2004l\x1b[?9001l";
  console.log("win32 input mode and bracketed paste on. Press keys; Ctrl-C ends.\r");
  listen();
} else {
  let heard = Buffer.alloc(0);
  const onAnswer = (d) => (heard = Buffer.concat([heard, d]));
  process.stdin.on("data", onAnswer);
  process.stdout.write("\x1b[?u");
  setTimeout(() => {
    process.stdin.off("data", onAnswer);
    const answer = /\x1b\[\?\d*u/.exec(heard.toString("latin1"));
    console.log(`kitty query: ${answer ? show(Buffer.from(answer[0], "latin1")) : "no answer"}\r`);
    if (answer) {
      process.stdout.write("\x1b[>1u");
      off = "\x1b[<u";
      console.log("kitty protocol on (flags 1).\r");
    }
    console.log("Press keys; Ctrl-C ends.\r");
    listen();
  }, 200);
}

function listen() {
  process.stdin.on("data", (d) => {
    console.log(`${show(d)}    [${hex(d)}]\r`);
    if (isCtrlC(d.toString("latin1"))) end();
  });
}
