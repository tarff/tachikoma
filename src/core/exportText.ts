import { marker, type Message, type ToolCall } from "./types.js";

// A tool call with its full input, and its result under it, as Ctrl+O shows it (tui/describe.ts, callLines), and so as
// /export writes it (release 8a plan, choice 27). A call of a turn still running may have no result yet.
export const callText = (c: ToolCall, result: string | undefined) =>
  `● ${c.name} ${JSON.stringify(c.input, null, 2)}\n  ⎿ ${result ?? "(not finished)"}`;

// The conversation as text to read, for /export (choice 27): a heading line per message, "You:" or "Tachikoma (<lead>):",
// then its text, each picture as its marker and each call as Ctrl+O shows it. A reply is headed with the lead that wrote
// it, and one saved before replies kept their lead with the lead leading now. The notes the session added for the lead
// (a background subagent's answer, failure or stop, and a crash's "answer was lost" line) go where they arrived, as the
// lead got them, under "Subagents:" (user, 2026-11-06), though the scrollback shows them only as "t3 finished"
// (describe.ts). Results have no heading of their own, being under their calls, each found in the message right after
// its reply, as a provider may give a call an earlier turn's id. Blocks are separated by a blank line, and every line
// ends with LF alone, a message's own CRLF or CR included.
export function exportText(messages: Message[], lead: string): string {
  const blocks: { heading: string; lines: string[] }[] = [];
  for (const [i, m] of messages.entries()) {
    const after = m.role === "assistant" && messages[i + 1]?.role === "user" ? messages[i + 1]!.parts : [];
    const results = new Map(after.flatMap((p) => (p.type === "tool_result" ? [[p.callId, p.output] as const] : [])));
    let block: (typeof blocks)[number] | undefined; // this message's latest
    let picture = false; // the last part put in it was a picture
    for (const p of m.parts) {
      // A tool's pictures are named by the line ending its answer, under its call (release 8c plan, choices 10 and 34). A
      // picked resource's text and a prompt command's messages are the server's, never the user's words (choice 34), and
      // are left out, as the scrollback leaves them out (describe.ts).
      if (p.type === "tool_result" || ((p.type === "image" || p.type === "text") && p.from === "server")) continue;
      const note = p.type === "text" && p.from === "tasks";
      // A hook's text for the model is shown as those notes are, under its own first line, `<Event> hook:` (release 8b
      // plan, Task 8).
      const hook = p.type === "text" && p.from === "hooks" ? /^(.*)\n([^]*)$/.exec(p.text) : null;
      const heading = hook ? hook[1]! : note ? "Subagents:" : m.role === "user" ? "You:" : `Tachikoma (${m.lead ?? lead}):`;
      if (block?.heading !== heading) {
        blocks.push((block = { heading, lines: [] }));
        picture = false;
      }
      // The user's text and pictures are one prompt, as the scrollback shows it: two pictures next to each other get a
      // space between, as the blanks between them were left out of the message (describe.ts).
      if (p.type === "text" || p.type === "image") {
        const text = p.type === "image" ? `${picture ? " " : ""}${marker(p.id)}` : hook ? hook[2]! : p.text;
        picture = p.type === "image";
        if (heading === "You:" && block.lines.length) block.lines[block.lines.length - 1] += text;
        else block.lines.push(text);
      } else block.lines.push(callText(p, results.get(p.id)));
    }
  }
  return blocks.map((b) => `${b.heading}\n${b.lines.join("\n")}\n`).join("\n").replace(/\r\n?/g, "\n");
}
