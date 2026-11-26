import type { Segment } from "./StatusLine.js";

// The status line's parts, in order (StatusLine.tsx, Segment): what --status and the settings' "status" take. Here, in a
// file that draws nothing, so a run without a screen loads no screen code to check them (cleanup plan, step 14a).
export const SEGMENTS: Segment[] = [
  "lead", "context", "tokens", "cost", "mode", "errors", "memory", "project", "time", "tasks", "tools",
];
