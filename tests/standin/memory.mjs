// The stand-in memory for the real command (register.mjs; 8d plan, step 27): the memory module of the build the start
// runs (cleanup plan, step 14d), as any importer resolves it, becomes this module, which takes that module's other
// exports from the same build, at the address TACHI_TEST_BUILD gives, and is the real Memory given what
// TACHI_TEST_MEMORY (JSON) names, so a whole
// launch reaches only the stand-ins: the stand-in uv (tests/standin/uv.mjs) as `uv`, or none without it; every program
// memory starts by its full path started with Node, after the stand-in Python's script (`python`) for Tachikoma's own
// palace, or with `args` after it for the user's own MemPalace; the test's model server (`model`); the hub's figures
// (`figures`); and, with `lastSave`, a shorter limit for the exit's last save. With `signal` ({ file, name }), a file
// whose existence stands for a signal: the process is sent that signal's event once, as a terminal's Ctrl-C reaches
// -p or a kill signal reaches Tachikoma, which Windows cannot send a child.
// Memory not switched off without TACHI_TEST_MEMORY is refused, loudly, so no launch reaches the real uv on PATH or a
// real MemPalace (the user's choice after step 27's review).
import { existsSync } from "node:fs";

const built = await import(new URL("memory/memory.js", process.env.TACHI_TEST_BUILD).href);
const Real = built.Memory;

export const { NO_UV } = built;

const given = process.env.TACHI_TEST_MEMORY ? JSON.parse(process.env.TACHI_TEST_MEMORY) : undefined;

if (given?.signal) {
  const timer = setInterval(() => {
    if (!existsSync(given.signal.file)) return;
    clearInterval(timer);
    process.emit(given.signal.name, given.signal.name);
  }, 20);
  timer.unref();
}

export class Memory extends Real {
  constructor(o) {
    if (!given && o.memory !== "off") {
      throw new Error("tests/standin/memory.mjs: TACHI_TEST_MEMORY is not set; a launch with memory needs it");
    }
    const node = process.execPath;
    super(
      given
        ? {
            ...o,
            uv: given.uv ? { command: node, args: [given.uv] } : null,
            launch: (file) => ({
              command: node,
              args: given.python ? [given.python, file] : [file, ...(given.args ?? [])],
            }),
            ...(given.model && { model: given.model }),
            ...(given.figures && { figures: given.figures }),
          }
        : o,
    );
  }

  close(o) {
    return super.close(given?.lastSave && o.save ? { ...o, save: { ...o.save, limit: given.lastSave } } : o);
  }
}
