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

const OPENAI_BASE = "https://api.openai.com/v1";

// Why a list could not be read, in a few words.
function reason(err: unknown, provider: string): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return "key rejected";
  if (err instanceof Error && err.message === "fetch failed") return provider === "ollama" ? "not running" : `could not connect (${connectReason(err)})`;
  return errorText(err);
}

// An OpenAI-format list: `data`, each with an `id`. OpenRouter splits its list into pages linked by
// `links.next`.
async function openaiFormat(base: string, key: string | undefined, signal?: AbortSignal): Promise<string[]> {
  const ids: string[] = [];
  for (let url: string | undefined = `${base}/models`; url; ) {
    const res = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal });
    if (res.status === 401 || res.status === 403) throw new Error("key rejected");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown }[]; links?: { next?: unknown } };
    for (const m of body.data ?? []) if (typeof m.id === "string") ids.push(m.id);
    url = typeof body.links?.next === "string" && body.links.next ? new URL(body.links.next, url).href : undefined;
  }
  return ids;
}

export async function listModels(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<ModelGroup[]> {
  const asks: { provider: string; list: () => Promise<string[]> }[] = [];
  const auth = new ChatGPTAuth(new LoginStore(dataDir(), () => {}));
  let signedIn = true;
  try {
    auth.check();
  } catch {
    signedIn = false;
  }
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
    asks.push({ provider: kind, list: () => openaiFormat(preset.baseURL ?? OPENAI_BASE, key, signal) });
  }
  return Promise.all(
    asks.map(async ({ provider, list }): Promise<ModelGroup> => {
      try {
        return { provider, models: await list() }; // in the provider's own order, as OpenAI's docs ask for ChatGPT's
      } catch (err) {
        return { provider, error: reason(err, provider) };
      }
    }),
  );
}
