import { randomBytes } from "node:crypto";
import { type BetaMessageStreamParams, Messages } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Models } from "@anthropic-ai/sdk/resources/models";
import { Completions } from "openai/resources/chat/completions";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Session } from "../../src/core/session.js";
import type { Image, Message, Picture } from "../../src/core/types.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { type Cache, LIMITS, type Limits, prepare } from "../../src/providers/pictures.js";
import { Bus, tempContext } from "../helpers.js";

// Every picture here is made by sharp in memory; none is written to disk.
const base64 = (p: Picture) => p.data.toString("base64").length;
const size = async (p: Picture) => {
  const { width, height, format, pages } = await sharp(p.data).metadata();
  return { width, height, format, pages };
};
const solid = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "red" } });
// Random pixels stored without compression, so the size in bytes is known: about width × height × 3.
const noise = (width: number, height: number) =>
  sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
const png = async (width: number, height: number): Promise<Picture> => ({ mediaType: "image/png", data: await solid(width, height).png().toBuffer() });
const image = (id: number, p: Picture): Image => ({ type: "image", id, ...p });
const user = (...parts: Message["parts"]): Message => ({ role: "user", parts });
const none = () => 0; // a request measured as empty, for the rules about each picture alone
const run = (messages: Message[], limits: Limits, cache: Cache = new Map()) => prepare(messages, limits, none, cache);

// Just over Anthropic's 10 MB as base64 (10,258,764 characters) but under it as bytes (7,694,073): 1600 × 1600 random
// pixels. Made once for the file, as making it takes the most time here.
let big: Picture;
beforeAll(async () => {
  big = { mediaType: "image/png", data: await noise(1600, 1600) };
});

