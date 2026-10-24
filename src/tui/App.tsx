import { type Key, Static, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import type { Bus, ErrorEvent } from "../core/bus.js";
import { summarize } from "../core/errorlog.js";
import { type Mode, visible } from "../core/permissions.js";
import type { Session } from "../core/session.js";
import type { Stats } from "../core/stats.js";
import { errorText, type Message, type Provider } from "../core/types.js";
import type { ModelGroup } from "../providers/models.js";
import { describe, type Line, screen } from "./describe.js";
import { apply, type Editor, empty, load, move } from "./editor.js";
import { History, matches } from "./history.js";
import { type Command, commands } from "./keys.js";
import { vertical } from "./layout.js";
import { ModelPicker } from "./ModelPicker.js";
import { Prompt, promptWidth } from "./Prompt.js";
import { type Segment, StatusLine } from "./StatusLine.js";

type Question = { text: string; answer: (ok: boolean, how: string) => void };

export interface AppProps {
  session: Session;
  bus: Bus;
  stats: Stats;
  mode: Mode;
  project: string; // the project folder's name, for the status line
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

export function App({ session, bus, stats, mode, project, gitBranch, historyFile, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
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
  const { columns } = useWindowSize();
  const [busy, setBusy] = useState(false);
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
    bus.on("message", onMessage);
    bus.on("error", onError);
    bus.on("usage", onUsage);
    bus.on("lead", onLead);
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
    };
  }, []);

  // Called without await, so nothing may escape: an unhandled rejection ends the program.
  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    // Commands ignore case; a message is sent as typed.
    const [first = "", ...words] = text.split(/\s+/);
    const command = first.toLowerCase();
    const alone = (name: string) => command === name && !words.length;
    try {
      if (alone("/exit")) return exit();
      if (alone("/errors")) return say(...summarize(errorFile).map((row) => ({ text: row, oneLine: true })));
      if (alone("/lead")) return say({ text: "Usage: /lead <provider:model>" });
      if (command === "/lead") return session.setLead(makeProvider(words.join(" ")));
      const account = command === "/login" ? "login" : command === "/logout" ? "logout" : undefined;
      // A mistyped command must not become a paid turn.
      // A slash and a bare word on its own is a command; "/tmp is full" is a message, "/exit now" is not.
      if (!account && !alone("/model") && /^\/[a-z]+$/i.test(text)) return say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
      if (words.length && ["/exit", "/errors", "/model"].includes(command)) return say({ text: `${command} takes nothing after it.`, color: "red" });
      abort.current = new AbortController();
      setBusy(true);
      try {
        // Signing in waits on the browser; Ctrl-C stops it, as it stops a turn.
        if (account) await login(account, words, (line) => say({ text: line, color: "magenta" }), abort.current.signal, "/");
        else if (alone("/model")) {
          const { signal } = abort.current; // this command's own, read before the wait
          const groups = await listModels(signal, (line) => say({ text: line, color: "magenta" }));
          if (!signal.aborted) setPicker(groups);
        } else await session.send(text, abort.current.signal);
      } finally {
        setBusy(false);
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
  };

  useInput((ch, key) => {
    if (picker) return; // the picker reads the keys while it is open
    if (question) {
      if (key.ctrl && ch === "c") {
        question.answer(false, "declined (cancelled)");
        abort.current?.abort();
      } else if (key.escape) question.answer(false, "declined"); // that action only; the turn goes on
      else if (ch === "y" || ch === "n") question.answer(ch === "y", ch === "y" ? "allowed" : "declined");
      return;
    }
    if (search.current) {
      searchKey(ch, key);
      return rerender((n) => n + 1);
    }
    const e = editor.current;
    const name = key.escape ? "Esc" : key.ctrl && ch === "c" ? "Ctrl-C" : key.ctrl && ch === "d" && !e.text ? "Ctrl-D" : null;
    if (busy) {
      if (name === "Esc" || name === "Ctrl-C") abort.current?.abort();
      return;
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
      if (question || busy || search.current) return;
      run({ type: "paste", text: text.replace(/\r\n?/g, "\n") });
      rerender((n) => n + 1);
    },
    { isActive: !picker },
  );

  const run = (c: Command) => {
    const e = editor.current;
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
    void submit(e.text);
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

  // The hint line, under the prompt (release 3 design, "On screen"): whichever applies.
  const exitKey = first.current?.name === "Esc" ? undefined : first.current?.name;
  const searching = search.current && `search: ${visible(search.current.query)}${shown() === search.current.before ? " (no match)" : ""}`;
  const hint = searching
    ? `${searching} · Ctrl+R older · Enter send · Tab edit · Ctrl-C cancel`
    : exitKey
      ? `Press ${exitKey} again to exit`
      : !picker && !question && !busy
        ? "? for shortcuts"
        : null;

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
        <ModelPicker groups={picker} current={session.lead.id} onPick={pick} onClose={() => setPicker(null)} />
      ) : question ? (
        <Text color="yellow">Allow {question.text}? [y/n] · Esc to decline</Text>
      ) : busy ? (
        <Text>… working (Ctrl-C to stop)</Text>
      ) : (
        <Prompt editor={search.current ? shown() : editor.current} columns={columns} />
      )}
      {hint && <Text dimColor>{hint}</Text>}
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
          mode,
          errors: stats.errors,
          project,
          branch,
          elapsed: now - started.current,
        }}
      />
    </>
  );
}
