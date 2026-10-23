import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ChatGPTAuth } from "../../src/auth/access.js";
import type { Message, ToolSpec } from "../../src/core/types.js";
import { ChatGPTProvider, fromStream, toolsFor, toResponses, USAGE_LIMIT } from "../../src/providers/chatgpt.js";

const tools: ToolSpec[] = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 };
const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" };
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", namespace: "tachikoma", arguments: '{"path":"a.txt"}', status: "completed" };
const text = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] };

const done = (item: unknown) => ({ type: "response.output_item.done", item }) as unknown as ResponseStreamEvent;
const completed = { type: "response.completed", response: { usage } } as unknown as ResponseStreamEvent;
async function* events(...list: ResponseStreamEvent[]) {
  yield* list;
}

describe("toResponses", () => {
  it("converts the conversation, tool calls and results included", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "looking" }, { type: "tool_call", id: "toolu_1", name: "read_file", input: { path: "a" } }], native: { provider: "anthropic", content: [] } },
      { role: "user", parts: [{ type: "tool_result", callId: "toolu_1", output: "nope", isError: true }] },
    ];
    expect(toResponses(history)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "looking" },
      { type: "function_call", call_id: "toolu_1", name: "read_file", namespace: "tachikoma", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "toolu_1", output: "Error: nope" },
    ]);
  });

  it("sends a ChatGPT turn back exactly as it came, encrypted reasoning included", () => {
    const history: Message[] = [{ role: "assistant", parts: [], native: { provider: "chatgpt", content: [reasoning, call] } }];
    expect(toResponses(history)).toEqual([reasoning, call]);
  });
});

describe("toolsFor", () => {
  it("groups the tools in one namespace, as the plan's route requires", () => {
    expect(toolsFor(tools)).toEqual([
      {
        type: "namespace",
        name: "tachikoma",
        description: "Tachikoma's tools, which act on the user's project.",
        tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: tools[0]!.inputSchema }],
      },
    ]);
    expect(toolsFor([])).toEqual([]);
  });
});

