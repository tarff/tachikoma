// Release 8a's live tests (release 8a plan, Task 1): what each provider really answers when a conversation is too long,
// whether Anthropic takes a resumed conversation whose system prompt changed, and what Anthropic's token count accepts.
// Not part of Tachikoma: run by hand with your own keys, after `npm run build`, as it uses the built providers in dist/.
//
//   node scripts/live-8a.mjs anthropic:claude-opus-5-5 openai:gpt-5.5 chatgpt:gpt-5.6 openrouter:openai/gpt-5.5
//   node scripts/live-8a.mjs --only 2,3 anthropic:claude-opus-5-5
//
// Name one model per provider to try. Keys come from the environment only (ANTHROPIC_API_KEY, OPENAI_API_KEY,
// OPENROUTER_API_KEY), and the ChatGPT plan from the saved sign-in, as tachi uses them. No key is ever printed.
//
// 1. "Too long": one request just over each named model's window, made of one repeated word. On Anthropic the word
//    count comes from Anthropic's own token count, which is free, so the request is one token over; elsewhere the
//    window's number of words is sent, each " the" being one token. OpenRouter's window and price come from its public
//    model list (openrouter.ai/api/v1/models), and are printed before the request. The status, the error's type and code, and the
//    first 200 characters of its message are printed (200 is a display cut, not a setting).
// 2. Resuming Anthropic: a two-turn conversation with a tool call, then a third turn sent three ways: the same system
//    prompt; a changed one with the thinking blocks kept; a changed one with Tachikoma's own record in place of them.
// 3. Anthropic's count of a request holding a tool, a picture and the fallback setting.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";

if (!existsSync(new URL("../dist/providers/anthropic.js", import.meta.url))) {
  console.error("Run `npm run build` first: this script uses the built providers in dist/.");
  process.exit(2);
}
const { AnthropicProvider } = await import("../dist/providers/anthropic.js");
const { OpenAIProvider } = await import("../dist/providers/openai.js");
const { ChatGPTProvider, planModels } = await import("../dist/providers/chatgpt.js");
const { ChatGPTAuth } = await import("../dist/auth/access.js");
const { LoginStore } = await import("../dist/auth/store.js");
const { dataDir } = await import("../dist/core/datadir.js");

const args = process.argv.slice(2);
const at = args.indexOf("--only");
const only = at >= 0 ? new Set(args.splice(at, 2)[1]?.split(",")) : new Set(["1", "2", "3"]);
const specs = args;
if (!specs.length || specs.some((s) => !/^(anthropic|openai|chatgpt|openrouter):./.test(s))) {
  console.error("Name the models to try, one per provider: anthropic:<model>, openai:<model>, chatgpt:<model>, openrouter:<model>.");
  process.exit(2);
}
const anthropicSpec = specs.find((s) => s.startsWith("anthropic:"));
const SYSTEM = "You are taking part in a test of Tachikoma, a coding assistant.";

// What a failure says, from the SDKs' error objects and Tachikoma's own.
function failure(err) {
  const body = err?.error?.error ?? err?.error ?? {};
  const message = String(body.message ?? err?.message ?? err).slice(0, 200);
  const what = `status ${err?.status ?? "none"}, type ${body.type ?? err?.type ?? "none"}, code ${body.code ?? err?.code ?? "none"}`;
  return `refused: ${what} (${err?.constructor?.name ?? typeof err}): ${message}`;
}
const said = (turn) => `accepted: usage ${JSON.stringify(turn.usage)}${turn.cutOff ? `, cut off: ${turn.cutOff.detail}` : ""}`;
const user = (text) => ({ role: "user", parts: [{ type: "text", text }] });