describe("prepare", () => {
  it("shrinks a picture over Anthropic's 10 MB as base64, though under it as bytes, by the square root of the excess", async () => {
    expect(big.data.length).toBeLessThan(10_000_000);
    expect(base64(big)).toBeGreaterThan(10_000_000);
    const { prepared, leftOut } = await run([user(image(1, big))], LIMITS.anthropic);
    const sent = prepared.get(1) as Picture;
    expect(base64(sent)).toBeLessThanOrEqual(10_000_000);
    expect(await size(sent)).toMatchObject({ format: "png", width: 1579, height: 1579 }); // 1600 × √(10,000,000 / 10,258,764), once
    expect(leftOut).toBe(0);
  });

  it("scales a picture over 8000 pixels a side down to 8000 for Anthropic, keeping its shape", async () => {
    const { prepared } = await run([user(image(1, await png(9000, 100)))], LIMITS.anthropic);
    expect(await size(prepared.get(1) as Picture)).toMatchObject({ width: 8000, height: 89 });
  });

  it("scales every picture to 2000 a side once the request holds more than 20, earlier turns included, with new copies then", async () => {
    const wide = await png(2400, 10);
    const cache: Cache = new Map();
    const turns = (n: number) => [
      user(...Array.from({ length: n - 1 }, (_, i) => image(i + 1, wide))),
      { role: "assistant" as const, parts: [] },
      user(image(n, wide)),
    ];
    const twenty = await run(turns(20), LIMITS.anthropic, cache);
    for (let id = 1; id <= 20; id++) expect(twenty.prepared.get(id)).toMatchObject({ data: wide.data }); // within 8000: sent as read
    expect(cache.size).toBe(20);

    const more = await run(turns(21), LIMITS.anthropic, cache);
    for (let id = 1; id <= 21; id++) expect(await size(more.prepared.get(id) as Picture)).toMatchObject({ width: 2000, height: 8 });
    expect(cache.size).toBe(41); // the 20 copies made to 8000 are made again to 2000, and the 21st to 2000 alone

    const again = await run(turns(21), LIMITS.anthropic, cache);
    expect(cache.size).toBe(41);
    for (let id = 1; id <= 21; id++) expect(again.prepared.get(id)).toBe(more.prepared.get(id));
  });

  it("fits a picture inside 4096 × 2160 for Kimi, or 2160 × 4096 when it stands upright, keeping its shape", async () => {
    const pictures = [png(4100, 100), png(1000, 3000), png(1170, 2532), png(2200, 5000)];
    const { prepared } = await run([user(...(await Promise.all(pictures)).map((p, i) => image(i + 1, p)))], LIMITS.kimi);
    expect(await size(prepared.get(1) as Picture)).toMatchObject({ width: 4096, height: 100 });
    expect(await size(prepared.get(2) as Picture)).toMatchObject({ width: 1000, height: 3000 });
    expect(await size(prepared.get(3) as Picture)).toMatchObject({ width: 1170, height: 2532 }); // a phone's screenshot
    expect(await size(prepared.get(4) as Picture)).toMatchObject({ width: 1802, height: 4096 });
  });

  it("measures a photo as it stands, and sends a copy turned upright with no record of the turn", async () => {
    // Stored 9000 × 100, with the camera's record (EXIF orientation 6) that it shows turned a quarter, 100 × 9000.
    const photo: Picture = { mediaType: "image/jpeg", data: await solid(9000, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer() };
    expect((await sharp(photo.data).metadata()).orientation).toBe(6);
    const sent = (await run([user(image(1, photo))], LIMITS.anthropic)).prepared.get(1) as Picture;
    const { width, height, orientation } = await sharp(sent.data).metadata();
    expect({ width, height, orientation }).toEqual({ width: 89, height: 8000, orientation: undefined });
  });

  it("sends a picture sharp cannot read as it is, so a refusal can come from the provider", async () => {
    const whole = await png(9000, 100);
    const cut: Picture = { mediaType: "image/png", data: whole.data.subarray(0, 100) }; // its header, with the pixels cut off
    const junk: Picture = { mediaType: "image/jpeg", data: Buffer.from("not a picture at all") };
    for (const limits of [LIMITS.ollama, LIMITS.anthropic]) {
      const { prepared } = await run([user(image(1, cut), image(2, junk))], limits);
      expect(prepared.get(1)).toEqual(cut);
      expect(prepared.get(2)).toEqual(junk);
    }
  });

  it("sends a WebP as PNG to a provider whose formats leave out WebP", async () => {
    const webp: Picture = { mediaType: "image/webp", data: await solid(30, 20).webp().toBuffer() };
    const limits: Limits = { name: "Somewhere", formats: ["image/png", "image/jpeg"] };
    const sent = (await run([user(image(1, webp))], limits)).prepared.get(1) as Picture;
    expect(sent.mediaType).toBe("image/png");
    expect(await size(sent)).toMatchObject({ format: "png", width: 30, height: 20 });
  });

  it("sends an animated GIF to OpenAI as its first frame in PNG, a still GIF as it is, and to Kimi as it is", async () => {
    const frames = Buffer.alloc(4 * 8 * 3);
    frames.fill(255, 0, 4 * 4 * 3); // a white frame, then a black one: two frames the same would be stored as one
    const gif = sharp(frames, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } }).gif();
    const animated: Picture = { mediaType: "image/gif", data: await gif.toBuffer() };
    expect((await size(animated)).pages).toBe(2);
    const still: Picture = { mediaType: "image/gif", data: await solid(4, 4).gif().toBuffer() };
    const { prepared } = await run([user(image(1, animated), image(2, still))], LIMITS.openai);
    const first = prepared.get(1) as Picture;
    expect(first.mediaType).toBe("image/png");
    expect(await size(first)).toMatchObject({ format: "png", width: 4, height: 4, pages: undefined });
    expect((await sharp(first.data).raw().toBuffer())[0]).toBe(255);
    expect(prepared.get(2)).toMatchObject({ mediaType: "image/gif", data: still.data });

    const toKimi = (await run([user(image(1, animated))], LIMITS.kimi)).prepared.get(1) as Picture;
    expect(toKimi).toEqual(animated);
    expect((await size(toKimi)).pages).toBe(2);
  });

  it("leaves pictures for OpenAI as they are, which documents no limit for one picture", async () => {
    const wide = await png(9000, 100);
    const { prepared } = await run([user(image(1, big), image(2, wide))], LIMITS.openai);
    expect((prepared.get(1) as Picture).data).toBe(big.data); // the same bytes, not a copy: comparing 7 MB is slow
    expect((prepared.get(2) as Picture).data).toBe(wide.data);
  });

  it("leaves pictures for Ollama untouched, whatever their size, side, number or format", async () => {
    const webp: Picture = { mediaType: "image/webp", data: await solid(9000, 100).webp().toBuffer() };
    const many = Array.from({ length: 21 }, (_, i) => image(i + 3, webp));
    const { prepared, leftOut } = await prepare([user(image(1, big), image(2, webp), ...many)], LIMITS.ollama, () => Number.MAX_SAFE_INTEGER, new Map());
    expect(prepared.get(1)).toMatchObject({ mediaType: "image/png" });
    expect((prepared.get(1) as Picture).data).toBe(big.data);
    for (let id = 2; id <= 23; id++) expect(prepared.get(id)).toMatchObject({ mediaType: "image/webp", data: webp.data });
    expect(leftOut).toBe(0);
  });

  it("leaves out the oldest pictures first, each as a note, until the request is within the cap", async () => {
    const small = await png(10, 10);
    // Each picture still sent counts as 15 MB, so two fit Anthropic's 32 MB.
    const measure = (prepared: ReadonlyMap<number, Picture | string>) => [...prepared.values()].filter((p) => typeof p !== "string").length * 15_000_000;
    const messages = [user(image(1, small)), user(image(2, small), image(3, small), image(4, small))];
    const { prepared, leftOut } = await prepare(messages, LIMITS.anthropic, measure, new Map());
    expect(prepared.get(1)).toBe("[Image #1 left out: the request was over Anthropic's 32 MB]");
    expect(prepared.get(2)).toBe("[Image #2 left out: the request was over Anthropic's 32 MB]");
    expect(prepared.get(3)).toMatchObject({ data: small.data });
    expect(prepared.get(4)).toMatchObject({ data: small.data });
    expect(leftOut).toBe(2);
  });
});

