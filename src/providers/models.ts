import Anthropic from "@anthropic-ai/sdk";
import { ChatGPTAuth } from "../auth/access.js";
import { LoginStore } from "../auth/store.js";
import { dataDir } from "../core/datadir.js";
import { connectReason, errorText } from "../core/types.js";
import { API_BASE, planModels } from "./chatgpt.js";
import { PRESETS } from "./openai.js";

// The models of every provider that is set up, for `/model` (release 2 design, "The model picker").
// Each is asked at once, at its own model-list address, checked 2026-10-23 against its docs:
// Anthropic GET /v1/models (platform.claude.com/docs/en/api/models/list), OpenAI GET /v1/models
// (developers.openai.com/api/reference/resources/models/methods/list), OpenRouter GET /api/v1/models
// (openrouter.ai/docs/api-reference/models/get-models), Kimi GET /v1/models
// (platform.kimi.ai/docs/api/list-models.md), Ollama's OpenAI-compatible GET /v1/models
// (docs.ollama.com/api/openai-compatibility).

export type ModelGroup = { provider: string; models: string[] } | { provider: string; error: string };

// OpenAI's own address, unless OPENAI_BASE_URL is set: the OpenAI SDK reads it for openai: leads, so
// the list comes from where they go. One slash at the end is dropped, as the SDK does.
const OPENAI_BASE = "https://api.openai.com/v1";

const fetchFailed = (err: unknown) => err instanceof Error && err.message === "fetch failed"; // Node's fetch

// Why a list could not be read, in a few words.
function reason(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return "key rejected";
  if (err instanceof Anthropic.APIConnectionError || fetchFailed(err)) return `could not connect: ${connectReason(err as Error)}`;
  if (err instanceof Anthropic.APIError) return `HTTP ${err.status}`;
  return errorText(err);
}

// An OpenAI-format list: `data`, each with an `id`. OpenRouter splits its list into pages linked by
// `links.next`. A next page is followed only on the same site, since it is sent the key, and only once.
async function openaiFormat(base: string, key: string | undefined, signal?: AbortSignal): Promise<string[]> {
  const ids: string[] = [];
  const asked = new Set<string>();
  for (let url: string | undefined = `${base.replace(/\/$/, "")}/models`; url && !asked.has(url); ) {
    asked.add(url);
    const res = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal });
    if (res.status === 401 || res.status === 403) throw new Error("key rejected");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json().catch(() => {
      throw new Error("the answer was not a model list"); // a Wi-Fi sign-in page, say
    })) as { data?: unknown; links?: { next?: unknown } } | null;
    const data = body?.data;
    if (!Array.isArray(data)) throw new Error("the answer was not a model list");
    for (const m of data as ({ id?: unknown } | null)[]) if (typeof m?.id === "string") ids.push(m.id);
    const link = body?.links?.next;
    const next: URL | undefined = typeof link === "string" && link ? new URL(link, url) : undefined;
    if (next && next.origin !== new URL(url).origin) throw new Error("its next page is on another site");
    url = next?.href;
  }
  return ids;
}

// `warn` shows what reading the saved login says, such as a wait for another process.
export async function listModels(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = () => {}): Promise<ModelGroup[]> {
  const asks: { provider: string; list: () => Promise<string[]> }[] = [];
  const store = new LoginStore(dataDir(), warn);
  // ChatGPT is asked when a sign-in is saved; one that cannot be used is shown, with why.
  let signedIn = true;
  try {
    signedIn = Boolean(store.read().active?.tokens);
  } catch {} // a damaged file: asking says so
  const auth = new ChatGPTAuth(store);
  if (signedIn) asks.push({ provider: "chatgpt", list: async () => (await planModels((await auth.token(signal)).token, API_BASE, signal)).filter((m) => m.listed).map((m) => m.slug) });
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    asks.push({
      provider: "anthropic",
      list: async () => {
        const ids: string[] = [];
        // An API key only, as in anthropic.ts.
        for await (const m of new Anthropic({ apiKey: anthropicKey, authToken: null }).models.list({}, { signal })) ids.push(m.id);
        return ids;
      },
    });
  }
  for (const [kind, preset] of Object.entries(PRESETS)) {
    const key = preset.keyEnv ? env[preset.keyEnv] : undefined;
    if (preset.keyEnv && !key) continue; // not set up
    asks.push({ provider: kind, list: () => openaiFormat(preset.baseURL ?? (env.OPENAI_BASE_URL || OPENAI_BASE), key, signal) });
  }
  const groups = await Promise.all(
    asks.map(async ({ provider, list }): Promise<ModelGroup[]> => {
      try {
        return [{ provider, models: await list() }]; // in the provider's own order, as OpenAI's docs ask for ChatGPT's
      } catch (err) {
        // Ollama needs no key, so it is always asked; it is listed only when it is running.
        if (provider === "ollama" && fetchFailed(err)) return [];
        return [{ provider, error: reason(err) }];
      }
    }),
  );
  return groups.flat();
}
