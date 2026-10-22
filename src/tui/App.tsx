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
  bindAsk: (ask: (summary: string) => Promise<boolean>) => void;
}

export function App({ session, bus, stats, mode, errorFile, segments, makeProvider, bindAsk }: AppProps) {
  const { exit } = useApp();
  const [lines, setLines] = useState<(Line & { id: number })[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState<Question | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [, rerender] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(0);

  const say = (...add: Line[]) => setLines((l) => [...l, ...add.map((x) => ({ ...screen(x), id: nextId.current++ }))]);

  // A late answer for the previous lead must not show as the new lead's window.
  const lookUpWindow = () => {
    const lead = session.lead;
    setContextWindow(null);
    lead.contextWindow?.()
      .then((n) => session.lead === lead && setContextWindow(n))
      .catch(() => {}); // stays unknown
  };

  useEffect(() => {
    bindAsk((text) => {
      // A tool still finishing after Ctrl-C must not ask about a turn the user has stopped.
      if (abort.current?.signal.aborted) return Promise.resolve(false);
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
    const onUsage = () => rerender((n) => n + 1);
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
    try {
      if (text === "/exit") return exit();
      if (text === "/errors") return say({ text: summarize(errorFile) });
      if (text === "/lead") return say({ text: "Usage: /lead <provider:model>" });
      if (text.startsWith("/lead ")) return session.setLead(makeProvider(text.slice("/lead ".length).trim()));
      // A mistyped command must not become a paid turn.
      // A slash and a bare word is a command; "/usr/bin is missing" is a message.
      if (/^\/[a-z]+$/i.test(text.split(/\s/)[0]!)) return say({ text: `Unknown command: ${text}. Commands: /lead <provider:model>, /errors, /exit`, color: "red" });
      abort.current = new AbortController();
      setBusy(true);
      try {
        await session.send(text, abort.current.signal);
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
          <Text key={l.id} color={l.color}>
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
