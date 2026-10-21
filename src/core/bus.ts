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
  usage: [{ provider: string; usage: Usage }];
  error: [ErrorEvent];
  lead: [string];
}

// The session emits; the interface, status line, headless output and error log listen.
export class Bus extends EventEmitter<Events> {}