describe("fromStream", () => {
  it("reads the finished items, keeps them in order to send back, and splits the cached tokens", async () => {
    const turn = await fromStream(events(done(reasoning), done(text), done(call), completed), tools);
    expect(turn.parts).toEqual([
      { type: "text", text: "Done." },
      { type: "tool_call", id: "call_1", name: "read_file", input: { path: "a.txt" } },
    ]);
    expect(turn.native).toEqual({ provider: "chatgpt", content: [reasoning, text, call] });
    expect(turn.usage).toEqual({ input: 60, output: 20, cacheRead: 30, cacheWrite: 10 });
    expect(turn.cutOff).toBeUndefined();
  });

  it("gives a tool name that is not Tachikoma's its full name, so the session refuses it", async () => {
    const other = { ...call, namespace: "web", name: "search" };
    const turn = await fromStream(events(done(other), completed), tools);
    expect(turn.parts[0]).toMatchObject({ name: "web.search" });
  });

  it("maps a call with no namespace back to Tachikoma's tool, and leaves an unknown one as it is", async () => {
    const { namespace: _, ...bare } = call;
    const turn = await fromStream(events(done(bare), done({ ...bare, call_id: "call_2", name: "nope" }), done({ ...call, call_id: "call_3", name: "nope" }), completed), tools);
    expect(turn.parts.map((p) => p.type === "tool_call" && p.name)).toEqual(["read_file", "nope", "tachikoma.nope"]);
  });

  it("treats a stream that ends without response.completed as an error", async () => {
    await expect(fromStream(events(done(text)), tools)).rejects.toThrow(new Error("OpenAI's reply stopped before it finished. Try again."));
    await expect(fromStream(events(done(text)), tools, "req_1")).rejects.toThrow(new Error("OpenAI's reply stopped before it finished. Try again. OpenAI's request ID: req_1."));
  });

  it("stops on the usage limit, even part way through a stream", async () => {
    const failed = { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } } as unknown as ResponseStreamEvent;
    await expect(fromStream(events(done(text), failed), tools)).rejects.toThrow(new Error(USAGE_LIMIT));
    const error = { type: "error", code: "subscription_sharing_usage_unavailable", message: "busy", param: null } as unknown as ResponseStreamEvent;
    await expect(fromStream(events(error), tools)).rejects.toThrow(new Error("ChatGPT plan use is unavailable right now (subscription_sharing_usage_unavailable). busy. Your sign-in is kept; try again later."));
  });

  it("says what each of the plan's errors means, in OpenAI's words, with the request ID", async () => {
    const error = (code: string, message: string, param: string | null = null) => ({ type: "error", code, message, param }) as unknown as ResponseStreamEvent;
    const cases: [ResponseStreamEvent, string][] = [
      [error("subscription_sharing_user_not_eligible", "Not for this workspace."), "This ChatGPT account cannot use its plan here (subscription_sharing_user_not_eligible). Not for this workspace. Use openai:<model> with an API key instead."],
      ...["chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context"].map((code): [ResponseStreamEvent, string] => [
        error(code, "Not granted"),
        `OpenAI says this ChatGPT sign-in's permissions do not cover the request (${code}). Not granted. Sign out with \`tachi logout chatgpt\`, then sign in again with \`tachi login chatgpt\` (or /logout chatgpt and /login chatgpt in a session) and allow plan use.`,
      ]),
      [error("subscription_sharing_invalid_user", "Unknown user"), "OpenAI did not accept the ChatGPT sign-in (subscription_sharing_invalid_user). Unknown user. Sign out with `tachi logout chatgpt`, then sign in again with `tachi login chatgpt` (or /logout chatgpt and /login chatgpt in a session)."],
      [error("subscription_sharing_user_unavailable", "Try later!"), "ChatGPT plan use is unavailable right now (subscription_sharing_user_unavailable). Try later! Your sign-in is kept; try again later."],
      [error("subscription_sharing_unsupported_capability", "Not on this route", "tools"), "OpenAI could not complete the request (subscription_sharing_unsupported_capability, about tools). Not on this route."],
      [{ type: "response.failed", response: { error: { code: "server_error", message: "" } } } as unknown as ResponseStreamEvent, "OpenAI could not complete the request (server_error). The reply failed."],
    ];
    for (const [event, message] of cases) await expect(fromStream(events(event), tools, "req_1")).rejects.toThrow(new Error(`${message} OpenAI's request ID: req_1.`));
  });

  it("marks a reply cut short, by the length limit or OpenAI's content filter, and a refusal", async () => {
    const short = (reason: string) => ({ type: "response.incomplete", response: { usage, incomplete_details: { reason } } }) as unknown as ResponseStreamEvent;
    expect((await fromStream(events(done(text), short("max_output_tokens")), tools)).cutOff).toEqual({ kind: "max_tokens", detail: "The response reached its length limit" });
    expect((await fromStream(events(short("max_messages")), tools)).cutOff).toEqual({ kind: "max_tokens", detail: 'The response stopped early, for a reason OpenAI gives as "max_messages"' });
    expect((await fromStream(events(short("content_filter")), tools)).cutOff).toEqual({ kind: "refusal", detail: "OpenAI's content filter stopped the response" });
    const refused = { ...text, content: [{ type: "refusal", refusal: "No." }] };
    expect((await fromStream(events(done(refused), completed), tools)).cutOff).toEqual({ kind: "refusal", detail: "No." });
  });
});

