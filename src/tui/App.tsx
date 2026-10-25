import { type Key, Static, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import type { Bus, ErrorEvent, Events } from "../core/bus.js";
import { summarize } from "../core/errorlog.js";
import { type Mode, visible } from "../core/permissions.js";
import type { Session } from "../core/session.js";
import type { Stats } from "../core/stats.js";
import { errorText, type Message, type Provider } from "../core/types.js";
import type { ModelGroup } from "../providers/models.js";
import type { TodoItem } from "../tools/todo.js";
import { brief, describe, lastTurn, type Line, screen } from "./describe.js";
import { apply, type Editor, empty, load, move, replace } from "./editor.js";
import { History, matches } from "./history.js";
import { type Command, commands, KEY_LIST } from "./keys.js";
import { layout, vertical } from "./layout.js";
import { Menu } from "./Menu.js";
import { commandMenu, type Listing, listFolder, type Menu as MenuData, pathMenu } from "./menus.js";
import { ModelPicker } from "./ModelPicker.js";
import { Prompt, promptWidth } from "./Prompt.js";
import { type Segment, StatusLine } from "./StatusLine.js";
import { TodoList, todoRows, unfinished } from "./TodoList.js";
import { type Call, ToolLine } from "./ToolLine.js";
import { SPIN_MS, WorkingLine } from "./WorkingLine.js";

type Question = { text: string; answer: (ok: boolean, how: string) => void };

export interface AppProps {
  session: Session;
  bus: Bus;
  stats: Stats;
  mode: Mode; // the mode the session started in
  onMode: (mode: Mode) => void; // Shift+Tab: the mode the permission check uses from the next action
  project: string; // the project folder's name, for the status line
  root: string; // the project folder, where `@` paths start
  gitBranch: () => string | null; // read at the start and after each turn: the model may switch branches
  historyFile: string; // this project's past prompts
  errorFile: string;
  segments: Segment[];
  makeProvider: (spec: string) => Provider;
  bindAsk: (ask: (summary: string, detail?: string) => Promise<boolean>) => void;
  // `/login …` and `/logout …`: the words after the command, where to show what it says, a signal
  // Ctrl-C aborts, and how a command is typed here ("/").
  login: (verb: "login" | "logout", words: string[], say: (line: string) => void, signal: AbortSignal, prefix: string) => Promise<void>;
  // `/model`: every provider's models, and where to show what reading the saved login says.
  listModels: (signal: AbortSignal, warn: (line: string) => void) => Promise<ModelGroup[]>;
}

const COMMANDS = "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /errors, /exit";
const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (interactive-mode.md)

// What submit takes as a command: a command's name first, or a slash and a bare word ("/tmp is full"
// is a message).
const NAMES = ["/exit", "/errors", "/lead", "/model", "/login", "/logout"];
const isCommand = (text: string) => NAMES.includes(text.split(/\s+/)[0]!.toLowerCase()) || /^\/[a-z]+$/i.test(text);

export function App({ session, bus, stats, mode, onMode, project, root, gitBranch, historyFile, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
  const { exit } = useApp();
  const [lines, setLines] = useState<(Line & { id: number })[]>([]);
  // Each key reads and changes these at once, as in ModelPicker: several keys can arrive before the
  // screen is drawn again. `goal` is the column Up and Down keep to, until another key moves the cursor.
  const editor = useRef(empty);
  const goal = useRef<number | null>(null);
  const first = useRef<{ name: string; timer: NodeJS.Timeout } | null>(null); // a key waiting for its second press
  const step = useRef<{ at: number; draft: string } | null>(null); // where Up has gone in the history, and what was typed before
  // Ctrl+R: what is searched for, how many older matches Ctrl+R has passed, and the prompt to give back.
  const search = useRef<{ query: string; skip: number; before: Editor } | null>(null);
  // The menus: the entry chosen, for the text it was chosen at; the text Esc closed one at, which
  // keeps it closed until the text changes; and the folder `@` listed last.
  const chosen = useRef({ text: "", at: 0 });
  const closed = useRef<string | null>(null);
  const listed = useRef<{ folder: string; listing: Listing } | null>(null);
  const { columns, rows: height } = useWindowSize();
  const [busy, setBusy] = useState(false);
  const working = useRef(false); // busy, for keys read before the screen is drawn again
  const queue = useRef<string[]>([]); // what Enter added during a turn, in order
  // What is running, since when, and for a turn the totals it started from; and the turn's tool calls,
  // kept after it until the next turn starts.
  const doing = useRef<{ label: string; at: number; from: { output: number; cost: number; unpriced: number } | null }>({ label: "", at: 0, from: null });
  const calls = useRef<Call[]>([]);
  // The lead's to-do list, and whether Ctrl+T has hidden it; a new list shows again.
  const todos = useRef<{ items: TodoItem[]; hidden: boolean }>({ items: [], hidden: false });
  // Shift+Tab's modes: `never` only for a session started in it, so no key turns off the checks a
  // session started with.
  const perm = useRef(mode);
  const cycle: Mode[] = mode === "never" ? ["ask", "project", "never"] : ["ask", "project"];
  const [question, setQuestion] = useState<Question | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [picker, setPicker] = useState<ModelGroup[] | null>(null);
  const [, rerender] = useState(0);
  const started = useRef(Date.now());
  const [now, setNow] = useState(started.current);
  const [branch, setBranch] = useState(gitBranch);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const lookups = useRef(0);

  const say = (...add: Line[]) => setLines((l) => [...l, ...add.map((x) => ({ ...screen(x), id: nextId.current++ }))]);
  const history = useRef<History | null>(null);
  history.current ??= new History(historyFile, (line) => say({ text: line, color: "magenta" }));

  // Only the latest lookup's answer is shown: a late one, for the previous lead or from before a
  // request, must not replace it. Asked again after each request, without clearing what is shown: a
  // ChatGPT plan's window is known only once a request has fetched the account's model list.
  const lookUpWindow = (fresh = true) => {
    const asked = ++lookups.current;
    if (fresh) setContextWindow(null);
    session.lead.contextWindow?.()
      .then((n) => asked === lookups.current && setContextWindow(n))
      .catch(() => {}); // stays unknown
  };

  useEffect(() => {
    bindAsk((text, detail) => {
      // A tool still finishing after Ctrl-C must not ask about a turn the user has stopped.
      if (abort.current?.signal.aborted) return Promise.resolve(false);
      // In the scrollback, not the prompt: a whole file would not fit in the part Ink redraws.
      // Grey, under a heading, so file text cannot pass for the conversation or the interface.
      if (detail !== undefined) {
        const lines = detail ? detail.replace(/\r?\n$/, "").split("\n").length : 0; // as read_file counts them
        say({ text: `┌ ${text} (${lines} line${lines === 1 ? "" : "s"})`, color: "gray" }, { text: detail || "(empty)", color: "gray" });
      }
      return new Promise((resolve) => {
        let open = true; // answered once: two keys arriving together would otherwise both be logged
        setQuestion({
          text,
          answer: (ok, how) => {
            if (!open) return;
            open = false;
            say({ text: `${text}: ${how}`, color: "gray" });
            resolve(ok);
            setQuestion(null);
          },
        });
      });
    });
    const onMessage = (m: Message) => say(...describe(m));
    const onError = (e: ErrorEvent) => {
      if (e.kind === "tool") rerender((n) => n + 1);
      else if (e.kind === "fallback") say({ text: `↪ ${e.message}`, color: "magenta" });
      else say({ text: `✗ ${e.kind}: ${e.message}`, color: "red" });
    };
    const onUsage = () => {
      rerender((n) => n + 1);
      lookUpWindow(false);
    };
    const onLead = (id: string) => {
      say({ text: `lead is now ${id}`, color: "magenta" });
      lookUpWindow();
    };
    const onToolStart = ({ id, name, input }: Events["tool-start"][0]) => {
      calls.current.push({ id, name, target: brief(name, input) });
      rerender((n) => n + 1);
    };
    const onToolEnd = ({ id, outcome }: Events["tool-end"][0]) => {
      const call = calls.current.find((c) => c.id === id);
      if (call) call.outcome = outcome;
      rerender((n) => n + 1);
    };
    const onTodo = (items: TodoItem[]) => {
      todos.current = { items, hidden: false };
      rerender((n) => n + 1);
    };
    bus.on("message", onMessage);
    bus.on("error", onError);
    bus.on("usage", onUsage);
    bus.on("lead", onLead);
    bus.on("tool-start", onToolStart);
    bus.on("tool-end", onToolEnd);
    bus.on("todo", onTodo);
    history.current!.load();
    lookUpWindow();
    const minutes = setInterval(() => setNow(Date.now()), 60_000); // the status line counts the session in minutes
    return () => {
      clearInterval(minutes);
      clearTimeout(first.current?.timer);
      bus.off("message", onMessage);
      bus.off("error", onError);
      bus.off("usage", onUsage);
      bus.off("lead", onLead);
      bus.off("tool-start", onToolStart);
      bus.off("tool-end", onToolEnd);
      bus.off("todo", onTodo);
    };
  }, []);

  // The working line's spinner and time, while something runs.
  useEffect(() => {
    if (!busy) return;
    const spin = setInterval(() => setNow(Date.now()), SPIN_MS);
    return () => clearInterval(spin);
  }, [busy]);

  // Called without await, so nothing may escape: an unhandled rejection ends the program. The queue
  // goes on after a turn, however it ended, and after `/model` once the list is closed.
  const submit = async (raw: string) => {
    if (!(await perform(raw))) next();
  };

  // Entries are taken from the front: a command alone, as if typed then; prompts next to each other
  // as one message, separated by blank lines. Not while something runs: a command that finished
  // after a turn started (both typed in one read of the terminal) leaves the queue to that turn.
  const next = () => {
    if (working.current) return;
    const q = queue.current;
    const command = q.findIndex(isCommand);
    if (q.length) void submit(q.splice(0, command === 0 ? 1 : command === -1 ? q.length : command).join("\n\n"));
  };

  // True when it opened the model list.
  const perform = async (raw: string): Promise<boolean | void> => {
    const text = raw.trim();
    if (!text) return;
    // Commands ignore case; a message is sent as typed.
    const [first = "", ...words] = text.split(/\s+/);
    const command = first.toLowerCase();
    const alone = (name: string) => command === name && !words.length;
    try {
      if (alone("/exit")) {
        queue.current = [];
        return exit();
      }
      if (alone("/errors")) return say(...summarize(errorFile).map((row) => ({ text: row, oneLine: true })));
      if (alone("/lead")) return say({ text: "Usage: /lead <provider:model>" });
      if (command === "/lead") return session.setLead(makeProvider(words.join(" ")));
      const account = command === "/login" ? "login" : command === "/logout" ? "logout" : undefined;
      // A mistyped command must not become a paid turn.
      // A slash and a bare word on its own is a command; "/tmp is full" is a message, "/exit now" is not.
      if (!account && !alone("/model") && /^\/[a-z]+$/i.test(text)) return say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
      if (words.length && ["/exit", "/errors", "/model"].includes(command)) return say({ text: `${command} takes nothing after it.`, color: "red" });
      abort.current = new AbortController();
      const turn = !account && !alone("/model");
      const label = account === "login" ? "Waiting for the browser" : account ? "Signing out" : turn ? "Working" : "Reading the model lists";
      doing.current = { label, at: Date.now(), from: turn ? { output: stats.output, cost: stats.cost, unpriced: stats.unpriced } : null };
      if (turn) calls.current = [];
      setNow(doing.current.at);
      setBusy(true);
      working.current = true;
      try {
        // Signing in waits on the browser; Ctrl-C stops it, as it stops a turn.
        if (account) await login(account, words, (line) => say({ text: line, color: "magenta" }), abort.current.signal, "/");
        else if (alone("/model")) {
          const { signal } = abort.current; // this command's own, read before the wait
          const groups = await listModels(signal, (line) => say({ text: line, color: "magenta" }));
          if (!signal.aborted) {
            setPicker(groups);
            return true;
          }
        } else await session.send(text, abort.current.signal);
      } finally {
        setBusy(false);
        working.current = false;
        setBranch(gitBranch());
      }
    } catch (err) {
      say({ text: errorText(err), color: "red" });
    }
  };

  // Picking does what `/lead <provider:model>` does.
  const pick = (spec: string) => {
    setPicker(null);
    try {
      session.setLead(makeProvider(spec));
    } catch (err) {
      say({ text: errorText(err), color: "red" });
    }
    next();
  };
  const closePicker = () => {
    setPicker(null);
    next();
  };

  useInput((ch, key) => {
    if (picker) return; // the picker reads the keys while it is open
    if (question) {
      if (key.ctrl && ch === "c") {
        question.answer(false, "declined (cancelled)");
        abort.current?.abort();
        restore();
      } else if (key.escape) question.answer(false, "declined"); // that action only; the turn goes on
      else if (ch === "y" || ch === "n") question.answer(ch === "y", ch === "y" ? "allowed" : "declined");
      return;
    }
    if (search.current) {
      searchKey(ch, key);
      return rerender((n) => n + 1);
    }
    const e = editor.current;
    const menu = menuFor(e);
    if (menu && ((key.tab && !key.shift) || key.escape)) {
      if (key.escape) closed.current = e.text;
      else fill(menu, e);
      forget();
      return rerender((n) => n + 1);
    }
    const name = key.escape ? "Esc" : key.ctrl && ch === "c" ? "Ctrl-C" : key.ctrl && ch === "d" && !e.text ? "Ctrl-D" : null;
    // During a turn the prompt still edits; Esc stops the turn and the queue goes on, Ctrl-C stops it
    // and the queue comes back. Ctrl-D does not exit while a turn is running.
    if (working.current && name) {
      if (name === "Ctrl-C") restore();
      if (name !== "Ctrl-D") abort.current?.abort();
      return rerender((n) => n + 1);
    }
    const again = name !== null && first.current?.name === name;
    forget();
    if (!name) for (const c of commands(ch, key)) run(c);
    else if (name === "Ctrl-C" && e.text) clear(e); // one press clears
    else if (!again) remember(name);
    else if (name !== "Esc") return exit();
    else if (e.text) clear(e); // Esc Esc; on an empty prompt it does nothing
    rerender((n) => n + 1);
  });

  // Esc, Ctrl-C and Ctrl-D count twice when the second press comes within 800 ms of the first, the
  // window Claude Code's docs give for Ctrl+D. Any other key in between starts the count again.
  const remember = (name: string) => {
    const timer = setTimeout(() => {
      first.current = null;
      rerender((n) => n + 1);
    }, DOUBLE_PRESS_MS);
    first.current = { name, timer };
  };
  const forget = () => {
    clearTimeout(first.current?.timer);
    first.current = null;
  };

  // A pasted block goes in whole, its line breaks as new lines: it is never sent by them. While the
  // picker is open, pastes reach it as typed text, as before.
  usePaste(
    (text) => {
      if (question || search.current) return;
      run({ type: "paste", text: text.replace(/\r\n?/g, "\n") });
      rerender((n) => n + 1);
    },
    { isActive: !picker },
  );

  const run = (c: Command) => {
    const e = editor.current;
    const menu = menuFor(e);
    if (menu && (c === "up" || c === "down")) {
      chosen.current = { text: e.text, at: Math.max(0, Math.min(menu.entries.length - 1, chosenIn(e, menu) + (c === "up" ? -1 : 1))) };
      return;
    }
    if (menu && c === "submit") return menu.kind === "command" ? send(load(e, menu.entries[chosenIn(e, menu)]!.run!)) : fill(menu, e);
    if (c === "mode") {
      perm.current = cycle[(cycle.indexOf(perm.current) + 1) % cycle.length]!;
      onMode(perm.current);
      return say({ text: `mode is now ${perm.current}`, color: "gray" });
    }
    // Alt+P is `/model` typed then: during a turn it waits in the queue.
    if (c === "models") return working.current ? void queue.current.push("/model") : void submit("/model");
    if (c === "lastTurn") return say(...lastTurn(session.messages));
    if (c === "todos") return void (todos.current.hidden = !todos.current.hidden);
    // A message starting with `?` needs a space typed first.
    if (typeof c === "object" && c.type === "insert" && c.text === "?" && !e.text) return say(...KEY_LIST.map((text) => ({ text, color: "gray" })));
    if (c === "up" && !e.text && queue.current.length) return restore();
    if (c === "up" || c === "down") {
      const to = vertical(e.text, promptWidth(columns), e.cursor, c === "up" ? -1 : 1, goal.current);
      if (to) {
        editor.current = move(e, to.cursor);
        goal.current = to.goal;
      } else recall(c === "up" ? -1 : 1);
      return;
    }
    goal.current = null;
    if (c === "search") {
      search.current = { query: "", skip: 0, before: e };
      step.current = null;
    } else if (c !== "submit") editor.current = apply(e, c);
    // A backslash before Enter makes a new line in every terminal, in place of the backslash.
    else if (e.text.slice(0, e.cursor).endsWith("\\")) editor.current = apply(apply(e, "backspace"), "newline");
    else send(e);
  };

  const send = (e: Editor) => {
    keep(e.text);
    editor.current = load(e, "");
    if (!working.current) void submit(e.text);
    else if (e.text.trim()) queue.current.push(e.text.trim());
  };
  // Ctrl-C during a turn, or Up on an empty prompt: the queue comes back into the prompt, one entry a
  // line, after what is there, to edit or send.
  const restore = () => {
    if (!queue.current.length) return;
    editor.current = load(editor.current, [editor.current.text, ...queue.current].filter(Boolean).join("\n"));
    queue.current = [];
  };
  const clear = (e: Editor) => {
    keep(e.text);
    editor.current = load(e, "");
  };
  // Saved for Up and Ctrl+R, in this session and later ones: each sent prompt, and one cleared with
  // Ctrl-C or Esc Esc. The same prompt twice in a row is kept once, as Claude Code keeps it.
  const keep = (raw: string) => {
    const text = raw.trim();
    if (text && history.current!.entries.at(-1) !== text) void history.current!.add(text);
    step.current = null;
  };

  // Up from the prompt's first row steps back through the history, Down from its last row forward,
  // and past the newest prompt back to what was being typed. A prompt comes back with the cursor at
  // its end.
  const recall = (dir: -1 | 1) => {
    const { entries } = history.current!;
    const e = editor.current;
    const at = (step.current?.at ?? entries.length) + dir;
    goal.current = null;
    if (at < 0 || (!step.current && dir === 1)) return;
    if (at < entries.length) {
      step.current = { at, draft: step.current?.draft ?? e.text };
      editor.current = load(e, entries[at]!);
    } else {
      editor.current = load(e, step.current!.draft);
      step.current = null;
    }
  };

  // The `/` or `@` menu for the prompt as it is, unless Esc closed it at this text. A folder is listed
  // again when the menu opens again, so it shows what is there then.
  const menuFor = (e: Editor): MenuData | null => {
    if (closed.current !== e.text) closed.current = null;
    if (search.current || closed.current !== null) return null;
    return commandMenu(e.text, e.cursor) ?? pathMenu(e.text, e.cursor, list);
  };
  const list = (folder: string) => {
    if (listed.current?.folder !== folder) listed.current = { folder, listing: listFolder(root, folder) };
    return listed.current.listing;
  };
  const chosenIn = (e: Editor, m: MenuData) => Math.min(chosen.current.text === e.text ? chosen.current.at : 0, m.entries.length - 1);
  // Tab, and Enter on a path: the chosen entry in place of what it completes.
  const fill = (m: MenuData, e: Editor) => {
    const entry = m.entries[chosenIn(e, m)]!;
    if (!entry.error) editor.current = replace(e, m.from, entry.fill);
  };

  // What the search shows in the prompt: the match, with the cursor at its end, or, with no match,
  // the prompt as it was.
  const shown = (): Editor => {
    const s = search.current!;
    const match = matches(history.current!.entries, s.query)[s.skip];
    return match === undefined ? s.before : load(s.before, match);
  };
  const endSearch = (e: Editor) => {
    search.current = null;
    editor.current = e;
  };
  // Ctrl+R's keys, as Claude Code's search has them (interactive-mode.md): typing searches, Ctrl+R
  // finds an older match, Enter sends the match, Tab or Esc puts it in the prompt to edit, and Ctrl-C,
  // or Backspace with nothing searched for, gives back what was typed before.
  const searchKey = (ch: string, key: Key) => {
    const s = search.current!;
    if (key.ctrl && ch === "c") return endSearch(s.before);
    if (key.tab || key.escape) return endSearch(shown());
    for (const c of commands(ch, key)) {
      if (typeof c === "object") Object.assign(s, { query: s.query + c.text, skip: 0 });
      else if (c === "search") s.skip = Math.max(0, Math.min(s.skip + 1, matches(history.current!.entries, s.query).length - 1));
      else if (c === "backspace" && !s.query) return endSearch(s.before);
      else if (c === "backspace") Object.assign(s, { query: [...s.query].slice(0, -1).join(""), skip: 0 });
      else if (c === "submit") {
        const e = shown();
        endSearch(e);
        return send(e);
      }
    }
  };

  const prompt = search.current ? shown() : editor.current;
  const menu = picker || question ? null : menuFor(prompt);
  if (menu?.kind !== "path") listed.current = null;

  // The hint line, under the prompt (release 3 design, "On screen"): whichever applies. `left` is the
  // rows left for the queue.
  const exitKey = first.current?.name === "Esc" ? undefined : first.current?.name;
  const searching = search.current && `search: ${visible(search.current.query)}${shown() === search.current.before ? " (no match)" : ""}`;
  const hintFor = (left: number) =>
    searching
      ? `${searching} · Ctrl+R older · Enter send · Tab edit · Ctrl-C cancel`
      : exitKey
        ? `Press ${exitKey} again to exit`
        : picker || question
          ? null
          : menu
            ? `↑↓ choose · ${menu.kind === "command" ? "Tab fill · Enter run" : "Tab or Enter fill"} · Esc close`
            : queue.current.length
            ? left > 0
              ? "↑ to edit queued messages"
              : `${queue.current.length} queued`
            : busy
              ? null
              : "? for shortcuts";

  // The prompt's space (release 3 design): the live part stays a row shorter than the terminal, since
  // at full height Ink draws the whole scrollback again each time. First the status line and the
  // working line; the tool line when there is room for it, the hint line and the cursor's row; the hint
  // line when there is room for it and the cursor's row; then an open menu, with the prompt cut to the
  // cursor's row; then the prompt; then the to-do list, which gives way before the prompt does (release
  // 4 design, "On screen"); then the queue, the last row saying how many more there are when they do
  // not all fit. The model list fills the rows above the status line itself, so it has no tool line
  // under it.
  const base = height - 1 - 1 - (busy ? 1 : 0);
  const tooled = !picker && segments.includes("tools") && calls.current.length > 0 && base >= 2 + (hintFor(1) !== null ? 1 : 0);
  const room = base - (tooled ? 1 : 0);
  const hinted = hintFor(1) !== null && room >= 2;
  const space = Math.max(1, room - (hinted ? 1 : 0));
  const menuRows = menu ? Math.min(menu.entries.length, Math.max(1, space - 1)) : 0;
  const promptSpace = menu ? 1 : space;
  const promptLeft = space - menuRows - Math.min(layout(prompt.text, promptWidth(columns)).rows.length, promptSpace);
  const todoShown = !todos.current.hidden && unfinished(todos.current.items) ? todoRows(todos.current.items, promptLeft) : [];
  const left = promptLeft - todoShown.length;
  const q = queue.current.map((e) => visible(e));
  const queued = q.length <= left ? q : left > 0 ? [...q.slice(0, left - 1), `+${q.length - left + 1} more`] : [];
  const hint = hinted ? hintFor(left) : null;

  return (
    <>
      <Static items={lines}>
        {(l) => (
          <Text key={l.id} color={l.color} wrap={l.oneLine ? "truncate-end" : "wrap"}>
            {l.text}
          </Text>
        )}
      </Static>
      {picker ? (
        <ModelPicker groups={picker} current={session.lead.id} onPick={pick} onClose={closePicker} />
      ) : question ? (
        <Text color="yellow">Allow {question.text}? [y/n] · Esc to decline</Text>
      ) : (
        <>
          {busy && (
            <WorkingLine
              label={doing.current.label}
              ms={Math.max(0, now - doing.current.at)}
              spend={doing.current.from && { lead: session.lead.id, output: stats.output - doing.current.from.output, cost: stats.cost - doing.current.from.cost, costUnknown: stats.unpriced > doing.current.from.unpriced }}
            />
          )}
          <TodoList rows={todoShown} />
          {queued.map((row, i) => (
            <Text key={i} color="gray" wrap="truncate-end">
              {row}
            </Text>
          ))}
          <Prompt editor={prompt} columns={columns} offset={(busy ? 1 : 0) + todoShown.length + queued.length} space={promptSpace} />
          {menu && <Menu entries={menu.entries} chosen={chosenIn(prompt, menu)} rows={menuRows} />}
        </>
      )}
      {hint && (
        <Text dimColor wrap="truncate-end">
          {hint}
        </Text>
      )}
      <StatusLine
        segments={segments}
        info={{
          lead: session.lead.id,
          context: stats.context,
          contextWindow,
          input: stats.input,
          output: stats.output,
          cost: stats.cost,
          costUnknown: stats.costUnknown,
          mode: perm.current,
          errors: stats.errors,
          project,
          branch,
          elapsed: now - started.current,
        }}
      />
      {tooled && <ToolLine calls={calls.current} />}
    </>
  );
}
