import { appendFileSync, existsSync } from "node:fs";

// Writes one line of what a fixture saw into the file tests/helpers.test.ts reads after the fixture's run.
export const note = (o: Record<string, unknown>) => appendFileSync(process.env.TACHI_FIXTURE_NOTES!, `${JSON.stringify(o)}\n`);
export const there = (folder: string) => (existsSync(folder) ? "still there" : "gone");
