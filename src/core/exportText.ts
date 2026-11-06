import { marker, type Message, type ToolCall } from "./types.js";

// A tool call with its full input, and its result under it, as Ctrl+O shows it (tui/describe.ts, callLines), and so as
// /export writes it (release 8a plan, choice 27). A call of a turn still running may have no result yet.
export const callText = (c: ToolCall, result: string | undefined) =>
  `● ${c.name} ${JSON.stringify(c.input, null, 2)}\n  ⎿ ${result ?? "(not finished)"}`;

// The conversation as text to read, for /export (choice 27): a heading line per message, "You:" or "Tachikoma (<lead>):",
// then its text, each picture as its marker and each call as Ctrl+O shows it. The lead named is the one leading now, as a
// message does not keep which lead made it. A message of results alone has no heading of its own, its results being
// under their calls; nor has the text the session added for the lead, such as a background subagent's answer, which the
// scrollback leaves out too (describe.ts). Messages are separated by a blank line.
export function exportText(messages: Message[], lead: string): string {
  const results = new Map(messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_result" ? [[p.callId, p.output] as const] : []))));
  const blocks = messages.flatMap((m) => {
    const lines: string[] = [];
    let picture = false; // the last part put in was a picture
    for (const p of m.parts) {
      if (p.type === "text" && p.from === "tasks") continue;
      // The user's text and pictures are one prompt, as the scrollback shows it: two pictures next to each other get a
      // space between, as the blanks between them were left out of the message (describe.ts).
      if (p.type === "text" || p.type === "image") {
        const text = p.type === "image" ? `${picture ? " " : ""}${marker(p.id)}` : p.text;
        picture = p.type === "image";
        if (m.role === "user" && lines.length) lines[lines.length - 1] += text;
        else lines.push(text);
      } else if (p.type === "tool_call") lines.push(callText(p, results.get(p.id)));
    }
    return lines.length ? [`${m.role === "user" ? "You:" : `Tachikoma (${lead}):`}\n${lines.join("\n")}\n`] : [];
  });
  return blocks.join("\n");
}
