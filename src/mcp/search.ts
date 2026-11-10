import { z } from "zod";
import { visible } from "../core/permissions.js";
import type { ToolSpec } from "../core/types.js";
import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import { InvalidInput, type Tool } from "../tools/tool.js";
import type { Offer, Offered, Servers } from "./servers.js";

// Tool search (release 8c plan, Task 6b; choices 37-45): MCP tools are named in tool_search's description until the model
// loads them with it, so a request defines only the tools loaded so far, on every provider.

export const SEARCH = "tool_search";
// How many tools a query of words gives unless it asks for another number: Claude Code's ToolSearch's max_results
// default ("Numbers in this plan").
const MAX_RESULTS = 5;

// Claude Code's ToolSearch's input (choice 38).
const INPUT = z.object({ query: z.string(), max_results: z.number().int().min(1).optional() });
const { $schema: _, ...SCHEMA } = z.toJSONSchema(INPUT) as Record<string, unknown>;

// The words approved with the plan ("Lines this plan adds": tool_search's description and its answer).
const HEAD =
  'Finds MCP tools and loads them, so they can be called from the next step on. Search with words from a tool\'s name or what it does, or load tools by name with "select:<name>,<name>". MCP tools not loaded yet:';

// The servers still starting, failed or needing sign-in, each on its own line, under "Not ready:"; none, no lines.
function notReady(offer: Offer): string[] {
  if (!offer.notReady.length) return [];
  const said = ({ state }: Offer["notReady"][number]) =>
    state.is === "failed" ? `failed: ${state.reason}` : state.is === "needs sign-in" ? "needs sign-in, which the user does from /mcp" : "starting";
  return ["Not ready:", ...offer.notReady.map((n) => `${visible(n.server)}: ${said(n)}`)];
}

// tool_search's spec for a request, its description built from that request's offer (choice 37): per server its name and
// its instructions, then its tools' full names; then the servers not ready.
export function searchSpec(offer: Offer): ToolSpec {
  const servers = offer.named.flatMap((n) => [
    n.instructions ? `${visible(n.server)}: ${n.instructions}` : `${visible(n.server)}:`,
    `  ${n.tools.map((t) => t.spec.name).join(", ")}`,
  ]);
  return { name: SEARCH, description: [HEAD, ...servers, ...notReady(offer)].join("\n"), inputSchema: SCHEMA };
}

// Choice 38's ranking: a tool is found when one of the words is in its full name or its description, letter case
// ignored; tools holding more of the words, in either, each word counted once, come first; then those holding more of
// them in their name; then the order given (the user's choice, Task 6b's spec review). At most `max`, by full name.
export function find(query: string, max: number, tools: { full: string; description: string }[]): string[] {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  return tools
    .map((t, i) => {
      const name = t.full.toLowerCase();
      const text = t.description.toLowerCase();
      const held = words.filter((w) => name.includes(w) || text.includes(w)).length;
      const inName = words.filter((w) => name.includes(w)).length;
      return { full: t.full, held, inName, i };
    })
    .filter((r) => r.held > 0)
    .sort((a, b) => b.held - a.held || b.inName - a.inName || a.i - b.i)
    .slice(0, max)
    .map((r) => r.full);
}

// The session's tool_search over `servers` (choices 37-40, 43 and 44): `loaded` is its conversation's set, which a search
// adds to, so the next request defines what it found; `trustedOnly`, a subagent's, over its trusted read-only tools. It
// reads Tachikoma's own list, never a server, so it asks nothing and runs alongside other calls. Its spec is built from the
// offer as it is read.
export function searchTool(servers: Servers, loaded: Set<string>, opts: { trustedOnly?: boolean } = {}): Tool {
  const offer = () => servers.offer({ loaded, ...opts });
  return {
    get spec() {
      return searchSpec(offer());
    },
    parallel: true,
    async run(given, ctx) {
      const parsed = INPUT.safeParse(given);
      if (!parsed.success) throw new InvalidInput(`Invalid input for ${SEARCH}: ${z.prettifyError(parsed.error)}`);
      const { query, max_results = MAX_RESULTS } = parsed.data;
      // Servers still starting are waited for, within their start's limit, as Claude Code's search does (choice 40); a
      // stop ends the wait, and the session tells the model so.
      if (!(await servers.ready(ctx.signal))) throw ctx.signal?.reason;
      const o = offer();
      // Every tool, each as the model would be shown it, the loaded ones listed again (choice 39).
      const tools = [...o.defined, ...o.named.flatMap((n) => n.tools)];
      const named = new Set(o.named.flatMap((n) => n.tools.map((t) => t.spec.name)));
      const byName = (name: string) => tools.find((t) => t.spec.name === name);
      let found: Offered[];
      let unknown: string[] = [];
      const select = /^\s*select:/.exec(query);
      if (select) {
        const names = [...new Set(query.slice(select[0].length).split(",").map((n) => n.trim()).filter(Boolean))];
        found = names.flatMap((n) => byName(n) ?? []);
        unknown = names.filter((n) => !byName(n));
      } else {
        found = find(query, max_results, tools.map((t) => ({ full: t.spec.name, description: t.spec.description }))).map((n) => byName(n)!);
      }
      const unknownLines = unknown.length ? [unknown.map((u) => `No MCP tool is named ${u}.`).join("\n")] : [];
      if (!found.length) return [...(unknownLines.length ? unknownLines : [`No MCP tool matched "${query}".`]), ...notReady(o)].join("\n");
      // The answer with `shown` loaded; a select's `left` out, named in its line (the user's words, Task 6b's spec review).
      const answer = (shown: Offered[], left: Offered[]) => {
        const n = shown.length;
        const entries = shown.map((t) => `${t.spec.name}: ${t.spec.description}\nInput: ${JSON.stringify(t.spec.inputSchema)}`);
        const full = left.map((t) => t.spec.name).join(", ");
        return [
          `Loaded ${n} ${n === 1 ? "tool; call it" : "tools; call them"} from the next step on:\n${entries.join("\n\n")}`,
          ...unknownLines,
          ...(select && left.length ? [`Not loaded, as the answer is full: ${full}; load them with another search.`] : []),
        ].join("\n\n");
      };
      // The session cuts an answer at MAX_TOOL_OUTPUT, so the tools go in, in rank order, while the whole answer fits; the
      // first always does, the session's cut then applying to it (choice 39; the user's choice, Task 6b's spec review).
      let fits = 1;
      while (fits < found.length && answer(found.slice(0, fits + 1), found.slice(fits + 1)).length <= MAX_TOOL_OUTPUT) fits++;
      const shown = found.slice(0, fits);
      for (const t of shown) if (named.has(t.spec.name)) loaded.add(t.spec.name);
      return answer(shown, found.slice(fits));
    },
  };
}