// A stand-in for api.openai.com: the account's model list and a streamed Responses reply.
const planList = [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hide", context_window: 9 }];
const json = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json", "x-request-id": "req_9" }).end(JSON.stringify(body));

async function fakeApi(respond: (body: Record<string, unknown>, res: http.ServerResponse) => void, list: (res: http.ServerResponse) => void = (res) => json(res, 200, { models: planList })) {
  const seen: { auth?: string; body: Record<string, unknown> }[] = [];
  let lists = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      lists++;
      return list(res);
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as Record<string, unknown>;
    seen.push({ auth: req.headers.authorization, body });
    respond(body, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  onTestFinished(() => {
    server.close();
    server.closeAllConnections();
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, lists: () => lists };
}

const sse = (res: http.ServerResponse, list: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_9" });
  for (const e of list) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const auth = { check: () => {}, token: async () => ({ token: "tok-1", account: "app user-1" }) } as unknown as ChatGPTAuth;
const request = { system: "be brief", messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }], tools };

describe("ChatGPTProvider", () => {
  it("streams an unstored request with the login, the instructions and the grouped tools, and nothing the route refuses", async () => {
    const api = await fakeApi((_, res) => sse(res, [done(text), completed]));
    const turn = await new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request);
    expect(turn.parts).toEqual([{ type: "text", text: "Done." }]);
    const { auth: header, body } = api.seen[0]!;
    expect(header).toBe("Bearer tok-1");
    expect(body).toMatchObject({ model: "gpt-6.1-sol", instructions: "be brief", stream: true, store: false, input: [{ role: "user", content: "hi" }], tools: [{ type: "namespace" }] });
    for (const refused of ["temperature", "max_output_tokens", "previous_response_id", "metadata", "user", "prompt"]) expect(body).not.toHaveProperty(refused);
  });

  it("reads the login again after fetching the model list, so a logout in the meantime stops the request", async () => {
    const api = await fakeApi((_, res) => sse(res, [done(text), completed]));
    const left = ["tok-1"]; // one token, then signed out
    const once = {
      check: () => {},
      token: async () => {
        const token = left.shift();
        if (!token) throw new Error("Not signed in to ChatGPT.");
        return { token, account: "app user-1" };
      },
    } as unknown as ChatGPTAuth;
    await expect(new ChatGPTProvider("gpt-6.1-sol", once, api.base).complete(request)).rejects.toThrow("Not signed in to ChatGPT.");
    expect(api.seen).toHaveLength(0);
  });

  it("fetches the model list again after a switch to another account", async () => {
    const api = await fakeApi((_, res) => sse(res, [done(text), completed]));
    let account = "app user-1";
    const switching = { check: () => {}, token: async () => ({ token: "tok-1", account }) } as unknown as ChatGPTAuth;
    const provider = new ChatGPTProvider("gpt-6.1-sol", switching, api.base);
    await provider.complete(request);
    await provider.complete(request);
    expect(api.lists()).toBe(1);
    account = "app user-2";
    await provider.complete(request);
    expect(api.lists()).toBe(2);
  });

  it("checks the model again when the account changes while its list is fetched", async () => {
    const api = await fakeApi((_, res) => sse(res, [done(text), completed]));
    const first = [{ token: "tok-1", account: "app user-1" }];
    const switching = { check: () => {}, token: async () => first.shift() ?? { token: "tok-2", account: "app user-2" } } as unknown as ChatGPTAuth;
    await new ChatGPTProvider("gpt-6.1-sol", switching, api.base).complete(request);
    expect(api.lists()).toBe(2);
    expect(api.seen[0]!.auth).toBe("Bearer tok-2");
  });

  it("stops on the usage limit at once, with no retry", async () => {
    const api = await fakeApi((_, res) => json(res, 429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit", type: "x", param: null } }));
    // A full stop goes after the address, before the request ID.
    await expect(new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request)).rejects.toThrow(new Error(`${USAGE_LIMIT}. OpenAI's request ID: req_9.`));
    expect(api.seen).toHaveLength(1);
  });

  it("says what a refused request means, in OpenAI's words, with the request ID", async () => {
    const cases: [(res: http.ServerResponse) => void, string][] = [
      [(res) => json(res, 401, { error: { code: "invalid_token", message: "Bad token", type: "x", param: null } }), "OpenAI did not accept the ChatGPT sign-in (HTTP 401, invalid_token). Bad token. Sign out with `tachi logout chatgpt`, then sign in again with `tachi login chatgpt` (or /logout chatgpt and /login chatgpt in a session). OpenAI's request ID: req_9."],
      [(res) => json(res, 503, { detail: "Direct routing is off" }), "ChatGPT plan use is unavailable right now (HTTP 503). Direct routing is off. Your sign-in is kept; try again later. OpenAI's request ID: req_9."],
      [(res) => json(res, 503, { error: { code: "server_overloaded", message: "Busy", type: "x", param: null } }), "ChatGPT plan use is unavailable right now (HTTP 503, server_overloaded). Busy. Your sign-in is kept; try again later. OpenAI's request ID: req_9."],
      [(res) => json(res, 429, { error: { code: "rate_limit_exceeded", message: "Slow down", type: "x", param: null } }), "OpenAI refused the request (HTTP 429, rate_limit_exceeded). Slow down. Try again later. OpenAI's request ID: req_9."],
      [(res) => json(res, 403, { detail: "Region not supported" }), "OpenAI refused the request (HTTP 403). Region not supported. OpenAI's request ID: req_9."],
      [(res) => json(res, 400, { error: { code: "too_long", message: "Your input is too long.", type: "x", param: "input" } }), "OpenAI refused the request (HTTP 400, too_long, about input). Your input is too long. OpenAI's request ID: req_9."],
      [(res) => res.writeHead(502, { "content-type": "text/html" }).end("<html>Bad gateway</html>"), "OpenAI could not complete the request (HTTP 502)."],
    ];
    for (const [answer, message] of cases) {
      const api = await fakeApi((_, res) => answer(res));
      await expect(new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request)).rejects.toThrow(new Error(message));
    }
  });

  it("keeps the request ID of a reply that fails part way through", async () => {
    const failed = { type: "response.failed", response: { error: { code: "server_error", message: "Something broke" } } };
    const api = await fakeApi((_, res) => sse(res, [done(text), failed]));
    await expect(new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request)).rejects.toThrow(new Error("OpenAI could not complete the request (server_error). Something broke. OpenAI's request ID: req_9."));
    // A named `event: error`, which the SDK throws itself.
    const limit = { type: "error", code: "subscription_sharing_usage_limit_exceeded", message: "limit", param: null };
    const limited = await fakeApi((_, res) => sse(res, [done(text), limit]));
    await expect(new ChatGPTProvider("gpt-6.1-sol", auth, limited.base).complete(request)).rejects.toThrow(new Error(`${USAGE_LIMIT}. OpenAI's request ID: req_9.`));
  });

  it("says a connection that drops part way through a reply dropped", async () => {
    const api = await fakeApi((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_9" });
      res.write(`event: response.output_item.done\ndata: ${JSON.stringify(done(text))}\n\n`, () => res.socket?.destroy());
    });
    const err = (await new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^The connection to OpenAI dropped before the reply finished \(.+\)\. Check your network and try again\. OpenAI's request ID: req_9\.$/);
  });

  it("says a reply that could not be fetched could not reach OpenAI", async () => {
    const api = await fakeApi((_, res) => res.socket?.destroy());
    await expect(new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request)).rejects.toThrow(`Could not reach ${api.base} (`);
  });

  it("says why the account's model list could not be fetched", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    await expect(new ChatGPTProvider("gpt-6.1-sol", auth, `http://127.0.0.1:${port}/v1`).complete(request)).rejects.toThrow(`Could not reach http://127.0.0.1:${port}/v1 (connect ECONNREFUSED`);

    const cases: [(res: http.ServerResponse) => void, string][] = [
      [(res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>wifi</html>"), "OpenAI's model list could not be read. Check your network and try again."],
      [(res) => json(res, 200, { data: [] }), "OpenAI's model list could not be read. Check your network and try again. OpenAI's request ID: req_9."],
      [
        (res) => json(res, 403, { error: { code: "subscription_sharing_user_not_eligible", message: "Not for this workspace", type: "x", param: null } }),
        "This ChatGPT account cannot use its plan here (subscription_sharing_user_not_eligible). Not for this workspace. Use openai:<model> with an API key instead. OpenAI's request ID: req_9.",
      ],
      [(res) => json(res, 403, { detail: "Region not supported" }), "OpenAI refused the request (HTTP 403). Region not supported. OpenAI's request ID: req_9."],
      [(res) => res.writeHead(500).end(), "OpenAI could not complete the request (HTTP 500)."],
    ];
    for (const [list, message] of cases) {
      const api = await fakeApi(() => {}, list);
      await expect(new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request)).rejects.toThrow(new Error(message));
    }
  });

  it("stops at once on Ctrl-C while the model list is fetched or the reply is awaited, and every login read can be stopped", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const watched = { check: () => {}, token: async (signal?: AbortSignal) => (signals.push(signal), { token: "tok-1", account: "app user-1" }) } as unknown as ChatGPTAuth;
    for (const wait of ["list", "reply"]) {
      signals.length = 0;
      let arrived!: () => void;
      const asked = new Promise<void>((r) => (arrived = r));
      const api = await fakeApi(() => arrived(), wait === "list" ? () => arrived() : undefined); // never answered
      const stop = new AbortController();
      const turn = new ChatGPTProvider("gpt-6.1-sol", watched, api.base).complete({ ...request, signal: stop.signal });
      await asked;
      stop.abort();
      const err = await turn.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/Could not reach|OpenAI refused|could not complete/); // passed on, not explained
      expect(signals.length).toBeGreaterThan(0);
      for (const signal of signals) expect(signal).toBe(stop.signal);
    }
  });

  it("refuses a model the account does not offer, listing the ones it does", async () => {
    const api = await fakeApi(() => {});
    await expect(new ChatGPTProvider("gpt-9", auth, api.base).complete(request)).rejects.toThrow(new Error("Your ChatGPT account does not offer gpt-9. It offers: chatgpt:gpt-6.1-sol."));
    expect(api.seen).toHaveLength(0);
    const none = await fakeApi(() => {}, (res) => json(res, 200, { models: [planList[1]] }));
    await expect(new ChatGPTProvider("gpt-9", auth, none.base).complete(request)).rejects.toThrow(new Error("Your ChatGPT account does not offer gpt-9. It offers no models."));
  });

  it("takes the context window from the model list a reply fetched, without reading the login", async () => {
    const api = await fakeApi((_, res) => sse(res, [done(text), completed]));
    let reads = 0;
    const counted = { check: () => {}, token: async () => (reads++, { token: "tok-1", account: "app user-1" }) } as unknown as ChatGPTAuth;
    const hidden = new ChatGPTProvider("hidden", counted, api.base);
    expect(await hidden.contextWindow()).toBeNull(); // no reply yet
    expect(reads).toBe(0);
    await hidden.complete(request);
    reads = 0;
    expect(await hidden.contextWindow()).toBe(9);
    expect(reads).toBe(0);
    const unlisted = new ChatGPTProvider("gpt-6.1-sol", counted, api.base);
    await unlisted.complete(request);
    expect(await unlisted.contextWindow()).toBeNull(); // the list gives none, so the tokens in use are shown
  });

  it("is refused at once when signed out", () => {
    const out = { check: () => { throw new Error("Not signed in to ChatGPT."); } } as unknown as ChatGPTAuth;
    expect(() => new ChatGPTProvider("gpt-6.1-sol", out)).toThrow("Not signed in to ChatGPT.");
  });
});
