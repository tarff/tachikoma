import type { CallToolResult } from "@modelcontextprotocol/client";
import type { Bus } from "../core/bus.js";
import { visible } from "../core/permissions.js";
import type { Picture } from "../core/types.js";
import type { Tool, ToolContext } from "../tools/tool.js";
import { typeOf } from "../tui/clipboard.js";
import { searchSpec, searchTool } from "./search.js";
import { NotReached } from "./server.js";
import type { Offered, Servers } from "./servers.js";

// The MCP servers' tools in the session (release 8c plan, Task 6; design, "Tools for the model"; choices 9-13 and 33):
// each call runs on the connection and definition its request offered, or is refused with a line saying why (design,
// finding 4).

// The question for a call, Task 7's gate (approveOf), which throws to refuse it. It has no default, so no MCP tool
// reaches a session without one (Task 6's security check). It is asked after a dropped server's new connection, so the
// approval is for the version that runs (choice 33), and before the check that nothing changed while the call waited
// (finding 4). A test gives one that waits, to change things while a call waits for it.
export type Approve = (o: Offered, input: Record<string, unknown>, ctx: ToolContext) => Promise<void>;

// Choice 11's names for the kinds of content an answer can hold that are not passed on, in MCP's own types.
const KINDS: Record<string, string> = { image: "image", audio: "audio", resource_link: "resource link", resource: "embedded resource" };

// The lines to the model ("Lines this plan adds", "Calls"), the server's and the tool's names escaped, as they come from
// the settings and the server.
const changed = (o: Offered) =>
  `Not run: ${visible(o.server)}'s tool "${visible(o.tool, { tabs: true })}" changed while this call waited; ` +
  "look at its definition in this request's tools, if it is still there, and call it again.";
const stopped = (o: Offered) => `The MCP server ${visible(o.server)} has stopped; the user can reconnect it from /mcp.`;
const restarted = (o: Offered) => `Stopped: the MCP server ${visible(o.server)} restarted while the call ran.`;
const untrusted = (o: Offered) =>
  `Not run: ${visible(o.server)}'s "${visible(o.tool, { tabs: true })}" is no longer trusted as read-only, and subagents only read.`;

// The launch's question for every call, the lead's and its subagents' (release 8c plan, Task 7; design, "Approval";
// choices 14-17). Trust is read here, from the entry in force, right before the gate would decide, so a live edit applies
// to every call not yet decided; a trusted call skips the gate's question and the judge in every mode (choice 16). A
// subagent's call to a tool no longer trusted is refused, as subagents only read (choice 17). Else the gate decides:
// the question is the server, the tool and its input as JSON, which the gate escapes, its grey note the first line of
// the tool's own description, as the server sent it (choices 14 and 47), and the judge is shown the 4,096 cut (choice 15;
// Task 6b). `outside` is true, as the server runs apart from the project; only the judge reads it, since the gate decides
// an MCP call by its kind (release 8c plan, choice 32).
export function approveOf(servers: Servers): Approve {
  return async (o, input, ctx) => {
    if (servers.trust(o.server, o.tool)) return;
    if (o.trustedOnly) throw new Error(untrusted(o));
    const summary = `${o.server}: ${o.tool} ${JSON.stringify(input)}`;
    await ctx.gate.require({ kind: "mcp", outside: true, summary, description: o.forJudge, note: o.forNote }, ctx.signal);
  };
}

// A session's MCP tools (Task 6b; choices 37-43): `loaded`, the conversation's loaded set, which the session saves and a
// load replaces; `offer()`, the tools one request defines, and tool_search with its description for that request, none
// with no MCP server in force; `tool`, the tool for one offered.
export interface McpTools {
  loaded: Set<string>;
  offer(): { defined: Offered[]; search?: Tool };
  tool(o: Offered): Tool;
}