// Each adapter shrinks the conversation's originals for its own provider at each request; the conversation keeps them.
describe("each request, from the session", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("MOONSHOT_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const answer = (fields: Record<string, unknown> = {}) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "seen" }],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...fields,
  });
  function anthropicSees(reply = answer()) {
    const sent: BetaMessageStreamParams[] = [];
    vi.spyOn(Messages.prototype, "stream").mockImplementation(((params: BetaMessageStreamParams) => {
      sent.push(params);
      return { finalMessage: async () => reply };
    }) as never);
    return sent;
  }
  const blocks = (params: BetaMessageStreamParams) => params.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const pictures = (params: BetaMessageStreamParams) =>
    blocks(params).flatMap((b) => (b.type === "image" && b.source.type === "base64" ? [b.source.data] : []));
  const notes = (params: BetaMessageStreamParams) => blocks(params).flatMap((b) => (b.type === "text" && b.text.includes("left out") ? [b.text] : []));
  async function session(lead: AnthropicProvider | OpenAIProvider, fallback?: OpenAIProvider) {
    const bus = new Bus();
    const said: string[] = [];
    bus.on("note", (line) => said.push(line));
    return { said, session: new Session({ lead, fallback, tools: [], system: "s", ctx: await tempContext(), bus }) };
  }

  // About 9 MB as base64 each, so five are 45 MB: the oldest two go to bring the request under Anthropic's 32 MB.
  it("leaves out the oldest pictures of a request over Anthropic's 32 MB, with a note for each and one line", async () => {
    const nine: Picture = { mediaType: "image/png", data: await noise(1500, 1500) };
    const sent = anthropicSees();
    const { said, session: s } = await session(new AnthropicProvider("claude-opus-5-5"));
    await s.send([image(1, nine), image(2, nine), { type: "text", text: "and" }, image(3, nine), image(4, nine), image(5, nine)]);
    expect(notes(sent[0]!)).toEqual([
      "[Image #1 left out: the request was over Anthropic's 32 MB]",
      "[Image #2 left out: the request was over Anthropic's 32 MB]",
    ]);
    expect(pictures(sent[0]!)).toHaveLength(3);
    expect(said).toEqual(["2 pictures were left out of this request to fit Anthropic's 32 MB."]);
    expect(s.messages[0]!.parts.filter((p) => p.type === "image")).toHaveLength(5); // the conversation keeps them all
  });

  it("sends at most 100 pictures to an Anthropic model with a 200k-token window, and 600 to others", async () => {
    const dot = await png(1, 1);
    const parts = Array.from({ length: 101 }, (_, i) => image(i + 1, dot));
    const windows = vi.spyOn(Models.prototype, "retrieve").mockResolvedValueOnce({ max_input_tokens: 200_000 } as never);
    let sent = anthropicSees();
    let { said, session: s } = await session(new AnthropicProvider("claude-opus-5-5"));
    await s.send(parts);
    expect(notes(sent[0]!)).toEqual(["[Image #1 left out: the request was over Anthropic's 100 pictures]"]);
    expect(pictures(sent[0]!)).toHaveLength(100);
    expect(said).toEqual(["1 picture was left out of this request to fit Anthropic's 100 pictures."]);

    windows.mockResolvedValueOnce({ max_input_tokens: 1_000_000 } as never);
    sent = anthropicSees();
    ({ said, session: s } = await session(new AnthropicProvider("claude-opus-5-5")));
    await s.send(parts);
    expect(pictures(sent[0]!)).toHaveLength(101);
    expect(said).toEqual([]);
  });

  // 101 pictures, the oldest a dot, then four of about 9 MB as base64 (36 MB): the dot goes for the count, then the
  // first large one for the size.
  it("names both of Anthropic's limits in one line when a request is over both", async () => {
    const dot = await png(1, 1);
    const nine: Picture = { mediaType: "image/png", data: await noise(1500, 1500) };
    const parts = [image(1, dot), ...[2, 3, 4, 5].map((id) => image(id, nine)), ...Array.from({ length: 96 }, (_, i) => image(i + 6, dot))];
    vi.spyOn(Models.prototype, "retrieve").mockResolvedValueOnce({ max_input_tokens: 200_000 } as never);
    const sent = anthropicSees();
    const { said, session: s } = await session(new AnthropicProvider("claude-opus-5-5"));
    await s.send(parts);
    expect(notes(sent[0]!)).toEqual([
      "[Image #1 left out: the request was over Anthropic's 100 pictures]",
      "[Image #2 left out: the request was over Anthropic's 32 MB]",
    ]);
    expect(said).toEqual(["2 pictures were left out of this request to fit Anthropic's 100 pictures and 32 MB."]);
  });

  it("gives the lead and the fallback each a copy for its own provider's limits, from the original", async () => {
    const wide = await png(9000, 100);
    const lead = anthropicSees(answer({ content: [], stop_reason: "refusal", stop_details: { category: "cyber" } }));
    const kimi: { messages: { role: string; content: unknown }[] }[] = [];
    vi.spyOn(Completions.prototype, "create").mockImplementation(((body: (typeof kimi)[0]) => {
      kimi.push(body);
      return Promise.resolve({ choices: [{ message: { role: "assistant", content: "seen" }, finish_reason: "stop" }] });
    }) as never);
    const { session: s } = await session(new AnthropicProvider("claude-opus-5-5"), new OpenAIProvider("kimi", "kimi-k3"));
    await s.send([image(1, wide)]);

    const toAnthropic: Picture = { mediaType: "image/png", data: Buffer.from(pictures(lead[0]!)[0]!, "base64") };
    expect(await size(toAnthropic)).toMatchObject({ width: 8000, height: 89 });
    const url = (kimi[0]!.messages[1]!.content as { type: string; image_url?: { url: string } }[]).find((c) => c.type === "image_url")!.image_url!.url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const toKimi: Picture = { mediaType: "image/png", data: Buffer.from(url.slice("data:image/png;base64,".length), "base64") };
    expect(await size(toKimi)).toMatchObject({ width: 4096, height: 46 });
    expect(s.messages[0]!.parts[0]).toMatchObject({ data: wide.data });
  });
});
