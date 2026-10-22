import { EventEmitter } from "node:events";
import type { Message, Usage } from "./types.js";

export interface ErrorEvent {
  kind: "tool" | "provider" | "refusal" | "max_tokens" | "fallback"; // "fallback": a refusal another model rescued
  attempted: string;
  message: string;
  lead: string;
}

export interface Events {
  message: [Message];
  usage: [{ provider: string; usage: Usage; priceKnown?: boolean }];
  error: [ErrorEvent];
  lead: [string];
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