// ---- 1 ----
async function tooLong(spec) {
  const [kind, model] = [spec.slice(0, spec.indexOf(":")), spec.slice(spec.indexOf(":") + 1)];
  let provider, window, words;
  if (kind === "anthropic") {
    provider = new AnthropicProvider(model);
    window = await provider.contextWindow();
    if (!window) return console.log(`1 ${spec}: its window could not be read from Anthropic's model list; skipped.`);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, authToken: null });
    const count = async (n) =>
      (await client.messages.countTokens({ model, system: SYSTEM, messages: [{ role: "user", content: " the".repeat(n) }] })).input_tokens;
    const base = await count(1);
    const perWord = ((await count(1001)) - base) / 1000;
    words = Math.ceil((window + 1 - base) / perWord);
    for (let c = await count(words); c <= window; c = await count(words)) words += Math.ceil((window + 1 - c) / perWord);
    console.log(`1 ${spec}: window ${window} tokens; sending ${await count(words)} tokens (Anthropic's count).`);
  } else if (kind === "openai") {
    provider = new OpenAIProvider("openai", model);
    window = await provider.contextWindow();
    if (!window) return console.log(`1 ${spec}: Tachikoma has no window for this model; skipped.`);
    words = window + 1;
    console.log(`1 ${spec}: window ${window} tokens; sending ${words} words.`);
  } else if (kind === "openrouter") {
    provider = new OpenAIProvider("openrouter", model);
    // The list may come in pages, each naming the next in `links.next` (OpenRouter's API reference, "List models").
    let row;
    for (let url = "https://openrouter.ai/api/v1/models"; url && !row; ) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
      if (!res.ok) return console.log(`1 ${spec}: OpenRouter's model list answered ${res.status}; skipped.`);
      const page = await res.json();
      row = page.data?.find((m) => m.id === model);
      const next = page.links?.next ? new URL(page.links.next, "https://openrouter.ai/api/v1/").href : undefined;
      url = next !== url ? next : undefined;
    }
    window = row?.context_length;
    if (!window) return console.log(`1 ${spec}: OpenRouter's model list gives no window for this model; skipped.`);
    words = window + 1;
    console.log(`1 ${spec}: window ${window} tokens; prompt price ${row.pricing?.prompt ?? "not listed"} USD a token; sending ${words} words.`);
  } else {
    const auth = new ChatGPTAuth(new LoginStore(dataDir()));
    provider = new ChatGPTProvider(model, auth);
    window = (await planModels((await auth.token()).token)).find((m) => m.slug === model)?.contextWindow;
    if (!window) return console.log(`1 ${spec}: the plan's model list gives no window for this model; skipped.`);
    words = window + 1;
    console.log(`1 ${spec}: window ${window} tokens (the plan's model list); sending ${words} words.`);
  }
  try {
    // No prompt cache, so an accepted request is not also charged a cache write.
    console.log(`1 ${spec}: ${said(await provider.complete({ system: SYSTEM, messages: [user(" the".repeat(words))], tools: [], cache: false }))}`);
  } catch (err) {
    console.log(`1 ${spec}: ${failure(err)}`);
  }
}

// ---- 2 ----
const ADD = {
  name: "add",
  description: "Adds two whole numbers and returns their sum.",
  inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] },
};

async function resume(spec) {
  // Effort "high", so the model thinks and its replies carry thinking blocks for the third turn to replay.
  const provider = new AnthropicProvider(spec.slice("anthropic:".length), "high");
  const messages = [user("Use the add tool to add 48213 and 90577, then say in one sentence whether the sum is prime and why.")];
  const reply = async () => {
    const turn = await provider.complete({ system: SYSTEM, messages, tools: [ADD] });
    messages.push({ role: "assistant", parts: turn.parts, native: turn.native });
    return turn;
  };
  const first = await reply();
  const call = first.parts.find((p) => p.type === "tool_call");
  if (!call) return console.log("2: the model did not call the tool, so there is no tool call to replay; run it again.");
  messages.push({ role: "user", parts: [{ type: "tool_result", callId: call.id, output: String(call.input.a + call.input.b), isError: false }] });
  await reply();
  const thinking = messages.flatMap((m) => m.native?.content ?? []).filter((b) => b.type === "thinking" || b.type === "redacted_thinking").length;
  console.log(`2: two turns done, with ${thinking} thinking block(s) in the replies.${thinking ? "" : " With none, the test says nothing; run it again."}`);
  messages.push(user("Now add 1 to that sum. Answer with the number only."));
  const changed = `${SYSTEM} This sentence was added after the conversation began.`;
  const ways = [
    ["same system prompt", SYSTEM, messages],
    ["changed system prompt, thinking blocks kept", changed, messages],
    ["changed system prompt, Tachikoma's own record (no thinking blocks)", changed, messages.map(({ role, parts }) => ({ role, parts }))],
  ];
  for (const [name, system, sent] of ways) {
    try {
      console.log(`2 ${name}: ${said(await provider.complete({ system, messages: sent, tools: [ADD] }))}`);
    } catch (err) {
      console.log(`2 ${name}: ${failure(err)}`);
    }
  }
}

// ---- 3 ----
// A 1-by-1 PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function count(spec) {
  const model = spec.slice("anthropic:".length);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, authToken: null });
  const body = {
    model,
    system: SYSTEM,
    tools: [{ name: ADD.name, description: ADD.description, input_schema: ADD.inputSchema }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "[Image #1]" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } },
          { type: "text", text: "What is in this picture?" },
        ],
      },
    ],
  };
  for (const [name, extra] of [
    ["with the fallback setting", { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }],
    ["without it", {}],
  ]) {
    try {
      console.log(`3 ${name}: ${(await client.beta.messages.countTokens({ ...body, ...extra })).input_tokens} tokens`);
    } catch (err) {
      console.log(`3 ${name}: ${failure(err)}`);
    }
  }
}

for (const [n, run] of [
  ["1", async () => { for (const s of specs) await tooLong(s).catch((err) => console.log(`1 ${s}: ${failure(err)}`)); }],
  ["2", () => (anthropicSpec ? resume(anthropicSpec) : console.log("2: skipped, no anthropic:<model> named."))],
  ["3", () => (anthropicSpec ? count(anthropicSpec) : console.log("3: skipped, no anthropic:<model> named."))],
]) {
  if (!only.has(n)) continue;
  try {
    await run();
  } catch (err) {
    console.log(`${n}: stopped: ${failure(err)}`);
  }
}
