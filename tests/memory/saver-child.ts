// A second window's saver for tests/memory/saver.test.ts, run as
// `node --import tsx tests/memory/saver-child.ts <hub url> <lock folder> <turn file> <record file> [probe]`.
// It connects to the hub, gives its saver the turn in the turn file ({ session, n, typed, texts, room }), saves it, and
// prints "done <unsaved turns>". Its saved record is a line in the record file, beside the hub's own, so the test sees
// the order of both. `probe`: before anything, it tries the save lock once and prints "busy" or "free", letting go at
// once if it took it, so its saver never takes a lock this process holds.
import { appendFileSync, readFileSync } from "node:fs";
import { connect } from "../../src/memory/client.js";
import { tryLock } from "../../src/memory/oslock.js";
import { Saver } from "../../src/memory/saver.js";

const [url, folder, turnFile, record, mode] = process.argv.slice(2) as [string, string, string, string, string?];
// Each request's limit, the one Tachikoma gives its saver (src/cli.tsx, ADD_LIMIT): 13 s, 5 times the slowest whole
// part's add (the user's choice at step 22).
const LIMIT = 13_000;

if (mode === "probe") {
  const lock = tryLock(folder, "save");
  console.log(lock ? "free" : "busy");
  lock?.release();
}
const c = await connect({ url }, "own", { timeout: LIMIT });
if (c.is !== "connected") {
  console.log(`not connected: ${JSON.stringify(c)}`);
  process.exit(1);
}
const turn = JSON.parse(readFileSync(turnFile, "utf8")) as { session: string; n: number; typed: string;
  texts: string[]; room: string };
const saver = new Saver({ memory: { palace: c.palace }, room: turn.room, folder, timeout: LIMIT });
const label = `tachikoma session ${turn.session}, turn ${turn.n}`;
saver.hand({ ...turn, record: () => appendFileSync(record, `${JSON.stringify({ saved: label, by: "child" })}\n`) });
await saver.run(new AbortController().signal);
console.log(`done ${saver.unsaved}`);
await c.palace.close();
