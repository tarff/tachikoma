import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginStore } from "../../src/auth/store.js";
import { listModels } from "../../src/providers/models.js";

// The system keychain is never asked here: keys are kept in this map instead.
const keys = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/auth/keychain.js", async (original) => ({
  ...(await original<typeof import("../../src/auth/keychain.js")>()),
  systemKeychain: () => ({ read: (name: string) => keys.get(name) ?? null, write: (name: string, text: string) => void keys.set(name, text), clear: (name: string) => void keys.delete(name) }),
}));

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
    expect(await listModels(undefined, { OPENAI_API_KEY: "bad" })).toEqual([{ provider: "openai", error: "key rejected" }]);
  });

  it("leaves Ollama out when it is not running", async () => {
    emptyData();
    const seen = providers({});
    expect(await listModels(undefined, {})).toEqual([]);
    expect(seen).toEqual(["http://localhost:11434/v1/models"]);
  });

  it("says in a few words why a list could not be read, sending each provider its key", async () => {
    emptyData();
    providers({
      "https://api.anthropic.com/v1/models": () => json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400),
      "https://api.openai.com/v1/models": (key) => (key === "Bearer sk-oa" ? json({}, 500) : json({}, 401)),
      "https://openrouter.ai/api/v1/models": () => new Response("<html>wifi</html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(await listModels(undefined, { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oa", OPENROUTER_API_KEY: "sk-or", MOONSHOT_API_KEY: "sk-k" })).toEqual([
      { provider: "anthropic", error: "HTTP 400" },
      { provider: "openai", error: "HTTP 500" },
      { provider: "openrouter", error: "the answer was not a model list" },
      { provider: "kimi", error: "could not connect: connect ECONNREFUSED" },
    ]);
    providers({ "https://api.anthropic.com/v1/models": () => json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401) });
    expect(await listModels(undefined, { ANTHROPIC_API_KEY: "bad" })).toEqual([{ provider: "anthropic", error: "key rejected" }]);
  });

  it("says when Anthropic cannot be reached, as for the others", async () => {
    emptyData();
    providers({});
    expect(await listModels(undefined, { ANTHROPIC_API_KEY: "sk-ant" })).toEqual([{ provider: "anthropic", error: "could not connect: connect ECONNREFUSED" }]);
  });

  it("follows a next page only on the same site, and only once", async () => {
    emptyData();
    const seen = providers({
      "https://elsewhere.example/": () => json({ data: [{ id: "stolen" }] }),
      "https://openrouter.ai/api/v1/models?page=2": () => json({ data: [{ id: "b/2" }], links: { next: "/api/v1/models?page=2" } }),
      "https://openrouter.ai/api/v1/models": () => json({ data: [{ id: "a/1" }], links: { next: "/api/v1/models?page=2" } }),
      "https://api.openai.com/v1/models": () => json({ data: [{ id: "gpt" }], links: { next: "https://elsewhere.example/steal" } }),
    });
    expect(await listModels(undefined, { OPENAI_API_KEY: "sk-oa", OPENROUTER_API_KEY: "sk-or" })).toEqual([
      { provider: "openai", error: "its next page is on another site" },
      { provider: "openrouter", models: ["a/1", "b/2"] },
    ]);
    expect(seen.filter((url) => url.startsWith("https://elsewhere"))).toEqual([]);
  });

  it("asks every provider at once", async () => {
    emptyData();
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    providers({
      "https://api.openai.com/v1/models": async () => {
        await both; // answers only once OpenRouter has been asked too
        return json({ data: [{ id: "gpt" }] });
      },
      "https://openrouter.ai/api/v1/models": () => {
        release();
        return json({ data: [{ id: "a/1" }] });
      },
    });
    expect(await listModels(undefined, { OPENAI_API_KEY: "sk-oa", OPENROUTER_API_KEY: "sk-or" })).toEqual([
      { provider: "openai", models: ["gpt"] },
      { provider: "openrouter", models: ["a/1"] },
    ]);
  });

  it("says so when an answer is not a model list", async () => {
    emptyData();
    providers({
      "https://api.openai.com/v1/models": () => json(null),
      "https://openrouter.ai/api/v1/models": () => json({ data: {} }),
      "https://api.moonshot.ai/v1/models": () => json({ data: [null, { id: "kimi-k3" }] }),
    });
    expect(await listModels(undefined, { OPENAI_API_KEY: "sk-oa", OPENROUTER_API_KEY: "sk-or", MOONSHOT_API_KEY: "sk-k" })).toEqual([
      { provider: "openai", error: "the answer was not a model list" },
      { provider: "openrouter", error: "the answer was not a model list" },
      { provider: "kimi", models: ["kimi-k3"] },
    ]);
  });

  it("asks OpenAI at OPENAI_BASE_URL when it is set, as the OpenAI SDK does for openai: leads", async () => {
    emptyData();
    const seen = providers({ "https://proxy.example/v1/models": () => json({ data: [{ id: "via-proxy" }] }) });
    expect(await listModels(undefined, { OPENAI_API_KEY: "sk-oa", OPENAI_BASE_URL: "https://proxy.example/v1" })).toEqual([
      { provider: "openai", models: ["via-proxy"] },
    ]);
    expect(seen).not.toContain("https://api.openai.com/v1/models");
    expect(await listModels(undefined, { OPENAI_API_KEY: "sk-oa", OPENAI_BASE_URL: "https://proxy.example/v1/" })).toEqual([
      { provider: "openai", models: ["via-proxy"] },
    ]);
  });

  it("shows a sealed ChatGPT login that cannot be opened, with why", async () => {
    emptyData();
    const store = new LoginStore(process.env.TACHI_DATA_DIR!, () => {});
    await store.update(async (login, save) => {
      save({ ...login, keychain: true, active: { clientId: "c", sub: "s", planUse: true, tokens: { access: "t", refresh: "r", expiresAt: Date.now() + 3_600_000, scopes: [] } } });
    });
    keys.clear(); // the key is gone
    providers({});
    expect(await listModels(undefined, {})).toEqual([
      { provider: "chatgpt", error: "The saved ChatGPT login cannot be opened. Sign out with `tachi logout chatgpt` (or /logout chatgpt in a session), then sign in again, or choose another lead (--lead, or /lead in a session)." },
    ]);
  });

  it("shows a ChatGPT sign-in that cannot be used, with why", async () => {
    emptyData();
    const store = new LoginStore(process.env.TACHI_DATA_DIR!, () => {});
    await store.update(async (login, save) => {
      save({ ...login, active: { clientId: "c", sub: "s", planUse: false, tokens: { access: "t", refresh: "r", expiresAt: Date.now() + 3_600_000, scopes: [] } } });
    });
    providers({});
    expect(await listModels(undefined, {})).toEqual([
      { provider: "chatgpt", error: "This ChatGPT sign-in does not allow using your plan. Sign out with `tachi logout chatgpt` (or /logout chatgpt in a session), sign in again and allow it, or use openai:<model> with an API key." },
    ]);
    writeFileSync(store.file, "{ not json");
    expect(await listModels(undefined, {})).toEqual([{ provider: "chatgpt", error: expect.stringContaining("is damaged") }]);
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
