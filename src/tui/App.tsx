import { Static, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { Bus, ErrorEvent } from "../core/bus.js";
import { summarize } from "../core/errorlog.js";
import type { Mode } from "../core/permissions.js";
import type { Session } from "../core/session.js";
import type { Stats } from "../core/stats.js";
import { errorText, type Message, type Provider } from "../core/types.js";
import { describe, type Line, screen } from "./describe.js";
import { type Segment, StatusLine } from "./StatusLine.js";

type Question = { text: string; answer: (ok: boolean, how: string) => void };

export interface AppProps {
  session: Session;
  bus: Bus;
  stats: Stats;
  mode: Mode;
  errorFile: string;
  segments: Segment[];
  makeProvider: (spec: string) => Provider;
  bindAsk: (ask: (summary: string, detail?: string) => Promise<boolean>) => void;
  // `/login …` and `/logout …`: the words after the command, and where to show what it says.
  login: (verb: "login" | "logout", words: string[], say: (line: string) => void, signal: AbortSignal, prefix: string) => Promise<void>;
}

const COMMANDS = "/lead <provider:model>, /login chatgpt, /logout chatgpt, /errors, /exit";

export function App({ session, bus, stats, mode, errorFile, segments, makeProvider, bindAsk, login }: AppProps) {
  const { exit } = useApp();
  const [lines, setLines] = useState<(Line & { id: number })[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState<Question | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [, rerender] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const lookups = useRef(0);

  const say = (...add: Line[]) => setLines((l) => [...l, ...add.map((x) => ({ ...screen(x), id: nextId.current++ }))]);

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
    lookUpWindow();
    return () => {
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
      // A slash and a bare word on its own is a command; "/tmp is full" is a message.
      if (!account && /^\/[a-z]+$/i.test(text)) return say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
      abort.current = new AbortController();
      setBusy(true);
      try {
        // Signing in waits on the browser; Ctrl-C stops it, as it stops a turn.
        if (account) await login(account, words, (line) => say({ text: line, color: "magenta" }), abort.current.signal, "/");
        else await session.send(text, abort.current.signal);
      } finally {
        setBusy(false);
      }
    } catch (err) {
      say({ text: errorText(err), color: "red" });
    }
  };

  useInput((ch, key) => {
    if (question) {
      if (key.ctrl && ch === "c") {
        question.answer(false, "declined (cancelled)");
        abort.current?.abort();
      } else if (ch === "y" || ch === "n") question.answer(ch === "y", ch === "y" ? "allowed" : "declined");
      return;
    }
    if (key.ctrl && ch === "c") return busy ? abort.current?.abort() : exit();
    if (busy) return;
    if (key.return) {
      void submit(input);
      setInput("");
    } else if (key.backspace || key.delete) setInput((s) => s.slice(0, -1));
    else if (!key.ctrl && !key.meta && ch) setInput((s) => s + ch);
  });

  return (
    <>
      <Static items={lines}>
        {(l) => (
          <Text key={l.id} color={l.color} wrap={l.oneLine ? "truncate-end" : "wrap"}>
            {l.text}
          </Text>
        )}
      </Static>
      {question ? (
        <Text color="yellow">Allow {question.text}? [y/n]</Text>
      ) : (
        <Text>{busy ? "… working (Ctrl-C to stop)" : `› ${input}`}</Text>
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
          mode,
          errors: stats.errors,
        }}
      />
    </>
  );
}
