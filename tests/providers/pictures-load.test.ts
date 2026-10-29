import { expect, it, vi } from "vitest";

// In a file of its own, as vi.mock reaches every import in its file: sharp, standing in for itself, records when it
// is first loaded.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("sharp", async (importOriginal) => {
  loads.count++;
  return await importOriginal();
});

// Loading sharp costs every launch about 60 ms, `-p` included, through settings.ts, anthropic.ts and pictures.ts.
it("loads sharp only when a picture is shrunk, not when pictures.ts is", async () => {
  const { LIMITS, prepare } = await import("../../src/providers/pictures.js");
  expect(loads.count).toBe(0);
  const picture = { type: "image" as const, id: 1, mediaType: "image/png" as const, data: Buffer.from("not a picture") };
  const { prepared } = await prepare([{ role: "user", parts: [picture] }], LIMITS.anthropic, () => 0, new Map());
  expect(loads.count).toBe(1);
  expect(prepared.get(1)).toEqual({ mediaType: "image/png", data: picture.data }); // unreadable, so sent as it is
});
