import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { OPENAI_WINDOWS, openaiWindow } from "../../src/providers/windows.js";

// The release 6 design's table, as read from OpenAI's model pages on 2026-10-28.
const ROWS: [number, string[]][] = [
  [
    1_050_000,
    [
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-5.6-sol",
      "gpt-5.6",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-pro",
    ],
  ],
  [1_047_576, ["gpt-4.1", "gpt-4.1-mini"]],
  [
    400_000,
    [
      "gpt-5.6-cyber",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.3-codex",
      "gpt-5.2",
      "gpt-5.2-pro",
      "gpt-5.1",
      "gpt-5-pro",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "chat-latest",
    ],
  ],
  [200_000, ["o3", "o3-pro"]],
  [131_072, ["gpt-oss-120b", "gpt-oss-20b"]],
  [128_000, ["gpt-4o", "gpt-4o-mini"]],
];

describe("openaiWindow", () => {
  it.each(ROWS)("gives %i for its row's models", (window, models) => {
    for (const m of models) expect(openaiWindow(m), m).toBe(window);
  });

  it("holds the design's models and no others", () => {
    expect(Object.keys(OPENAI_WINDOWS).sort()).toEqual(ROWS.flatMap(([, models]) => models).sort());
  });

  it("finds a dated snapshot's model, listed on its page or not", () => {
    expect(openaiWindow("gpt-5.5-2026-04-23")).toBe(1_050_000);
    expect(openaiWindow("gpt-4o-2024-05-13")).toBe(128_000); // listed as shut down
    expect(openaiWindow("o3-pro-2025-06-10")).toBe(200_000);
    expect(openaiWindow("gpt-5.5-2026-09-01")).toBe(1_050_000); // a later snapshot no page lists yet
  });

  it("gives null for a model not in the table", () => {
    expect(openaiWindow("gpt-5.5-mini")).toBeNull(); // only a date is taken off
    expect(openaiWindow("gpt-3.5-turbo")).toBeNull();
    expect(openaiWindow("gpt-5.5-2026-04")).toBeNull();
    expect(openaiWindow("constructor")).toBeNull();
  });
});

describe("OpenAIProvider.contextWindow", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const lead = (kind: string, model: string, base?: string) => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    vi.stubEnv("MOONSHOT_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", base ?? "");
    return new OpenAIProvider(kind, model);
  };

  it("answers from the table on OpenAI's own address", async () => {
    expect(await lead("openai", "gpt-5.5").contextWindow()).toBe(1_050_000);
    expect(await lead("openai", "gpt-4o", "https://api.openai.com/v1").contextWindow()).toBe(128_000);
    expect(await lead("openai", "o3", "https://api.openai.com/v1/").contextWindow()).toBe(200_000);
    expect(await lead("openai", "gpt-5.5-mini").contextWindow()).toBeNull(); // not in the table: the tokens in use are shown
  });

  it("answers null at another address, which may serve other models under the same names", async () => {
    expect(await lead("openai", "gpt-5.5", "https://proxy.example/v1").contextWindow()).toBeNull();
    expect(await lead("openai", "gpt-5.5", "http://api.openai.com/v1").contextWindow()).toBeNull();
    expect(await lead("openrouter", "gpt-5.5").contextWindow()).toBeNull();
    expect(await lead("kimi", "gpt-5.5").contextWindow()).toBeNull();
    expect(await lead("ollama", "gpt-oss-20b").contextWindow()).toBeNull();
  });
});
