import OpenAI from "openai";
import type { ResponseInputItem, ResponseOutputItem, ResponseStreamEvent, ResponseUsage, Tool } from "openai/resources/responses/responses";
import type { Access, ChatGPTAuth } from "../auth/access.js";
import { USAGE_URL } from "../auth/chatgpt.js";
import { type CompletionRequest, connectReason, type Message, type Part, type Provider, type ToolSpec, type Turn } from "../core/types.js";
import { parseArgs } from "./openai.js";

// A ChatGPT plan leading, through OpenAI's Responses API (release 2 design, "Requests"; OpenAI's
// "models and inference" and "preview limitations" pages, read 2026-10-23).

export const API_BASE = "https://api.openai.com/v1";
// Tools are grouped in one namespace, as the preview limitations page requires. The shape is the
// openai package's `NamespaceTool` type (7.30.0).
const NAMESPACE = "tachikoma";

// From OpenAI's model pages, for when the account's model list gives no window (release 2 design,
// "Context window"). A model missing here shows the tokens in use instead of a percentage.
export const CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-6.1-sol": 1_050_000, // developers.openai.com/api/docs/models/gpt-6.1-sol, 2026-10-22
};

export const USAGE_LIMIT = `ChatGPT usage limit reached. Review your plan or this app's limit: ${USAGE_URL}`;

// The plan's errors, by OpenAI's code (errors and recovery page). Each stops the turn; none is retried.
function planError(code: string | null | undefined, status: number | undefined, message: string): Error {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return new Error(USAGE_LIMIT);
    case "subscription_sharing_user_not_eligible":
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return new Error(`This ChatGPT account cannot be used here (${code}). Use openai:<model> with an API key instead.`);
    case "subscription_sharing_invalid_user":
      return new Error(`OpenAI did not accept the ChatGPT sign-in (${code}). Sign in again with \`tachi login chatgpt\`.`);
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return new Error(`ChatGPT plan use is unavailable right now (${code}). Your sign-in is kept; try again later.`);
  }
  if (status === 401) return new Error(`OpenAI did not accept the ChatGPT sign-in (HTTP 401). Sign in again with \`tachi login chatgpt\`.`);
  if (status === 503) return new Error(`ChatGPT plan use is unavailable right now (HTTP 503). Your sign-in is kept; try again later.`);
  return new Error(`OpenAI refused the request${status ? ` (HTTP ${status}${code ? `, ${code}` : ""})` : code ? ` (${code})` : ""}: ${message}`);
}

export function toResponses(messages: Message[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      // A ChatGPT turn goes back exactly as it came, encrypted reasoning included. The openai package
      // says to send the completed items from `response.output_item.done` (ResponseReasoningItem).
      if (m.native?.provider === "chatgpt") {
        out.push(...(m.native.content as ResponseInputItem[]));
        continue;
      }
      for (const p of m.parts) {
        if (p.type === "text") out.push({ role: "assistant", content: p.text });
        else if (p.type === "tool_call") out.push({ type: "function_call", call_id: p.id, name: p.name, namespace: NAMESPACE, arguments: JSON.stringify(p.input) });
      }
      continue;
    }
    for (const p of m.parts) {
      if (p.type === "tool_result") out.push({ type: "function_call_output", call_id: p.callId, output: p.isError ? `Error: ${p.output}` : p.output });
      else if (p.type === "text") out.push({ role: "user", content: p.text });
    }
  }
  return out;
}

export function toolsFor(specs: ToolSpec[]): Tool[] {
  if (!specs.length) return [];
  return [
    {
      type: "namespace",
      name: NAMESPACE,
      description: "Tachikoma's tools, which act on the user's project.",
      tools: specs.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.inputSchema })),
    },
  ];
}

// The reply, from the stream's finished items. It counts as finished only on `response.completed`.
export async function fromStream(events: AsyncIterable<ResponseStreamEvent>, tools: ToolSpec[]): Promise<Turn> {
  const items: ResponseOutputItem[] = [];
  let usage: ResponseUsage | null | undefined;
  let incomplete: string | undefined;
  for await (const e of events) {
    if (e.type === "response.output_item.done") items.push(e.item);
    else if (e.type === "response.completed") {
      usage = e.response.usage;
      break;
    } else if (e.type === "response.incomplete") {
      usage = e.response.usage;
      incomplete = e.response.incomplete_details?.reason ?? "unknown";
      break;
    } else if (e.type === "response.failed") {
      const err = e.response.error;
      throw planError(err?.code, undefined, err?.message ?? "the reply failed");
    } else if (e.type === "error") {
      throw planError(e.code, undefined, e.message);
    }
  }
  if (usage === undefined && incomplete === undefined) throw new Error("The reply stopped before it finished");

  const parts: Part[] = [];
  let refusal: string | undefined;
  const known = new Set(tools.map((t) => t.name));
  for (const item of items) {
    if (item.type === "message") {
      for (const c of item.content) {
        if (c.type === "output_text" && c.text.trim()) parts.push({ type: "text", text: c.text });
        else if (c.type === "refusal") refusal = c.refusal;
      }
    } else if (item.type === "function_call") {
      // Mapped back to Tachikoma's tools. Anything else keeps its full name, which no tool has, so the
      // session refuses it as an unknown tool.
      const ours = (item.namespace === undefined || item.namespace === NAMESPACE) && known.has(item.name);
      parts.push({ type: "tool_call", id: item.call_id, name: ours ? item.name : `${item.namespace ?? ""}.${item.name}`, input: parseArgs(item.arguments) });
    }
  }
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const written = usage?.input_tokens_details?.cache_write_tokens ?? 0;
  const turn: Turn = {
    parts,
    native: { provider: "chatgpt", content: items },
    usage: { input: (usage?.input_tokens ?? 0) - cached - written, output: usage?.output_tokens ?? 0, cacheRead: cached, cacheWrite: written },
  };
  if (incomplete === "content_filter") turn.cutOff = { kind: "refusal", detail: "OpenAI's content filter stopped the response" };
  else if (incomplete) turn.cutOff = { kind: "max_tokens", detail: `The response stopped early (${incomplete})` };
  if (refusal) turn.cutOff = { kind: "refusal", detail: refusal };
  return turn;
}

