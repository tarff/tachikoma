// The lesson ask's real request, one per provider (8d plan, step 29; the user's choices after step 26's review,
// 2026-11-20: the approved request is the system prompt on every provider, and the user sends one real request per
// provider in use). Not part of Tachikoma, and never run by the build: run by hand by the user, with their own keys.
//
//   node --import tsx scripts/8d/live-lesson-ask.mjs anthropic:<model> openrouter:<model> chatgpt:<model>
//
// Name each provider and model you use as Tachikoma's lead, one per provider. Keys come from the environment only
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, MOONSHOT_API_KEY), and the ChatGPT plan from the saved
// sign-in, as tachi uses them; no key is ever printed, and no settings file is read. For ChatGPT, a sign-in whose token
// has expired is refreshed, which may rewrite the saved sign-in, as Tachikoma itself does.
//
// Each named lead gets one lesson request, which the SDKs' default retries may send up to 3 times on a rate limit, a
// server error or a dropped connection. It is made by Tachikoma's own code as a turn's end makes it: askLesson
// (src/memory/lessons.ts) through the provider createProvider builds (src/providers/registry.ts), so the system prompt
// is the approved request and the one message is the three approved lines. The failed call, its error and the call that
// worked are MADE UP for this check (family C1 of scripts/8d/lesson-families.mjs: `npm test` finding no jest, then
// `npm install` and the tests again); nothing comes from a real session. Per provider it prints whether the request
// was accepted, with the reply's lesson line as askLesson reads it (or that it gave none), and the usage reported; or
// that it was refused, with the error's status, type and code and the first 200 characters of its message (200 is a
// display cut, as in scripts/live-8a.mjs, not a setting). Nothing is stored: no palace is opened.
import { Bus } from "../../src/core/bus.ts";
import { truncate } from "../../src/core/session.ts";
import { askLesson, lessonRequest } from "../../src/memory/lessons.ts";
import { createProvider } from "../../src/providers/registry.ts";
import { FAMILIES } from "./lesson-families.mjs";

const specs = process.argv.slice(2);
if (!specs.length || specs.some((s) => !/^[a-z]+:./.test(s))) {
  console.error("Name one lead per provider: anthropic:<model>, openai:<model>, chatgpt:<model>, openrouter:<model>.");
  process.exit(2);
}

// The made-up pair, shown as the session shows a call (`<tool> <input as JSON>`, cut by the session's truncate).
const failure = FAMILIES.find((f) => f.id === "C1").failures[0];
const shown = (tool, input) => truncate(`${tool} ${JSON.stringify(input)}`);
const text = lessonRequest(shown(failure.tool, failure.input), failure.error,
  shown("shell", { command: "npm install && npm test" }));

// What a failure says, from the SDKs' error objects and Tachikoma's own (scripts/live-8a.mjs's form).
function refusal(err) {
  const body = err?.error?.error ?? err?.error ?? {};
  const message = String(body.message ?? err?.message ?? err).slice(0, 200);
  const what = `status ${err?.status ?? "none"}, type ${body.type ?? err?.type ?? "none"}, ` +
    `code ${body.code ?? err?.code ?? "none"}`;
  return `refused: ${what} (${err?.constructor?.name ?? typeof err}): ${message}`;
}

let failed = 0;
for (const spec of specs) {
  let lead;
  try {
    lead = createProvider(spec);
  } catch (err) {
    console.log(`${spec}: not made: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
    continue;
  }
  // askLesson says nothing of a failed request (the user's choice after step 26), so the error is kept here.
  let error;
  const watched = { id: lead.id, complete: (req) => lead.complete(req).catch((err) => { error = err; throw err; }) };
  const bus = new Bus();
  const usages = [];
  bus.on("usage", (u) => usages.push(u));
  const lesson = await askLesson(watched, text, new AbortController().signal, bus);
  if (error !== undefined) {
    console.log(`${spec}: ${refusal(error)}`);
    failed++;
  } else {
    const said = lesson === undefined ? "no lesson (the reply was none, blank or cut off)" : `lesson: ${lesson}`;
    console.log(`${spec}: accepted; ${said}; usage ${JSON.stringify(usages.map((u) => u.usage))}`);
  }
}
process.exitCode = failed ? 1 : 0;
