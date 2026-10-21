import { Static, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { Bus, ErrorEvent } from "../core/bus.js";
import { summarize } from "../core/errorlog.js";
import type { Mode } from "../core/permissions.js";
import type { Session } from "../core/session.js";
import type { Stats } from "../core/stats.js";
import { errorText, type Message, type Provider } from "../core/types.js";
import { describe, type Line } from "./describe.js";
import { type Segment, StatusLine } from "./StatusLine.js";

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
  const [question, setQuestion] = useState<{ text: string; answer: (ok: boolean) => void } | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [, rerender] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(0);

  const say = (...add: Line[]) => setLines((l) => [...l, ...add.map((x) => ({ ...x, id: nextId.current++ }))]);

  useEffect(() => {
    bindAsk((text) => new Promise((resolve) => setQuestion({ text, answer: resolve })));
    const onMessage = (m: Message) => say(...describe(m));
    const onError = (e: ErrorEvent) => {
      if (e.kind === "tool") rerender((n) => n + 1);
      else if (e.kind === "fallback") say({ text: `↪ ${e.message}`, color: "magenta" });
      else say({ text: `✗ ${e.kind}: ${e.message}`, color: "red" });
    };
    const onUsage = () => rerender((n) => n + 1);
    const onLead = (id: string) => {
      say({ text: `lead is now ${id}`, color: "magenta" });
      session.lead.contextWindow?.().then(setContextWindow) ?? setContextWindow(null);
    };
    bus.on("message", onMessage);
    bus.on("error", onError);
    bus.on("usage", onUsage);
    bus.on("lead", onLead);
    session.lead.contextWindow?.().then(setContextWindow);
    return () => {
      bus.off("message", onMessage);
      bus.off("error", onError);
      bus.off("usage", onUsage);
      bus.off("lead", onLead);
    };
  }, []);

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (text === "/exit") return exit();
    if (text === "/errors") return say({ text: summarize(errorFile) });
    if (text.startsWith("/lead ")) {
      try {
        session.setLead(makeProvider(text.slice("/lead ".length).trim()));
      } catch (err) {
        say({ text: errorText(err), color: "red" });
      }
      return;
    }
    abort.current = new AbortController();
    setBusy(true);
    try {
      await session.send(text, abort.current.signal);
    } finally {
      setBusy(false);
    }
  };

  useInput((ch, key) => {
    if (question) {
      if (ch === "y" || ch === "n") {
        say({ text: `${question.text}: ${ch === "y" ? "allowed" : "declined"}`, color: "gray" });
        question.answer(ch === "y");
        setQuestion(null);
      }
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
