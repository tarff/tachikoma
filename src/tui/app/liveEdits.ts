import { resolve } from "../../clilib.js";
import { errorText, type Provider } from "../../core/types.js";
import { KEYBINDINGS, type KeysLoaded } from "../../keybindings.js";
import { type Loaded, SETTINGS, type Settings } from "../../settings.js";
import type { Fns } from "../App.js";
import { editorCommand } from "../external.js";
import { start as vimStart } from "../vim.js";
import { FROM, gray, LIVE } from "./constants.js";
import type { UI } from "./state.js";

export const liveEdits = (ui: UI, fns: Fns) => {
  // A live edit of the settings file (release 6 design, "Live edits"): a broken file keeps the last good settings
  // and says what is wrong; a warning is said once, while its entry stays; each entry the edit changed applies by the
  // design's table, or, given by a flag or variable at launch, stays as given. Removing an entry is a change to what
  // applies without it, the default, as resolve gives it with no flag nor variable.
  const onSettings = (read: Loaded) => {
    if ("problem" in read) return fns.note({ text: `${read.problem}; the last good settings still apply`, color: "red" });
    for (const w of read.warnings) if (!ui.warned.current.includes(w)) fns.note(gray(w));
    ui.warned.current = read.warnings;
    const before = ui.fileNow.current;
    ui.fileNow.current = read.settings;
    const now = resolve({}, {}, read.settings);
    for (const key of LIVE) {
      if (JSON.stringify(before[key]) === JSON.stringify(read.settings[key])) continue;
      // VISUAL and EDITOR come before the file's editor, as a flag comes before an entry (external.ts, editorCommand).
      const flag = key === "editor" ? (process.env.VISUAL ? "VISUAL" : process.env.EDITOR ? "EDITOR" : undefined) : ui.live?.given[key];
      if (flag) fns.note(gray(`${SETTINGS}'s "${key}" was left as ${flag} set it for this session`));
      else fns.applyEntry(key, read.settings, now);
    }
    fns.next();
  };
  // The keys file, at launch and at each edit (release 6 plan, Task 11): its keys apply at once, `?` and the hints
  // following them. A broken file keeps the keys before it, the default ones until a good file is read, and says so;
  // each problem in an entry is said once, while it stays, as a settings warning is (choice 21).
  const onKeys = (read: KeysLoaded) => {
    if ("problem" in read) {
      return fns.note({ text: `${read.problem}; ${ui.keysRead.current ? "the last good keys still apply" : "the default keys apply"}`, color: "red" });
    }
    ui.keysRead.current = true;
    // After the launch, a question reads the launch's keys, whole (lookUp), so a shell command that rewrites the file
    // cannot make a key answer it (choice 32, which replaced choice 30's keepAnswers); a line says so when the edit
    // differs from them where they still apply, said as a problem is.
    let problems = read.problems;
    if (!ui.launched.current) ui.launchKeys.current = read.table;
    else if (read.table.heldBack(ui.launchKeys.current)) {
      problems = [...problems, `${KEYBINDINGS}: at a permission question the keys stay as at launch, and a key newly bound to switch the mode does nothing, until the next launch; the rest apply now`];
    }
    for (const p of problems) if (!ui.keysWarned.current.includes(p)) fns.note(gray(p));
    ui.keysWarned.current = problems;
    ui.setTable(read.table);
  };
  // One entry's new value, `s` the file's and `now` what applies (above), with its line. A lead or a screen waits for
  // next() (queue.ts). A model the file names that cannot be made is said, as at launch (cli.tsx), and the one before
  // is kept.
  const applyEntry = (key: (typeof LIVE)[number], s: Settings, now: ReturnType<typeof resolve>) => {
    const line = (value: string) => fns.note(gray(`${key} is now ${value}${FROM}`));
    const model = (spec: string | undefined) => {
      if (!spec) return undefined; // an empty --fallback or --worker is none at launch too (cli.tsx)
      try {
        return fns.make(spec);
      } catch (err) {
        fns.note({ text: `${SETTINGS}: "${key}": ${errorText(err)}`, color: "red" });
        return null;
      }
    };
    if (key === "lead") {
      ui.waiting.current.lead = s.lead;
      // A session cannot be without a lead, so removing the entry keeps the one it has (the design's table).
      if (s.lead === undefined) fns.note(gray(`"lead" was removed from ${SETTINGS}; the lead stays ${ui.session.lead.id}`));
    } else if (key === "mode") {
      // `never` is refused live (the user's choice, design's table), and at launch too until release 7 (plan, choice 30).
      if (now.mode === "never") return fns.note(gray(`"mode": "never" is switched off until release 7; the mode stays ${ui.perm.current}`));
      // A live edit never changes the mode, so a shell command the user allowed cannot rewrite the file to put the
      // session in project mode; Shift+Tab still does (plan, choice 32, the user's: "Pin at launch").
      fns.note(gray(`"mode" changes in ${SETTINGS} take effect at the next launch; the mode stays ${ui.perm.current}`));
    } else if (key === "effort") {
      ui.effortNow.current = { effort: now.effort };
      ui.session.lead.setEffort?.(now.effort);
      // As at launch (cli.tsx, makeProvider), the fallback and the subagents' worker take it too.
      ui.session.fallback?.setEffort?.(now.effort);
      ui.tasks.worker.setEffort?.(now.effort);
      line(now.effort ?? "the model's default");
    } else if (key === "fallback") {
      const p = model(now.fallback);
      if (p === null) return;
      ui.session.setFallback(p);
      ui.tasks.setFallback(p); // subagents get the lead's fallback, as at launch (cli.tsx)
      line(p?.id ?? "off");
    } else if (key === "worker") {
      const p = model(now.worker);
      if (p === null) return;
      ui.tasks.setWorker(() => p ?? ui.session.lead); // without one, a subagent uses the model leading when it starts (cli.tsx)
      line(p?.id ?? "the lead's model");
    } else if (key === "maxTasks") {
      ui.tasks.setMax(now.maxTasks);
      line(String(now.maxTasks));
    } else if (key === "status") {
      ui.setSegments(now.segments);
      line(now.segments.join(", "));
    } else if (key === "screen") ui.waiting.current.screen = s.screen ?? "full"; // full unless asked for classic (clilib.ts, screenMode)
    else if (key === "editor") line(editorCommand(process.env, s.editor, process.platform)); // read again at each use (away)
    else if (key === "editorMode") fns.setVim(s.editorMode === "vim", FROM); // at once, as /vim (design's table)
    else if (key === "vimInsertModeRemaps") line(Object.keys(s.vimInsertModeRemaps ?? {}).join(", ") || "none");
    else {
      // scrollSpeed. The wheel's carried fraction is in the old speed's units, so the new one starts with none (review
      // fixes plan, fix 6).
      ui.setSpeed(now.speed);
      ui.wheel.current = 0;
      line(String(now.speed));
    }
  };
  // The lead the file names, as /lead sets it, its line saying where it came from (onLead, App.tsx).
  const fileLead = (spec: string) => {
    let provider: Provider;
    try {
      provider = fns.make(spec);
    } catch (err) {
      return fns.note({ text: `${SETTINGS}: "lead": ${errorText(err)}`, color: "red" });
    }
    ui.leadFromFile.current = true; // read by onLead while setLead runs: the bus calls its handlers at once
    ui.session.setLead(provider);
    ui.leadFromFile.current = false;
  };
  // Vim mode on, from INSERT, or off, leaving the text and cursor as they are (release 6 design's table), with its
  // line; `from` says the settings file asked. Asked to be what it is, it stays as it is.
  const setVim = (on: boolean, from = "") => {
    if (on !== (ui.vim.current !== null)) ui.vim.current = on ? vimStart : null;
    (from ? fns.note : fns.say)(gray(`editorMode is now ${on ? "vim" : "normal"}${from}`));
  };
  return { onSettings, onKeys, applyEntry, fileLead, setVim };
};
