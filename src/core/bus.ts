import { EventEmitter } from "node:events";
import type { TodoItem } from "../tools/todo.js";
import type { Message, Usage } from "./types.js";

export interface ErrorEvent {
  // "fallback": a refusal another model rescued; "judge": the judge's request failed (release 7 plan, Task 9); "saving":
  // the session's transcript could not be written, which stops nothing else (release 8a plan, Task 5); "shortening": a
  // conversation too long for the model could not be shortened, or was still too long once it was (Task 12)
  kind: "tool" | "provider" | "refusal" | "max_tokens" | "fallback" | "judge" | "saving" | "shortening";
  attempted: string;
  message: string;
  lead: string;
  status?: number; // a provider's HTTP status, when its failure came with one (release 6 plan, choice 10)
}

// How a tool call ended. "declined": the user said no, or the mode refused it. "cancelled": the turn
// was stopped (Esc or Ctrl-C) while the call ran, waited at its question, or had not started.
export type ToolOutcome = "ok" | "failed" | "declined" | "cancelled";

export interface Events {
  message: [Message];
  // `task`: a subagent's, such as "t3"; `judge`: the judge's request (release 7 plan, choice 9); `summary`: a shortening's
  // summary request (release 8a plan, Task 12)
  usage: [{ provider: string; usage: Usage; priceKnown?: boolean; task?: string; judge?: boolean; summary?: boolean }];
  error: [ErrorEvent];
  lead: [string];
  // Each call the session takes up, as it runs; its result reaches the conversation with the others.
  "tool-start": [{ id: string; name: string; input: unknown }];
  "tool-end": [{ id: string; outcome: ToolOutcome }];
  todo: [TodoItem[]]; // the lead's new to-do list
  tasks: []; // a subagent started, changed or finished
  note: [string]; // a line for the user that is neither a failure nor the conversation, such as pictures left out
  shortened: [string]; // the history was shortened into one message; the summary (release 8a plan, Task 12)
}

// The session emits; the interface, status line, headless output and error log listen.
export class Bus extends EventEmitter<Events> {
  constructor() {
    super();
    // Node throws when an "error" event has no listener. Here an error event is a report, not a crash,
    // so a session that nobody is listening to must carry on.
    this.on("error", () => {});
  }
}
