import path from "node:path";
import type { Fns } from "../App.js";
import { pictureFile } from "../clipboard.js";
import { cutPicture, type Editor, insertPicture } from "../editor.js";
import { type Draft, marker, messageParts, trimmed, without } from "../pictures.js";
import { fromClipboard } from "./constants.js";
import type { UI } from "./state.js";

export const pictureReads = (ui: UI, fns: Fns) => {
  // A message's parts, once the reads of its pictures have ended (release 6 plan, Task 14): the wait is part of its
  // turn, so Enter meanwhile queues as during a turn. A read that found nothing or failed takes its spans out of the
  // message (settle, below), which goes without it (choice 17). Any stop of the turn during the wait (Ctrl-C in the
  // detail view) ends the reads as stopped, and the turn then stops as usual; at the prompt, Esc and Ctrl-C end only
  // the reads (promptKey, keyRouting.ts).
  const readsEnded = async (message: Draft, signal: AbortSignal) => {
    const ids = new Set(message.spans.filter((s) => ui.pictures.get(s.id) === "reading").map((s) => s.id));
    if (!ids.size) return messageParts(message, ui.pictures);
    ui.reading.current = message;
    signal.addEventListener("abort", fns.stopReads);
    try {
      // Each picture's own settle, set when its number was taken, runs first (newPicture, below).
      await Promise.all([...ids].map((id) => ui.pictures.settled(id)));
      return messageParts(trimmed(ui.reading.current), ui.pictures); // trimmed again, as a marker taken out may leave a blank at an end
    } finally {
      ui.reading.current = null;
      signal.removeEventListener("abort", fns.stopReads);
    }
  };
  const stopReads = () => {
    for (const s of ui.reading.current?.spans ?? []) ui.pictures.set(s.id, { failed: "stopped" }); // a read that ended stays as it ended
  };
  // A read has ended (release 6 design, "While a read runs"). With no picture, its marker goes from wherever it is: the
  // prompt, the stash, the draft Up keeps, the prompt Ctrl+R gives back, the queue and the message waiting on it; and
  // one line says so, naming the marker when that message goes without it (plan, choice 17), in Task 15's words. A
  // failed read names where it read from: the clipboard, or a pasted path (`from`).
  const settle = (id: number, from = "the clipboard") => {
    const read = ui.pictures.get(id);
    if (read !== "none" && !(typeof read === "object" && "failed" in read)) return;
    ui.editor.current = cutPicture(ui.editor.current, id); // what Ctrl+K and the rest took too (editor.ts)
    const v = ui.vim.current; // and vim's register, so p puts none back (found at the combined review)
    const r = v && without(v.register, id);
    if (v && r) ui.vim.current = { ...v, register: { ...v.register, text: r.text, spans: r.spans } };
    const s = ui.stash.current;
    if (s) {
      const prompt = cutPicture(s.prompt, id);
      const walk = s.step && { ...s.step, draft: without(s.step.draft, id) };
      ui.stash.current = prompt === s.prompt || prompt.text.trim() || walk?.draft.text.trim() ? { prompt, step: walk } : null;
    }
    if (ui.step.current) ui.step.current = { ...ui.step.current, draft: without(ui.step.current.draft, id) };
    if (ui.search.current) ui.search.current.before = cutPicture(ui.search.current.before, id);
    ui.queue.current = ui.queue.current.map((d) => without(d, id)).filter((d) => d.text.trim());
    const waits = ui.reading.current?.spans.some((x) => x.id === id);
    if (ui.reading.current) ui.reading.current = without(ui.reading.current, id);
    // A message that was only pictures, left empty, sends nothing (session.ts, send).
    const ending = !waits ? "" : ui.reading.current!.text.trim() ? `; ${marker(id)} was sent without it.` : "; nothing was sent.";
    const why = read === "none" ? "No picture on the clipboard" : `Could not read ${from}: ${read.failed}`;
    fns.say({ text: ending ? why + ending : read === "none" ? `${why}.` : why, color: read === "none" ? "gray" : "red" });
  };
  // A new picture's number, its read running, with settle set to run when the read ends, and the hint row drawn again,
  // as "Reading picture..." shows while any read runs (release 6 design, "Pictures"). Every read starts here: Alt+V's
  // and a pasted path's, whose `from` names it.
  const newPicture = (from?: string) => {
    const id = ui.pictures.next();
    ui.reads.current++;
    void ui.pictures.settled(id).then(() => {
      ui.reads.current--;
      ui.drawn.latest.current.settle(id, from);
      ui.rerender((n) => n + 1);
    });
    return id;
  };
  // chat:imagePaste: the next picture's marker at the cursor at once, so pictures keep the order they were asked for,
  // and the picture filled in under its number when the read ends, wherever the marker is by then (design, "While a
  // read runs"). With no reader, as on Linux with no display (clipboard.ts, imageReader), no marker goes in (plan,
  // Task 15).
  const imagePaste = (e: Editor) => {
    const read = ui.readPicture === undefined ? fromClipboard() : ui.readPicture;
    if (!read) return fns.say({ text: "No clipboard reader here: install wl-paste or xclip.", color: "red" });
    const id = fns.newPicture();
    ui.editor.current = insertPicture(e, id);
    ui.goal.current = null;
    void read().then((r) => ui.pictures.set(id, r));
  };
  // A paste of paths to picture files that are all there becomes those pictures, read as Alt+V's are, each failure
  // naming its path as pasted (release 6 design, "From pasted paths"). A path not absolute is taken in the project, as
  // the tools take one.
  const pastePictures = (files: string[]) => {
    for (const file of files) {
      const id = fns.newPicture(file);
      ui.editor.current = insertPicture(ui.editor.current, id);
      void pictureFile(path.resolve(ui.root, file)).then((r) => ui.pictures.set(id, r));
    }
    ui.goal.current = null;
  };
  return { readsEnded, stopReads, settle, newPicture, imagePaste, pastePictures };
};
