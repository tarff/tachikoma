import { EventEmitter } from "node:events";
import type { TodoItem } from "../tools/todo.js";
import type { Message, Usage } from "./types.js";

export interface ErrorEvent {
  kind: "tool" | "provider" | "refusal" | "max_tokens" | "fallback"; // "fallback": a refusal another model rescued
  attempted: string;
  message: string;
  lead: string;
}

// How a tool call ended. "declined": the user said no, or the mode refused it. "cancelled": the turn
// was stopped (Esc or Ctrl-C) while the call ran, waited at its question, or had not started.
export type ToolOutcome = "ok" | "failed" | "declined" | "cancelled";

export interface Events {
  message: [Message];
  usage: [{ provider: string; usage: Usage; priceKnown?: boolean; task?: string }]; // `task`: a subagent's, such as "t3"
  error: [ErrorEvent];
  lead: [string];
  // Each call the session takes up, as it runs; its result reaches the conversation with the others.
  "tool-start": [{ id: string; name: string; input: unknown }];
  "tool-end": [{ id: string; outcome: ToolOutcome }];
  todo: [TodoItem[]]; // the lead's new to-do list
  tasks: []; // a subagent started, changed or finished
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