// The account's own model list (models and inference page): `models`, each with `slug`,
// `display_name` and `visibility`. Codex also reads `context_window` from it.
export interface PlanModel {
  slug: string;
  name: string;
  listed: boolean; // `visibility: "list"`, the ones meant to be shown
  contextWindow: number | null;
}

export async function planModels(token: string, base = API_BASE, signal?: AbortSignal): Promise<PlanModel[]> {
  const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` }, signal });
  if (!res.ok) throw planError(undefined, res.status, "could not list the account's models");
  const body = (await res.json()) as { models?: Record<string, unknown>[] };
  if (!Array.isArray(body.models)) throw new Error("OpenAI's model list was not in the expected form");
  return body.models.flatMap((m) =>
    typeof m.slug === "string"
      ? [
          {
            slug: m.slug,
            name: typeof m.display_name === "string" ? m.display_name : m.slug,
            listed: m.visibility === "list",
            contextWindow: typeof m.context_window === "number" ? m.context_window : null,
          },
        ]
      : [],
  );
}

export class ChatGPTProvider implements Provider {
  readonly id: string;
  #models?: { account: string; list: PlanModel[] }; // for one account: fetched again after a switch

  constructor(
    readonly model: string,
    private readonly auth: ChatGPTAuth,
    private readonly base = API_BASE,
  ) {
    auth.check(); // signed out: an error that names the command, before any request
    this.id = `chatgpt:${model}`;
  }

  // Looked up once per account. A model the account does not offer is an error that lists the ones it does.
  async #model(login: Access, signal?: AbortSignal): Promise<PlanModel> {
    if (this.#models?.account !== login.account) this.#models = { account: login.account, list: await planModels(login.token, this.base, signal) };
    const found = this.#models.list.find((m) => m.slug === this.model);
    if (!found) {
      const offered = this.#models.list.filter((m) => m.listed).map((m) => `chatgpt:${m.slug}`);
      throw new Error(`Your ChatGPT account does not offer ${this.model}. It offers: ${offered.join(", ") || "no models"}`);
    }
    return found;
  }

  async complete({ system, messages, tools, signal }: CompletionRequest): Promise<Turn> {
    // Read again after the model check, so a logout while the model list was fetched is seen, and a
    // switch to another account is checked against that account's list.
    let login = await this.auth.token(signal);
    let checked: Access;
    do {
      checked = login;
      await this.#model(checked, signal);
      login = await this.auth.token(signal);
    } while (login.account !== checked.account);
    const { token } = login;
    // Made for each request with the token just read, so a renewed login is used at once. No retries:
    // retrying a usage limit only hits it again (errors and recovery page).
    const client = new OpenAI({ apiKey: token, baseURL: this.base, maxRetries: 0 });
    const toolList = toolsFor(tools);
    try {
      const stream = await client.responses.create(
        // Only fields the route accepts: no temperature, max_output_tokens or the like.
        { model: this.model, instructions: system, input: toResponses(messages), ...(toolList.length ? { tools: toolList } : {}), stream: true, store: false },
        { signal },
      );
      return await fromStream(stream, tools);
    } catch (err) {
      if (err instanceof OpenAI.APIConnectionTimeoutError) throw new Error(`${this.base} did not answer in time. Check your network.`, { cause: err });
      if (err instanceof OpenAI.APIConnectionError) throw new Error(`Could not reach ${this.base} (${connectReason(err)}). Check your network.`, { cause: err });
      if (err instanceof OpenAI.APIError) throw planError(err.code, err.status, err.message);
      throw err;
    }
  }

  async contextWindow(): Promise<number | null> {
    try {
      const m = await this.#model(await this.auth.token());
      return m.contextWindow ?? CONTEXT_WINDOWS[this.model] ?? null;
    } catch {
      return null;
    }
  }
}
