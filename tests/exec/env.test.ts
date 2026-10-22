import { describe, expect, it } from "vitest";
import { API_KEYS, commandEnv } from "../../src/exec/env.js";
import { PRESETS } from "../../src/providers/openai.js";

describe("commandEnv", () => {
  it("covers every key a provider reads", () => {
    const read = ["ANTHROPIC_API_KEY", ...Object.values(PRESETS).flatMap((p) => (p.keyEnv ? [p.keyEnv] : []))];
    expect(API_KEYS.toSorted()).toEqual(read.toSorted());
  });

  it("drops the API keys, in any case, and keeps everything else", () => {
    const env = commandEnv({ PATH: "/bin", OPENAI_API_KEY: "sk-1", openrouter_api_key: "sk-2", MY_API_KEY: "mine" });
    expect(env).toEqual({ PATH: "/bin", MY_API_KEY: "mine" });
  });
});
