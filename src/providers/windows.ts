// Context windows of OpenAI API models, in tokens. Read 2026-10-28 from developers.openai.com/api/docs/models/<model>
// (release 6 design, "OpenAI API context windows"); each row was checked against its page the same day.
// The dated snapshots on those pages are found by taking the date off, so they have no rows: gpt-5.5 and
// gpt-5.5-pro -2026-04-23; gpt-5.4 and gpt-5.4-pro -2026-03-05; gpt-4.1 and gpt-4.1-mini -2025-04-14;
// gpt-5.4-mini and gpt-5.4-nano -2026-03-17; gpt-5.2 and gpt-5.2-pro -2025-12-11; gpt-5.1 -2025-11-13;
// gpt-5-pro -2025-10-06; gpt-5, gpt-5-mini and gpt-5-nano -2025-08-07; o3 -2025-04-16; o3-pro -2025-06-10;
// gpt-4o -2024-11-20, -2024-08-06, and -2024-05-13, which its page lists as shut down; gpt-4o-mini -2024-07-18.
// gpt-5.6 is the gpt-5.6-sol page's alias for that model.
export const OPENAI_WINDOWS: Record<string, number> = {
  "gpt-6-astra": 1_050_000,
  "gpt-6.1-sol": 1_050_000,
  "gpt-6.1-terra": 1_050_000,
  "gpt-6-luna": 1_050_000,
  "gpt-6-sol": 1_050_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.5-pro": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-pro": 1_050_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-5.6-cyber": 400_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.2": 400_000,
  "gpt-5.2-pro": 400_000,
  "gpt-5.1": 400_000,
  "gpt-5-pro": 400_000,
  "gpt-5": 400_000,
  "gpt-5-mini": 400_000,
  "gpt-5-nano": 400_000,
  "chat-latest": 400_000,
  o3: 200_000,
  "o3-pro": 200_000,
  "gpt-oss-120b": 131_072,
  "gpt-oss-20b": 131_072,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
};

// The model's own row, or its row once one -YYYY-MM-DD is taken off the end, so a snapshot no page
// lists yet still finds its model. hasOwn, so inherited names such as "constructor" find nothing.
export function openaiWindow(model: string): number | null {
  for (const name of [model, model.replace(/-\d{4}-\d{2}-\d{2}$/, "")]) {
    if (Object.hasOwn(OPENAI_WINDOWS, name)) return OPENAI_WINDOWS[name] ?? null;
  }
  return null;
}
