import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { type HelperOptions, mergeHeaders, runHelper } from "../../src/mcp/helper.js";
import { removeTree } from "../helpers.js";
import { fakeHelper } from "./fake.js";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A folder of the test's own, removed when the test finishes, tried every 50 ms up to 2 s, as tests/hooks/run.test.ts's
// folder() is, since Windows keeps the folder a killed program worked in for a moment after it is gone.
async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-helper-"));
  onTestFinished(async () => {
    for (let i = 0; ; i++) {
      try {
        return await removeTree(dir);
      } catch (err) {
        if (i === 40) throw err;
        await pause(50);
      }
    }
  });
  return dir;
}

// The test's folder, its fake helper, and `run`, which runs it as a user's entry's helper in that folder, with any
// options given over those.
async function setup() {
  const dir = await folder();
  const helper = fakeHelper(dir);
  const opts = { name: "x", url: "https://example.com/mcp", cwd: dir, root: dir, env: process.env, project: false };
  const run = (more: Partial<HelperOptions> = {}) => runHelper(helper.command, { ...opts, ...more });
  return { dir, helper, run };
}

// Up to 2 s for each run's helper to be gone, as for its folder (folder, above).
async function allEnded(runs: Record<string, any>[]) {
  for (const { pid } of runs) {
    for (let i = 0; i < 40 && alive(pid); i++) await pause(50);
    expect(alive(pid)).toBe(false);
  }
}

describe("runHelper", () => {
  it("gives the headers it printed, run in the folder given, with the server's name, address and root", async () => {
    const { dir, helper, run } = await setup();
    const cwd = path.join(dir, "settings");
    const root = path.join(dir, "project");
    mkdirSync(cwd);
    mkdirSync(root);
    helper.give({ "X-Key": "k1", Authorization: "Bearer t1" });
    expect(await run({ cwd, root })).toEqual({ headers: { "X-Key": "k1", Authorization: "Bearer t1" } });
    expect(helper.runs()).toMatchObject([{ cwd, name: "x", url: "https://example.com/mcp", project: root }]);
  }, 15_000);

  // Decision 13: a project's helper runs without any variable whose name looks like a credential, whatever its case.
  it("gives a project's helper no credential-looking variable, and the user's all of them", async () => {
    const { helper, run } = await setup();
    const credentials = ["GH_TOKEN", "my_secret", "DB_PASSWORD", "API_KEY_2", "AUTH_URL"];
    const env = { ...process.env, ...Object.fromEntries([...credentials, "PLAIN"].map((n) => [n, "made-up"])) };
    for (const project of [true, false]) await run({ env, project });
    const [projects, users] = helper.runs().map((r) => r.names as string[]);
    expect(projects).toContain("PLAIN");
    for (const name of credentials) {
      expect([name, projects!.includes(name), users!.includes(name)]).toEqual([name, false, true]);
    }
  }, 15_000);

  // Decision 28: the helper printed "no token today sk-fake-secret-1" on its error output; none of it is in the reason.
  it("says only the exit code of a helper that failed, never its error output", async () => {
    const { helper, run } = await setup();
    helper.mode("fail");
    expect(await run()).toEqual({ reason: "it exited with code 3" });
  }, 15_000);

  it("refuses output that is not a JSON object of text values", async () => {
    const { helper, run } = await setup();
    const reason = "it printed something other than a JSON object of text values";
    helper.mode("bad");
    expect(await run()).toEqual({ reason });
    helper.mode("ok");
    helper.give({ "X-Key": 5 });
    expect(await run()).toEqual({ reason });
  }, 15_000);

  it("says the code of the error when the helper cannot start", async () => {
    const { dir, run } = await setup();
    expect(await run({ cwd: path.join(dir, "missing") })).toEqual({ reason: "it could not start (ENOENT)" });
  }, 15_000);

  // Decision 15: a name HTTP takes (a token, RFC 9110, section 5.6.2), and a value without a line break or NUL.
  it("refuses a header name HTTP does not take, and a value with a line break", async () => {
    const { helper, run } = await setup();
    helper.give({ "Bad Name": "x" });
    expect(await run()).toEqual({ reason: 'it gave "Bad Name", which is not a header name' });
    helper.give({ "X-Key": "k1\r\nX-Other: k2" });
    expect(await run()).toEqual({ reason: 'it gave the header "X-Key" a value with a line break or NUL' });
  }, 15_000);

  // The test's own 500 ms, so it does not wait the real 10 s.
  it("ends a helper still running at its limit, and says the limit", async () => {
    const { helper, run } = await setup();
    helper.mode("slow");
    expect(await run({ limitMs: 500 })).toEqual({ reason: "it did not finish within 0.5 s" });
    await allEnded(helper.runs());
  }, 15_000);

  it("rejects with Cancelled when stopped, and ends the helper", async () => {
    const { helper, run } = await setup();
    helper.mode("slow");
    const stop = new AbortController();
    const running = run({ signal: stop.signal });
    // Up to 5 s for the helper to start and record its run, inside the test's own 15 s.
    for (let i = 0; i < 100 && helper.runs().length === 0; i++) await pause(50);
    expect(helper.runs()).toHaveLength(1);
    stop.abort();
    await expect(running).rejects.toThrow("Cancelled");
    await allEnded(helper.runs());
  }, 15_000);
});

describe("mergeHeaders", () => {
  it("puts the helper's headers over the static ones of the same name, whatever the letter case", () => {
    expect(mergeHeaders({ authorization: "Bearer old", "X-Region": "eu" }, { Authorization: "Bearer new" })).toEqual({
      "X-Region": "eu",
      Authorization: "Bearer new",
    });
  });
});
