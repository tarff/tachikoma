import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginStore } from "../../src/auth/store.js";
import { listModels } from "../../src/providers/models.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Stands in for every provider's model list, by address.
function providers(routes: Record<string, (auth: string | null) => Response | Promise<Response>>) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    seen.push(url);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!route) throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    return route[1](headers.get("authorization") ?? headers.get("x-api-key"));
  });
  return seen;
}

function emptyData() {
  vi.stubEnv("TACHI_DATA_DIR", path.join(mkdtempSync(path.join(tmpdir(), "tachi-models-")), "data"));
}

describe("listModels", () => {
  it("asks only the providers that are set up, and Ollama, which needs no key", async () => {
    emptyData();
    const seen = providers({ "http://localhost:11434/v1/models": () => json({ data: [{ id: "qwen3:8b" }] }) });
    expect(await listModels(undefined, {})).toEqual([{ provider: "ollama", models: ["qwen3:8b"] }]);
    expect(seen).toEqual(["http://localhost:11434/v1/models"]);
  });

  it("shows a provider that fails, with the reason", async () => {
    emptyData();
    providers({ "https://api.openai.com/v1/models": () => json({ error: {} }, 401) });
    expect(await listModels(undefined, { OPENAI_API_KEY: "bad" })).toEqual([
      { provider: "openai", error: "key rejected" },
      { provider: "ollama", error: "not running" },
    ]);
  });

  it("reads Anthropic's list with the key, and follows OpenRouter's pages", async () => {
    emptyData();
    providers({
      "https://api.anthropic.com/v1/models": (key) => (key === "sk-ant" ? json({ data: [{ id: "claude-opus-5-5", type: "model" }], has_more: false }) : json({}, 401)),
      "https://openrouter.ai/api/v1/models?page=2": () => json({ data: [{ id: "b/2" }] }),
      "https://openrouter.ai/api/v1/models": () => json({ data: [{ id: "a/1" }], links: { next: "/api/v1/models?page=2" } }),
    });
    const groups = await listModels(undefined, { ANTHROPIC_API_KEY: "sk-ant", OPENROUTER_API_KEY: "sk-or" });
    expect(groups).toContainEqual({ provider: "anthropic", models: ["claude-opus-5-5"] });
    expect(groups).toContainEqual({ provider: "openrouter", models: ["a/1", "b/2"] });
  });

  it("lists the ChatGPT models meant to be shown, in OpenAI's order, when signed in", async () => {
    emptyData();
    const store = new LoginStore(process.env.TACHI_DATA_DIR!, () => {});
    await store.update(async (login, save) => {
      save({ ...login, active: { clientId: "c", sub: "s", planUse: true, tokens: { access: "plan-token", refresh: "r", expiresAt: Date.now() + 3_600_000, scopes: [] } } });
    });
    providers({
      "https://api.openai.com/v1/models": (auth) =>
        auth === "Bearer plan-token"
          ? json({ models: [{ slug: "z-model", visibility: "list" }, { slug: "hidden", visibility: "hide" }, { slug: "a-model", visibility: "list" }] })
          : json({}, 401),
    });
    expect(await listModels(undefined, {})).toContainEqual({ provider: "chatgpt", models: ["z-model", "a-model"] });
  });
});
