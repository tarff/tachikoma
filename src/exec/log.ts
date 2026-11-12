import { MAX_TOOL_OUTPUT } from "./executor.js";

// Claude Code's hooks reference, Stop input: a background task's command is cut at 1,000 characters. A delivery's first
// line cuts its command the same way, so the id and the state always fit and output always has room (background
// commands plan, choice 24).
export const HEAD_COMMAND = 1_000;

export function headCommand(command: string): string {
  return command.length <= HEAD_COMMAND ? command : `${command.slice(0, HEAD_COMMAND)}… [+${command.length - HEAD_COMMAND} chars]`;
}

const droppedNote = (n: number | string) => `[${n} earlier characters were dropped]`;
const moreNote = (n: number | string, id: string) => `[${n} more characters: shell_output ${id} gives them]`;

// A background command's output, both streams in the order they arrived, and how far the model has read it. Only the
// newest characters are kept, so a dev server running all day holds 30,000, not its whole log (background commands
// design, "What the model gets").
export class CommandLog {
  private text = "";
  private added = 0;
  // Counted, as `added` is, over every character ever added, so a read past dropped output knows how many it missed.
  private position = 0;

  // MAX_TOOL_OUTPUT: Claude Code's cap on a tool's output, which the session already uses (background commands plan,
  // choice 4).
  constructor(private readonly keep: number = MAX_TOOL_OUTPUT) {}

  add(text: string): void {
    this.added += text.length;
    const all = this.text + text;
    this.text = all.length > this.keep ? all.slice(all.length - this.keep) : all;
  }

  get total(): number {
    return this.added;
  }

  // The user's view (/tasks): it never moves the model's position.
  kept(): string {
    return this.text;
  }

  unread(): number {
    return this.added - this.position;
  }

  // For deliver: how many unread characters were dropped, then at most `room` of the oldest kept unread ones, and the
  // position moved over both.
  read(room: number): { dropped: number; text: string } {
    const oldest = this.added - this.text.length;
    const dropped = Math.max(0, oldest - this.position);
    this.position += dropped;
    const text = this.text.slice(this.position - oldest, this.position - oldest + room);
    this.position += text.length;
    return { dropped, text };
  }
}

// Every delivery to the model, a shell_output read or an ending's message, is built here, so none is longer than the
// session's cut and the cut never loses its end. Its room is MAX_TOOL_OUTPUT less the head and both notes written with
// as many digits as the log's total, the largest either count can be (background commands plan, choice 4). The caller
// keeps `head` short: a head near 30,000 would leave no room, so no output and a more note on every read. Every command
// in a head goes through headCommand, and Task 4 cuts choice 23's error text too.
export function deliver(head: string, log: CommandLog, id: string): string {
  if (log.unread() === 0) return `${head}\nNo new output.`;
  const most = "9".repeat(String(log.total).length);
  const room = Math.max(0, MAX_TOOL_OUTPUT - `${head}\n${droppedNote(most)}\n\n${moreNote(most, id)}`.length);
  const { dropped, text } = log.read(room);
  const left = log.unread();
  return [head, ...(dropped ? [droppedNote(dropped)] : []), text, ...(left ? [moreNote(left, id)] : [])].join("\n");
}
