import type { CallToolResult } from "@modelcontextprotocol/client";
import type { Bus } from "../core/bus.js";
import { visible } from "../core/permissions.js";
import type { Picture } from "../core/types.js";
import type { Tool, ToolContext } from "../tools/tool.js";
import { NotReached } from "./server.js";
import type { Offered, Servers } from "./servers.js";

// The MCP servers' tools in the session (release 8c plan, Task 6; design, "Tools for the model"; choices 9-13 and 33):
// each call runs on the connection and definition its request offered, or is refused with a line saying why (design,
// finding 4).

// The question for a call, Task 7's gate, which throws to refuse it. It has no default, so no MCP tool reaches a session
// without one (Task 6's security check). It is asked after a dropped server's new connection, so the approval is for the
// version that runs (choice 33), and before the check that nothing changed while the call waited (finding 4). A test
// gives one that waits, to change things while a call waits for it.
export type Approve = (o: Offered, input: Record<string, unknown>, ctx: ToolContext) => Promise<void>;

// The kinds of a picture the session passes on, as a pasted one's (types.ts, Image).
const FORMATS: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
// Choice 11's names for the kinds of content an answer can hold that are not passed on, in MCP's own types.
const KINDS: Record<string, string> = { image: "image", audio: "audio", resource_link: "resource link", resource: "embedded resource" };

// The lines to the model ("Lines this plan adds", "Calls"), the server's and the tool's names escaped, as they come from
// the settings and the server.
const changed = (o: Offered) =>
  `Not run: ${visible(o.server)}'s tool "${visible(o.tool, { tabs: true })}" changed while this call waited; ` +
  "look at its definition in this request's tools, if it is still there, and call it again.";
const stopped = (o: Offered) => `The MCP server ${visible(o.server)} has stopped; the user can reconnect it from /mcp.`;
const restarted = (o: Offered) => `Stopped: the MCP server ${visible(o.server)} restarted while the call ran.`;

export function mcpTools(servers: Servers, bus: Bus, approve: Approve): { offer(): Offered[]; tool(o: Offered): Tool } {
  const said = new WeakSet<Promise<boolean>>(); // each new connection's grey line is said once, however many calls shared it

  // A dropped remote server's one new connection, through Servers, which says the stop when it fails (choices 13 and 33);
  // then the call is bound to the new connection, if the tool the model was shown is still offered, in the same view, with
  // the same definition (Servers.rebind). A stop ends the call's wait, and the connection goes on for the next call.
  async function again(o: Offered, signal?: AbortSignal): Promise<Offered> {
    const trying = servers.reconnect(o.server);
    // False also when another call's new connection was made first, which that call says; rebind then binds to it.
    if ((await until(trying, signal)) && !said.has(trying)) {
      said.add(trying);
      bus.emit("mcp-note", `MCP server ${visible(o.server)} was connected again.`);
    }
    const bound = servers.rebind(o);
    if ("reason" in bound) throw new Error(bound.reason === "stopped" ? stopped(o) : changed(o));
    return bound.offered;
  }

  // The call itself, ending as a restart says when its server restarted while it ran; a stop's error is left for the
  // session, which tells a stop by its signal.
  async function call(o: Offered, input: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    try {
      return await servers.server(o.server)!.callTool(o.tool, input, { signal });
    } catch (err) {
      if (!signal?.aborted && !(err instanceof NotReached) && servers.current(o) === "restarted") throw new Error(restarted(o));
      throw err;
    }
  }

  return {
    offer: () => servers.offer(),
    tool: (offered) => ({
      spec: offered.spec,
      async run(given, ctx) {
        const input = given as Record<string, unknown>; // an object, as both providers' tool input is (openai.ts, parseArgs)
        let o = offered;
        // First a dropped server's new connection (choice 33), then the question; a server that stopped for good has nothing
        // to run the call, so nobody is asked (Task 6's spec review).
        const state = servers.server(o.server)?.state;
        if (state?.is === "stopped" && state.retry) o = await again(o, ctx.signal);
        else if (servers.current(o) === "stopped") throw new Error(stopped(o));
        await approve(o, input, ctx);
        // Nothing reaches the server unless its tool is still the one shown, on the connection that showed it (finding 4).
        const now = servers.current(o);
        if (now === "changed" || now === "restarted") throw new Error(changed(o));
        if (now === "stopped") throw new Error(stopped(o));
        let result: CallToolResult;
        try {
          result = await call(o, input, ctx.signal);
        } catch (err) {
          // A request that never reached the server: the approved call never ran, so it goes once more on the new
          // connection, without a new question (choice 13: "Reconnect, then retry"). Any other drop fails it, and the next
          // call connects again first.
          if (!(err instanceof NotReached) || ctx.signal?.aborted) throw err;
          o = await again(o, ctx.signal);
          result = await call(o, input, ctx.signal);
        }
        return answer(result);
      },
    }),
  };
}

// `p`'s answer, or the stop's reason when `signal` stops the wait first.
function until<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

// The answer as the model reads it (choices 10-12): the text parts and a resource's text as the server sent them, joined
// with blank lines, the session cutting them at MAX_TOOL_OUTPUT; pictures passed on; any other kind named in a line;
// structured content as its JSON only when there is no text, as the text is the server's own rendering of it. An isError
// answer is a failed call, its text the error (Claude Code's MCP page), so PostToolUseFailure runs.
function answer(r: CallToolResult): string | { text: string; pictures: Picture[] } {
  const texts: string[] = [];
  const pictures: Picture[] = [];
  let worded = false;
  for (const c of r.content) {
    const words = c.type === "text" ? c.text : c.type === "resource" && "text" in c.resource ? c.resource.text : undefined;
    if (words !== undefined) {
      texts.push(words);
      worded = true;
    } else if (c.type === "image" && FORMATS.includes(c.mimeType)) {
      pictures.push({ mediaType: c.mimeType as Picture["mediaType"], data: Buffer.from(c.data, "base64") });
    } else {
      const kind = Object.hasOwn(KINDS, c.type) ? KINDS[c.type]! : visible(String(c.type), { tabs: true });
      texts.push(`[The tool's answer has ${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind} part, which Tachikoma does not pass on]`);
    }
  }
  if (!worded && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent));
  const text = texts.join("\n\n");
  if (r.isError) throw new Error(text);
  return pictures.length ? { text, pictures } : text;
}
