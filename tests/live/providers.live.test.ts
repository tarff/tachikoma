import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Session } from "../../src/core/session.js";
import { createProvider } from "../../src/providers/registry.js";
import { TOOLS } from "../../src/tools/index.js";
import { Bus, collectErrors, tempContext, texts } from "../helpers.js";

// Calls real APIs and costs real money, so it runs only with TACHI_LIVE=1, for example:
//   TACHI_LIVE=1 TACHI_LIVE_LEADS=anthropic:claude-opus-5-5,openai:<model> npm test -- tests/live
const leads = (process.env.TACHI_LIVE_LEADS ?? "").split(",").filter(Boolean);

describe.skipIf(!process.env.TACHI_LIVE || leads.length === 0)("live providers", () => {
  it.each(leads)("%s reads a file with a tool and reports what it says", async (spec) => {
    const ctx = await tempContext("never");
    await writeFile(path.join(ctx.root, "secret.txt"), "the word is pelican", "utf8");
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: createProvider(spec), tools: TOOLS, system: "You are a test assistant.", ctx, bus });
    await session.send("Read secret.txt and tell me the word in it.");
    expect(errors).toEqual([]);
    expect(texts(session.messages.at(-1)!).join(" ").toLowerCase()).toContain("pelican");
  }, 120_000);

  it("keeps working when the lead changes mid-conversation", async () => {
    if (leads.length < 2) return;
    const ctx = await tempContext("never");
    const bus = new Bus();
    const session = new Session({ lead: createProvider(leads[0]!), tools: TOOLS, system: "You are a test assistant.", ctx, bus });
    await session.send("Remember this number: 7341. Just say ok.");
    session.setLead(createProvider(leads[1]!));
    await session.send("What number did I ask you to remember?");
    expect(texts(session.messages.at(-1)!).join(" ")).toContain("7341");
  }, 120_000);
});
