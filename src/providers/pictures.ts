import sharp from "sharp";
import type { CompletionRequest, Image, Message, Picture, Prepared } from "../core/types.js";

// Each picture shrunk to its provider's documented limits, request by request, from the original the conversation keeps
// (release 6 design, "Pictures": "Shrinking", "The whole request" and the picture limits table, read 2026-10-28).

type Format = Picture["mediaType"];

export interface Limits {
  name: string; // the provider as a left-out picture's note names it: "Anthropic's 32 MB"
  maxBase64?: number; // characters of one picture's base64
  maxSide?: number; // pixels on a picture's longer side
  manySide?: { over: number; side: number }; // a smaller `maxSide` once the request holds more than `over` pictures
  fit?: [number, number]; // a box a picture must fit inside, its shape kept, turned to stand as the picture does
  maxRequest?: number; // bytes of the request as sent
  maxCount?: number; // pictures in one request
  formats: Format[];
  stillGif?: true; // the provider refuses an animated GIF
}

// The formats Tachikoma reads (core/types.ts), for a provider that documents no list: they are sent as they are.
const ALL: Format[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// A megabyte here is 1,000,000 bytes: the pages say "MB" without saying which, and the smaller reading keeps a request
// within either.
export const LIMITS: Record<"anthropic" | "openai" | "kimi" | "openrouter" | "ollama" | "chatgpt", Limits> = {
  // platform.claude.com/docs/en/build-with-claude/vision, "Request limits" and "Supported formats": each picture 10 MB
  // "(base64-encoded)" and 8000×8000 px; with "more than 20 images" in a request, earlier turns' included, 2000 px a
  // side; 600 pictures a request (100 for a 200k-token window, which anthropic.ts sets); 32 MB "for standard
  // endpoints".
  anthropic: {
    name: "Anthropic",
    maxBase64: 10_000_000,
    maxSide: 8000,
    manySide: { over: 20, side: 2000 },
    maxRequest: 32_000_000,
    maxCount: 600,
    formats: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  },
  // developers.openai.com/api/docs/guides/images-vision: no limit for one picture, which OpenAI resizes itself; 512 MB
  // "total payload" and 1,500 pictures a request; PNG, JPEG, WebP and "non-animated GIF".
  openai: {
    name: "OpenAI",
    maxRequest: 512_000_000,
    maxCount: 1500,
    formats: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    stillGif: true,
  },
  // platform.kimi.ai/docs/guide/use-kimi-vision-model: "4k (4096×2160)" is its recommendation, followed at the user's
  // word and read as a size class, so an upright picture fits 2160×4096 (plan, choice 23); a 100 MB "request body";
  // JPEG, PNG, GIF and WebP among others, animated GIF and WebP passed in as they are.
  kimi: { name: "Kimi", fit: [4096, 2160], maxRequest: 100_000_000, formats: ["image/jpeg", "image/png", "image/gif", "image/webp"] },
  // openrouter.ai/docs/guides/overview/multimodal/image-understanding.md: limits "vary per provider and per model", so
  // none here; PNG, JPEG, WebP and GIF.
  openrouter: { name: "OpenRouter", formats: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
  // docs.ollama.com/api/openai-compatibility documents no limits or formats.
  ollama: { name: "Ollama", formats: ALL },
  // The ChatGPT plan's route documents nothing public of its own. It reaches OpenAI's models through the Responses API,
  // whose images-vision guide (above) takes only "non-animated GIF".
  chatgpt: { name: "ChatGPT", formats: ALL, stillGif: true },
};

// Shrunk copies for the session, keyed by the picture's number and the limits it was shrunk to, so a copy made to 8000
// a side is made again at 2000 once a request holds more than 20 pictures (design, "What is sent, request by request").
// The copies made to 8000 then go unused for the rest of the session. That is accepted, with nothing evicted: the
// session keeps every original in memory anyway (plan, choice 9).
export type Cache = Map<string, Promise<Picture>>;

// What one picture must fit, whatever the request around it.
type Shape = Pick<Limits, "maxBase64" | "fit" | "formats" | "stillGif"> & { side?: number };

const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);

// The original when it already fits; otherwise a copy, scaled to the side and the fit, then by the square root of
// allowed over actual size, measured again until it fits, since the bytes follow the pixel area (design, "Shrinking").
// A format the provider does not list becomes PNG, and an animated GIF its first frame in PNG where the provider
// refuses animation (release 6 plan, choices 12 and 23); a picture that keeps its format keeps its frames.
async function shrink(p: Image, to: Shape): Promise<Picture> {
  try {
    return await copy(p, to);
  } catch {
    // Any failure: a picture sharp cannot read (cut off, not a picture, or over sharp's pixel limit), or one that
    // cannot fit even at one pixel. It goes as it is, so the provider says whether it takes it, and a refusal there is
    // asked about like any other (plan, choice 23 and Task 18).
    return { mediaType: p.mediaType, data: p.data };
  }
}

// sharp's defaults, relied on here (node_modules/sharp/dist/constructor.mjs, 0.35.5): JPEG and WebP are written at
// quality 80, and a picture of more than 268,402,689 pixels (0x3FFF × 0x3FFF) fails to read, so it is sent as it is.
async function copy(p: Image, to: Shape): Promise<Picture> {
  const meta = await sharp(p.data).metadata();
  const pages = meta.pages ?? 1;
  const mediaType = to.formats.includes(p.mediaType) && !(p.mediaType === "image/gif" && pages > 1 && to.stillGif) ? p.mediaType : "image/png";
  const frames = mediaType === p.mediaType && pages > 1;
  // Measured as shown, after any turn its camera recorded, since a copy loses that record. One frame's size.
  let { width, height } = meta.autoOrient;
  // The box stands as the picture does (plan, choice 23).
  const box = to.fit && (width >= height ? [Math.max(...to.fit), Math.min(...to.fit)] : [Math.min(...to.fit), Math.max(...to.fit)]);
  const scale = Math.min(1, to.side ? to.side / Math.max(width, height) : 1, box ? Math.min(box[0]! / width, box[1]! / height) : 1);
  const fits = (bytes: number) => to.maxBase64 === undefined || base64Length(bytes) <= to.maxBase64;
  const encode = () =>
    sharp(p.data, { autoOrient: true, animated: frames })
      .resize(width, height, { fit: "fill" })
      .toFormat(mediaType.slice("image/".length) as "png" | "jpeg" | "gif" | "webp")
      .toBuffer();
  let data = p.data;
  if (scale < 1 || mediaType !== p.mediaType) {
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    data = await encode();
  }
  while (!fits(data.length)) {
    if (width === 1 && height === 1) throw new Error("over the limit even at one pixel");
    const by = Math.sqrt(to.maxBase64! / base64Length(data.length));
    width = Math.max(1, Math.floor(width * by));
    height = Math.max(1, Math.floor(height * by));
    data = await encode();
  }
  return { mediaType, data };
}

// For one request: every picture in `messages`, shrunk from its original to fit, the oldest left out as notes until the
// request fits, how many were left out, and the limit they were left out for ("Anthropic's 32 MB"). `measure` gives the
// request's size in bytes as the adapter would send it with these pictures.
export async function prepare(
  messages: Message[],
  limits: Limits,
  measure: (prepared: Prepared) => number,
  cache: Cache,
): Promise<{ prepared: Prepared; leftOut: number; over: string }> {
  const images = messages.flatMap((m) => m.parts.filter((p) => p.type === "image"));
  const many = limits.manySide && images.length > limits.manySide.over ? limits.manySide.side : undefined;
  const sides = [limits.maxSide, many].filter((s) => s !== undefined);
  const side = sides.length ? Math.min(...sides) : undefined;
  const to: Shape = { maxBase64: limits.maxBase64, side, fit: limits.fit, formats: limits.formats, stillGif: limits.stillGif };
  const prepared = new Map<number, Picture | string>();
  for (const p of images) {
    const key = `${p.id} ${JSON.stringify(to)}`;
    let copy = cache.get(key);
    if (!copy) cache.set(key, (copy = shrink(p, to)));
    prepared.set(p.id, await copy);
  }

  // The oldest first, newest kept (design, "The whole request").
  const caps = new Set<string>();
  let leftOut = 0;
  // Leaves out the oldest picture still sent; how many bytes that saves at least: its base64 for its note.
  const leaveOut = (cap: string) => {
    caps.add(cap);
    const p = images[leftOut++]!;
    const note = `[Image #${p.id} left out: the request was over ${limits.name}'s ${cap}]`;
    const sent = prepared.get(p.id)!;
    prepared.set(p.id, note);
    return (typeof sent === "string" ? sent.length : base64Length(sent.data.length)) - note.length;
  };
  if (limits.maxCount !== undefined) {
    while (images.length - leftOut > limits.maxCount) leaveOut(`${limits.maxCount.toLocaleString("en-US")} pictures`);
  }
  if (limits.maxRequest !== undefined && leftOut < images.length) {
    // Measured once, then estimated as each picture goes, then measured again: measuring once a picture costs a whole
    // request's serialising each time. When the estimate falls short, one more goes at a time.
    const cap = `${limits.maxRequest / 1_000_000} MB`;
    let size = measure(prepared);
    if (size > limits.maxRequest) {
      while (size > limits.maxRequest && leftOut < images.length) size -= leaveOut(cap);
      size = measure(prepared);
      while (size > limits.maxRequest && leftOut < images.length) {
        leaveOut(cap);
        size = measure(prepared);
      }
    }
  }
  return { prepared, leftOut, over: `${limits.name}'s ${[...caps].join(" and ")}` };
}

// The body of one request, with its pictures fitted to `limits` and the session told of any left out. `body` builds the
// request as the adapter sends it, from a set of prepared pictures; it is serialised to measure the request.
export async function fitted<T>(req: CompletionRequest, limits: Limits, body: (prepared: Prepared) => T): Promise<T> {
  const sent = await prepare(req.messages, limits, (p) => Buffer.byteLength(JSON.stringify(body(p))), req.shrunk ?? new Map());
  if (sent.leftOut) req.leftOut?.(sent.leftOut, sent.over);
  return body(sent.prepared);
}
