import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LoginStore } from "../../src/auth/store.js";
import { dataDir } from "../../src/core/datadir.js";
import { Session } from "../../src/core/session.js";
import { createProvider } from "../../src/providers/registry.js";
import { TOOLS } from "../../src/tools/index.js";
import { Bus, collectErrors, tempContext, texts } from "../helpers.js";

// The first real sign-in's checks (release 2 design, "Still to measure"). Run within an hour of
// `tachi login chatgpt`, before the login needs renewing:
//   TACHI_LIVE=1 npm test -- tests/live/chatgpt
// It prints what the plan's later tasks depend on: never a token, only sizes, types and model names.
// Reading the model list uses none of the plan's limit (models and inference page).
describe.skipIf(!process.env.TACHI_LIVE)("first real ChatGPT sign-in", () => {
  it("reports the saved login's shape and the account's model list", async () => {
    const active = new LoginStore(dataDir()).read().active;
    expect(active?.tokens, "Sign in first with `tachi login chatgpt`").toBeDefined();
    const t = active!.tokens!;
    const bytes = (s: string) => Buffer.byteLength(s, "utf8");
    const e = t.earliestRefreshAt;
    console.log(
      [
        `plan use granted: ${active!.planUse}`,
        `scopes: ${t.scopes.join(" ")}`,
        `token sizes in bytes: access ${bytes(t.access)}, refresh ${bytes(t.refresh)}`,
        `earliest_refresh_at: ${e === undefined ? "absent" : `${typeof e} ${JSON.stringify(e)}`}`,
        `seconds now: ${Math.floor(Date.now() / 1000)}; access token expires at second ${Math.floor(t.expiresAt / 1000)}`,
      ].join("\n"),
    );

    const res = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${t.access}` } });
    console.log(`model list: HTTP ${res.status}`);
    const body = (await res.json()) as { models?: Record<string, unknown>[] };
    console.log(`top-level fields: ${Object.keys(body).join(", ")}`);
    expect(Array.isArray(body.models)).toBe(true);
    for (const m of body.models!) {
      console.log(`${m.slug} | ${m.display_name} | visibility ${m.visibility} | context_window ${m.context_window ?? "absent"} | max_context_window ${m.max_context_window ?? "absent"}`);
    }
  }, 60_000);
});

// A full tool round on the plan: the call, its result and the model's next reply, with the tools
// grouped as the docs require. This uses the plan's limit. For example:
//   TACHI_LIVE=1 TACHI_LIVE_CHATGPT=gpt-6.1-sol npm test -- tests/live/chatgpt
const model = process.env.TACHI_LIVE_CHATGPT;
describe.skipIf(!process.env.TACHI_LIVE || !model)("a ChatGPT plan leading", () => {
  it("reads a file with a tool, and reports the token counts it was given", async () => {
    const ctx = await tempContext("never");
    await writeFile(path.join(ctx.root, "secret.txt"), "the word is pelican", "utf8");
    const bus = new Bus();
    const errors = collectErrors(bus);
    bus.on("usage", (u) => console.log(`usage: ${JSON.stringify(u.usage)}`));
    const session = new Session({ lead: createProvider(`chatgpt:${model}`), tools: TOOLS, system: "You are a test assistant.", ctx, bus });
    await session.send("Read secret.txt and tell me the word in it.");
    expect(errors).toEqual([]);
    expect(session.messages.some((m) => m.parts.some((p) => p.type === "tool_result" && !p.isError))).toBe(true);
    expect(texts(session.messages.at(-1)!).join(" ").toLowerCase()).toContain("pelican");
  }, 120_000);
});
