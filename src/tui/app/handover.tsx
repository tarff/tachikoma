import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderToString, Text } from "ink";
import { settingsDir, shownFile } from "../../settings.js";
import type { Fns } from "../App.js";
import type { Line } from "../describe.js";
import { type Detail, opened } from "../DetailView.js";
import { change } from "../editor.js";
import { editFile, editorCommand, editText, NOT_FOUND } from "../external.js";
import { readOut } from "../input.js";
import { spansIn } from "../pictures.js";
import { PASTE_OFF, PASTE_ON } from "../terminal.js";
import { ERASE_LINE, FROM, type Printed, WAITING } from "./constants.js";
import type { UI } from "./state.js";

export const handover = (ui: UI, fns: Fns) => {
  // The detail view opens over the conversation, though not over a question, which closes it (bindAsk, App.tsx): what a
  // key read before a question is first drawn asks for is said in the conversation instead. Opening and closing clear
  // the selection, which belongs to the other pane's lines, and end a drag, a grab of the bar and a run of clicks.
  const unselect = () => {
    ui.selection.current = null;
    ui.held.current = null;
    ui.grab.current = null;
    ui.lastPress.current = null;
  };
  const openDetail = (lines: Line[]) => {
    if (ui.questions.current.length) return fns.say(...lines);
    ui.detail.current = opened(lines, ui.frame.current.columns - 1); // as last drawn, for a turn started before a resize
    fns.unselect();
    ui.rerender((n) => n + 1);
  };
  const closeDetail = () => {
    if (!ui.detail.current) return;
    ui.detail.current = null;
    fns.unselect();
  };
  // `[` prints the view into the normal scrollback, for the terminal's own search, selecting and scrolling (release 5
  // design, "The detail view"; release 5 plan, Task 13). Raw mode is held on throughout, as Ink's suspend would turn it
  // off, which left the Windows console reading whole lines (design, "Switching during a session"). The mouse goes off
  // before Ink is suspended and the second screen after, as `leave` orders them; the view's lines are drawn by Ink's
  // own renderToString at the terminal's width, with their colours (release 5 plan, choice 13), without the search's or
  // the selection's reverse colours, and the selection is cleared, as opening and closing clear it. An empty line is
  // drawn as a space, as an empty Text takes no row, and without a colour, whose codes would keep the space at the
  // line's end. Then the keys go to a reader of the App's own: q, Esc or Ctrl-C come back, other keys do nothing. Ink's
  // suspend turns the kitty keyboard protocol off, so q comes as q, and bracketed paste, which is turned on again, so a
  // paste comes marked and does nothing (the user's choice, release 5). Meanwhile the work goes on, and nothing is
  // drawn, as Ink drops every render while suspended. A question that arrived while going out brings the view back at
  // once.
  const printOut = async (d: Detail) => {
    const p: Printed = {};
    ui.printed.current = p;
    fns.unselect();
    p.handover = ui.owner.take();
    ui.screen.setMouse(false);
    const { resume } = await p.handover.suspend();
    if (ui.printed.current !== p) return; // Ink ended meanwhile, and the cleanup in App.tsx let the keyboard go
    ui.screen.setSecond(false);
    ui.screen.suspended = true;
    const page = d.rows.lines.map((l, i) => (
      <Text key={i} color={l.text ? l.color : undefined} wrap={l.oneLine ? "truncate-end" : "wrap"}>
        {l.text || " "}
      </Text>
    ));
    ui.screen.write(`${renderToString(<>{page}<Text color="gray">Printed. q, Esc or Ctrl-C to go back.</Text></>, { columns: ui.columns })}\n`);
    ui.screen.write(PASTE_ON);
    p.resume = resume;
    ui.input!.divert(fns.reader);
    if (ui.questions.current.length) await fns.comeBack();
  };
  // What a read does is readOut's (input.ts). Keys after the one that comes back are dropped: Ink is not reading again
  // until it resumes.
  const reader = (keys: string) => {
    const p = ui.printed.current;
    if (!p) return;
    const read = readOut(p.paste, keys);
    p.paste = read.paste;
    if (read.back) void fns.comeBack();
  };
  // Coming back undoes going out in reverse; bracketed paste goes off as Ink's suspend left it, and Ink's resume turns it on
  // again. A paste still coming in, when a question or the key coming back brought the view back, is dropped up to its
  // end before keys reach Ink, so a y in it never answers a question, nor a pasted q closes the view (the user's choice,
  // release 5); what follows its end marker in the same read goes with it. A `[` read once Ink reads keys again, before
  // its drawing is done, prints the view out again, and that print-out keeps the hold and what waits. So does a switch
  // a /screen sent then started (Ctrl+O closing the view, then the prompt, in one read): its own ending lets go, as
  // letting go in its middle would let Ink's suspend turn raw mode off.
  const comeBack = async () => {
    const p = ui.printed.current;
    if (!p?.resume) return;
    ui.printed.current = null;
    if (p.paste === undefined) ui.input!.divert(null);
    else {
      ui.dropping.current = p;
      ui.input!.divert((keys) => {
        p.paste = readOut(p.paste, keys).paste;
        if (p.paste !== undefined) return;
        ui.dropping.current = null;
        ui.input!.divert(null);
      });
    }
    ui.screen.write(PASTE_OFF);
    ui.screen.setSecond(true);
    ui.screen.setMouse(true);
    ui.screen.suspended = false;
    await p.resume();
    p.handover!.done(); // also when Ink ended meanwhile, after its cleanup let go: again is harmless (input.ts, hold)
    if (ui.printed.current) return;
    // Ink ending during the resume (a crash in its redraw) starts nothing that waited: no screen would show it, and a
    // turn would go on paying with none.
    if (ui.ended.current) return;
    const list = ui.waitingList.current;
    ui.waitingList.current = null;
    if (list) ui.setPicker(list);
    fns.next();
  };
  // /screen (release 5 design, "The two modes"; release 5 plan, Task 14), in the orders the user's check settled, with
  // raw mode held on throughout, as Ink's suspend and resume would turn it off and on (release 5 plan, "Before you
  // start"). Like a turn, it holds the queue while it runs, so what is sent meanwhile, another /screen too, waits for
  // it. What the mouse was doing (a selection, a held button, a grab of the bar, a run of clicks, the wheel's carried
  // fraction) belongs to the screen before, and goes.
  // To classic: the detail view closes, as a queued /screen can run while it is open; nothing is drawn, and once React
  // has drawn that, Ink is suspended, the screen left and Ink resumed, so its redraw draws nothing on the normal
  // screen; then <Static> mounts and prints the whole conversation (release 5 plan, choice 17). The mode is classic
  // from the start, nothing being drawn meanwhile, so a key read then (Ctrl+O, a scroll key) acts as in classic mode.
  // The wait matters for a /screen run from the queue: set outside any key, its state is drawn only later, by React's
  // scheduler, and without the wait Ink's resume would draw the full-screen frame again on the normal screen.
  // To full screen: the view is given the lines said in classic mode, wrapped at the width it is drawn at, so not
  // wrapped again at its first drawing, and the mode is full from then on, so a question asked while the switch runs
  // keeps its detail's place and is brought to it; Ink is suspended, the second screen entered, and once React has
  // drawn the full-screen frame, Ink resumes and draws it there, never the classic frame. Ink drops every render while
  // suspended, so nothing is drawn before. `full` follows only once the second screen is on, so React draws no
  // full-screen frame on the normal screen; `fullNow` is set just before the suspend, so the keys Ink read with the
  // Enter that sent /screen, which it handles next, act as in full screen: a Ctrl+O among them opens the detail view. A
  // `[` does nothing while `owner.suspended`, from the suspend to the resume, either way, as it would suspend Ink
  // again, which throws. The view follows the bottom: sending /screen, or the queue running it, put it there, and
  // nothing moves it in classic mode. What the switch says at the end is said, not shown, so a question asked meanwhile
  // keeps the view on its detail.
  // If Ink ends meanwhile (a render error), nothing more is switched, the terminal being put back as it is then
  // (terminal.ts, restoreWhenInkEnds), and the keyboard is let go, so raw mode goes off and the process can end. A `[`
  // read while Ink resumes, before its drawing is done, keeps the hold, as in comeBack. Should the suspend throw going
  // to full screen, the mode goes back to classic, as the screen is (perform says why); `switching` ends however the
  // switch does. A switch the settings file asked for (`file`) says so; /screen's own saves nothing (choice 26).
  const switchScreen = async (file = false) => {
    const toFull = !ui.fullNow.current;
    ui.working.current = true;
    const handover = ui.owner.take();
    fns.unselect();
    ui.wheel.current = 0;
    try {
      if (toFull) {
        const width = ui.frame.current.columns - 1; // one column short, as in state.ts
        if (ui.kept.width !== width) ui.kept.setWidth(width);
        ui.kept.add(ui.unkept.current);
        ui.unkept.current = [];
        ui.fullNow.current = true;
        const { resume } = await handover.suspend();
        if (ui.ended.current) return;
        ui.screen.enter();
        ui.setFull(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (ui.ended.current) return;
        await resume();
      } else {
        fns.closeDetail();
        ui.fullNow.current = false;
        ui.setFull(false);
        ui.setSwitching(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (ui.ended.current) return;
        const { resume } = await handover.suspend();
        ui.screen.leave();
        await resume();
      }
    } finally {
      if (toFull && !ui.screen.full) ui.fullNow.current = false; // the suspend threw, or Ink ended first
      ui.setSwitching(false);
      ui.working.current = false;
      handover.done(); // a print-out started during the switch keeps the hold (comeBack, above)
    }
    if (ui.ended.current) return;
    (file ? fns.note : fns.say)({ text: `screen is now ${toFull ? "full" : "classic"}${file ? FROM : ""}`, color: "gray" });
  };

  // The editor in the terminal (release 6 design, "The external editor"; plan, Task 12), through the owner, which waits
  // for a hand-over under way, suspends Ink and lets go of the keyboard (owner.ts, program). Full screen steps aside as
  // for `[` (printOut, comeBack): the mouse and the second screen go, with the selection, and come back before Ink
  // resumes, unless Ink ended meanwhile and the terminal was put back. They go once the program's turn comes, as a
  // switch it waited for may have changed the screen. Meanwhile Ink drops every render, the turn goes on, and a
  // question waits; both show on return. The editor is read as it starts, so a live edit of "editor" applies from the
  // next one. In classic mode the lines said meanwhile reach <Static> only once Ink has resumed: it counts as printed
  // what a render Ink drops held, so they would never be printed.
  // While the editor runs, one line says what Tachikoma waits for (choice 33, the user's: "Say Ctrl-C too", then "Say
  // Tachikoma (Recommended)", as an editor such as `code --wait` may act on Ctrl-C itself), as an editor in its own
  // window leaves the terminal showing only the screen from before. Git's editor.c (launch_specified_editor, read
  // 2026-10-30) writes its hint just before it starts the editor, ending in a space with no line break, and erases it
  // with "\r\x1b[K" (pager.c, term_clear_line) once the editor has exited, succeeded or not; it does not when the
  // editor could not be started, nor when it died of Ctrl-C or Ctrl-\, which Git then raises itself. Tachikoma writes
  // its line once the terminal is handed over, cut to a row, and erases it in the same way every time the editor
  // returns, so an editor in the terminal leaves its screen and the frame Ink draws again as they were. A command the
  // shell cannot find still starts the shell, whose own error is printed after the line, on its row, and ends with a
  // line break, so the erase clears the row below it: the line and the shell's error stay on the normal screen, and
  // Tachikoma says the editor was not found once it is back. A resize while the editor is open can leave part of the
  // line, as with Git. Written straight to the terminal, never said, so it is in no printed output nor <Static>. Git's
  // dumb-terminal case (a line break, nothing erased) is not followed: Ink's frame needs the same codes.
  const away = async <T,>(edit: (command: string) => Promise<T>) => {
    try {
      return await ui.owner.program(async () => {
        const full = ui.screen.full;
        fns.unselect();
        if (full) ui.screen.leave();
        else ui.printUpTo.current = ui.nextId.current;
        ui.screen.suspended = true;
        const command = editorCommand(process.env, ui.fileNow.current.editor, process.platform);
        // Cut to the width the App draws at, a column short, so it never wraps onto a row the erase leaves.
        ui.screen.write(WAITING.slice(0, Math.max(0, ui.frame.current.columns - 1)));
        try {
          return { command, got: await edit(command) };
        } finally {
          ui.screen.write(ERASE_LINE);
          if (full && !ui.ended.current) ui.screen.enter();
          ui.screen.suspended = false;
        }
      });
    } finally {
      ui.printUpTo.current = null;
      ui.rerender((n) => n + 1);
    }
  };
  // The one line for an editor that failed or was not found, naming how to set one (design, "On return").
  const editorFailed = (command: string, failed: string) => {
    const why = failed === NOT_FOUND ? `${command} was not found` : `The editor failed (${failed})`;
    fns.say({ text: `${why}. Set VISUAL or EDITOR, or "editor" in ${shownFile()}.`, color: "red" });
  };
  // Ctrl+G and Ctrl+X Ctrl+E: the prompt as it is when the editor starts goes to it, and what it saved becomes the
  // prompt, the cursor at the end, as one step Ctrl+Z takes back; on failure the prompt stays (design, "On return").
  // Then the queue goes on: a /screen, /settings or /keybindings may have waited for the editor (next, queue.ts).
  const externalEditor = async () => {
    const ids = ui.editor.current.spans.map((s) => s.id); // the pictures the prompt holds as the editor opens
    const ran = await fns.away((command) => editText(ui.editor.current.text, command));
    if (!ran) return; // Ink ended meanwhile
    if ("failed" in ran.got) fns.editorFailed(ran.command, ran.got.failed);
    else {
      const e = ui.editor.current;
      // A marker is a span again when it names a picture the prompt held as the editor opened (release 6 design,
      // "Which pictures a message carries"): the editor's file is plain text.
      const d = change(e, 0, e.text.length, ran.got.text);
      ui.editor.current = { ...d, spans: spansIn(d.text, ids) };
      ui.goal.current = null;
      fns.freshText();
      ui.rerender((n) => n + 1);
    }
    fns.next();
  };
  // /settings and /keybindings open the real file, so each save reaches the watcher while the editor is still open
  // (plan, Task 12). A missing one is made first, `blank` in two-space JSON (choice 2), with a private file's mode,
  // 0o600 (auth/private.ts, writePrivate), never over one made meanwhile.
  const openFile = async (name: string, blank: object) => {
    const file = path.join(settingsDir(ui.home), name);
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      writeFileSync(file, `${JSON.stringify(blank, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const ran = await fns.away((command) => editFile(file, command));
    if (ran && "failed" in ran.got) fns.editorFailed(ran.command, ran.got.failed);
  };
  return {
    unselect, openDetail, closeDetail, printOut, reader, comeBack, switchScreen, away, editorFailed, externalEditor,
    openFile,
  };
};
