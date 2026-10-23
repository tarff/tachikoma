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

export const USAGE_LIMIT = `ChatGPT usage limit reached. Review your plan or this app's limit: ${USAGE_URL}`;

const SIGN_IN_AGAIN = "Sign out with `tachi logout chatgpt`, then sign in again with `tachi login chatgpt`.";

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

// What OpenAI said: an error object's `message`, or the `{"detail": "..."}` that can come back before a
// stream opens (errors and recovery page). Anything else, such as a web page, is not quoted.
function said(error: unknown): string | undefined {
  const e = error as { message?: unknown; detail?: unknown } | null | undefined;
  if (typeof e?.message === "string" && e.message.trim()) return e.message;
  if (typeof e?.detail === "string" && e.detail.trim()) return e.detail;
}

// A failure as OpenAI reports it. The errors and recovery page asks apps to keep the HTTP status, the
// code, `error.param` and the request ID.
interface Failure {
  code?: string | null;
  param?: string | null;
  status?: number;
  message?: string;
  requestId?: string | null;
}

// `text`, with OpenAI's request ID when there is one. The usage limit ends on an address, so a full
// stop goes after it before the next sentence.
const withId = (text: string, requestId?: string | null) => (requestId ? `${sentence(text)} OpenAI's request ID: ${requestId}.` : text);

// The plan's errors, by OpenAI's code (errors and recovery page). Each stops the turn; none is retried.
function planText({ code, param, status, message }: Failure): string {
  const why = message ? ` ${sentence(message)}` : "";
  const about = [status && `HTTP ${status}`, code, param && `about ${param}`].filter(Boolean).join(", ");
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return USAGE_LIMIT;
    case "subscription_sharing_user_not_eligible":
      return `This ChatGPT account cannot use its plan here (${code}).${why} Use openai:<model> with an API key instead.`;
    // "Check the client and grant configuration rather than retrying or changing billing."
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return `OpenAI says this ChatGPT sign-in's permissions do not cover the request (${code}).${why} Sign out with \`tachi logout chatgpt\`, then sign in again with \`tachi login chatgpt\` and allow plan use.`;
    case "subscription_sharing_invalid_user":
      return `OpenAI did not accept the ChatGPT sign-in (${code}).${why} ${SIGN_IN_AGAIN}`;
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return `ChatGPT plan use is unavailable right now (${code}).${why} Your sign-in is kept; try again later.`;
  }
  if (status === 401) return `OpenAI did not accept the ChatGPT sign-in (${about}).${why} ${SIGN_IN_AGAIN}`;
  if (status === 503) return `ChatGPT plan use is unavailable right now (${about}).${why} Your sign-in is kept; try again later.`;
  // A server error, or a reply that failed part way, is OpenAI failing rather than refusing. HTTP 429
  // is "too many requests" (RFC 6585).
  const what = status !== undefined && status < 500 ? "refused" : "could not complete";
  return `OpenAI ${what} the request${about ? ` (${about})` : ""}.${why}${status === 429 ? " Try again later." : ""}`;
}

const planError = (failure: Failure) => new Error(withId(planText(failure), failure.requestId));