// `trustedOnly`: a subagent's, its trusted read-only tools only, with its own loaded set (choice 43).
export function mcpTools(servers: Servers, bus: Bus, approve: Approve, opts: { trustedOnly?: boolean } = {}): McpTools {
  const said = new WeakSet<Promise<boolean>>(); // each new connection's grey line is said once, however many calls shared it
  const loaded = new Set<string>();
  const search = searchTool(servers, loaded, opts);

  // The call bound to its server's connection now, if the tool the model was shown is still offered by the same server, in
  // the same view, with the same definition (Servers.rebind): one another call connected again is taken as it is. A server
  // not running gets its one new connection first, through Servers, which says the stop when it fails (choices 13 and 33);
  // only the call whose new connection it was says the grey line. A stop ends the call's wait, and the connection goes on
  // for the next call.
  async function again(o: Offered, signal?: AbortSignal): Promise<Offered> {
    let bound = servers.rebind(o);
    if ("reason" in bound && bound.reason === "stopped") {
      const trying = servers.reconnect(o.server); // false for a server with none to try, or ready again meanwhile
      if ((await until(trying, signal)) && !said.has(trying)) {
        said.add(trying);
        bus.emit("mcp-note", `MCP server ${visible(o.server)} was connected again.`);
      }
      bound = servers.rebind(o);
    }
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
    loaded,
    // One offer for both, so tool_search names exactly the tools this request does not define.
    offer() {
      const o = servers.offer({ loaded, ...opts });
      if (!servers.list().length) return { defined: o.defined };
      return { defined: o.defined, search: { spec: searchSpec(o), run: (input, ctx) => search.run(input, ctx), parallel: true } };
    },
    tool: (offered) => ({
      spec: offered.spec,
      async run(given, ctx) {
        const input = given as Record<string, unknown>; // an object, as both providers' tool input is (openai.ts, parseArgs)
        let o = offered;
        // First the call is bound to its server's connection now: a dropped one's new connection (choice 33), or one an
        // earlier call made (Task 6's code review); then the question. A server that stopped for good has nothing to run
        // the call, and one a live edit replaced is not the one shown, so nobody is asked (Task 6's spec review).
        const was = servers.current(o);
        if (was === "stopped" || was === "restarted") o = await again(o, ctx.signal);
        // A tool already changed, or whose server left the settings, cannot run, so nobody is asked about it (Task 7's code
        // review). A subagent's view also calls a tool whose trust has gone "changed"; approve's own line says why.
        if (!o.trustedOnly && servers.current(o) === "changed") throw new Error(changed(o));
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
          // connection, without a new question (choice 13: "Reconnect, then retry"), but only to the server it was approved
          // for: rebind refuses one a live edit replaced meanwhile (Task 6's code review). Any other drop fails it, and the
          // next call connects again first.
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
  const pictures: Picture[] = [];
  const text = answerText(r, (c) => {
    // A picture's type from its first bytes, as a pasted one's, never the type the server states (Task 6's code review).
    const data = c.type === "image" ? Buffer.from(c.data, "base64") : undefined;
    const mediaType = data && typeOf(data);
    if (data && mediaType) {
      pictures.push({ mediaType, data });
      return undefined;
    }
    const kind = Object.hasOwn(KINDS, c.type) ? KINDS[c.type]! : visible(String(c.type), { tabs: true });
    return `[The tool's answer has ${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind} part, which Tachikoma does not pass on]`;
  });
  if (r.isError) throw new Error(text);
  return pictures.length ? { text, pictures } : text;
}

// An answer's text, for the model and for an mcp_tool hook alike (release 8c plan, choices 10-12 and 21): the text parts
// and a resource's text, joined with blank lines; structured content as its JSON only when there is no text. `other`
// gives each other part's line in its place, or none: the model's view names the kinds it does not pass on, and a hook
// reads the text alone.
export function answerText(r: CallToolResult, other: (c: CallToolResult["content"][number]) => string | undefined = () => undefined): string {
  const texts: string[] = [];
  let worded = false;
  for (const c of r.content) {
    const words = c.type === "text" ? c.text : c.type === "resource" && "text" in c.resource ? c.resource.text : undefined;
    if (words !== undefined) {
      texts.push(words);
      worded = true;
      continue;
    }
    const line = other(c);
    if (line !== undefined) texts.push(line);
  }
  if (!worded && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent));
  return texts.join("\n\n");
}