// A connection that drops part way through a reply ends the stream with Node's bare "terminated", a
// TypeError from undici (the fetch under the SDK).
async function* dropped<T>(events: AsyncIterable<T>, requestId: string | null): AsyncGenerator<T> {
  try {
    yield* events;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    throw new Error(withId(`The connection to OpenAI dropped before the reply finished (${connectReason(err)}). Check your network and try again.`, requestId), { cause: err });
  }
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
export async function fromStream(events: AsyncIterable<ResponseStreamEvent>, tools: ToolSpec[], requestId?: string | null): Promise<Turn> {
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
      throw planError({ code: err?.code, message: said(err) ?? "The reply failed.", requestId });
    } else if (e.type === "error") {
      // Only an error event with no event name reaches here: the SDK throws a named `event: error`
      // itself (core/streaming.js), and complete() reads that one.
      throw planError({ code: e.code, param: e.param, message: said(e), requestId });
    }
  }
  if (usage === undefined && incomplete === undefined) throw new Error(withId("OpenAI's reply stopped before it finished. Try again.", requestId));

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
      // Mapped back to Tachikoma's tools, which may come with no namespace. Anything else keeps its full
      // name, which no tool has, so the session refuses it as an unknown tool.
      const ours = !item.namespace || (item.namespace === NAMESPACE && known.has(item.name));
      parts.push({ type: "tool_call", id: item.call_id, name: ours ? item.name : `${item.namespace}.${item.name}`, input: parseArgs(item.arguments) });
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
  else if (incomplete === "max_output_tokens") turn.cutOff = { kind: "max_tokens", detail: "The response reached its length limit" };
  else if (incomplete) turn.cutOff = { kind: "max_tokens", detail: `The response stopped early, for a reason OpenAI gives as "${incomplete}"` };
  if (refusal) turn.cutOff = { kind: "refusal", detail: refusal };
  return turn;
}

// The account's own model list (models and inference page): `models`, each with `slug` and
// `visibility`. Codex also reads `context_window` from it.
export interface PlanModel {
  slug: string;
  listed: boolean; // `visibility: "list"`, the ones meant to be shown
  contextWindow: number | null;
}

// The first request of a session's first `chatgpt:` turn, so its failures read like the turn's own.
export async function planModels(token: string, base = API_BASE, signal?: AbortSignal): Promise<PlanModel[]> {
  let res: Response;
  try {
    res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` }, signal });
  } catch (err) {
    if (signal?.aborted || !(err instanceof Error)) throw err;
    throw new Error(`Could not reach ${base} (${connectReason(err)}). Check your network.`, { cause: err });
  }
  const body = (await res.json().catch(() => undefined)) as { error?: Record<string, unknown>; models?: Record<string, unknown>[] } | undefined;
  signal?.throwIfAborted();
  if (!res.ok) {
    const error: Record<string, unknown> | undefined = body?.error ?? body; // the `{"detail": "..."}` form has no `error`
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    throw planError({ code: str(error?.code), param: str(error?.param), status: res.status, message: said(error), requestId: res.headers.get("x-request-id") });
  }
  if (!Array.isArray(body?.models)) throw new Error(withId("OpenAI's model list could not be read. Check your network and try again.", res.headers.get("x-request-id")));
  return body.models.flatMap((m) =>
    typeof m.slug === "string"
      ? [
          {
            slug: m.slug,
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
      throw new Error(`Your ChatGPT account does not offer ${this.model}. ${offered.length ? `It offers: ${offered.join(", ")}.` : "It offers no models."}`);
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
      const { data: stream, request_id } = await client.responses
        .create(
          // Only fields the route accepts: no temperature, max_output_tokens or the like.
          { model: this.model, instructions: system, input: toResponses(messages), ...(toolList.length ? { tools: toolList } : {}), stream: true, store: false },
          { signal },
        )
        .withResponse();
      return await fromStream(dropped(stream, request_id), tools, request_id);
    } catch (err) {
      if (signal?.aborted) throw err; // Ctrl-C, passed on as it is (the SDK's abort error is an APIError)
      if (err instanceof OpenAI.APIConnectionTimeoutError) throw new Error(`${this.base} did not answer in time. Check your network.`, { cause: err });
      if (err instanceof OpenAI.APIConnectionError) throw new Error(`Could not reach ${this.base} (${connectReason(err)}). Check your network.`, { cause: err });
      // The SDK's own message repeats the status and quotes any body, so OpenAI's text is taken from the body.
      if (err instanceof OpenAI.APIError) throw planError({ code: err.code, param: err.param, status: err.status, message: said(err.error), requestId: err.requestID });
      throw err;
    }
  }

  // From the model list the last request fetched, so the status line never reads or renews the login:
  // a renewal there that found the login dead would clear it unseen. Unknown until the first reply.
  async contextWindow(): Promise<number | null> {
    return this.#models?.list.find((m) => m.slug === this.model)?.contextWindow ?? null;
  }
}
