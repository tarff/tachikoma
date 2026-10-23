import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LoginError, LoginStore } from "../../src/auth/store.js";

const temp = () => path.join(mkdtempSync(path.join(tmpdir(), "tachi-store-")), "data");

describe("LoginStore", () => {
  it("starts empty, with a new machine ID that says nothing about the user", () => {
    const login = new LoginStore(temp()).read();
    expect(login).toMatchObject({ version: 0, noticeShown: false, accounts: [] });
    expect(login.hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  it("raises the version with each save and keeps what was saved", async () => {
    const store = new LoginStore(temp());
    await store.update(async (login, save) => {
      const first = save(login);
      save({ ...first, noticeShown: true });
    });
    expect(store.read()).toMatchObject({ version: 2, noticeShown: true });
  });

  it("refuses a damaged file and leaves it as it is", () => {
    const dir = temp();
    const store = new LoginStore(dir);
    store.read(); // makes the folder
    writeFileSync(store.file, "{ not json");
    expect(() => store.read()).toThrow(LoginError);
    expect(() => store.read()).toThrow("Move it aside, then sign in again with `tachi login chatgpt` (or /login chatgpt in a session).");
    expect(readFileSync(store.file, "utf8")).toBe("{ not json");
  });

  it("says which process it waits for, and which file to delete if none is running", async () => {
    const warnings: string[] = [];
    const store = new LoginStore(temp(), (w) => warnings.push(w));
    store.read(); // makes the folder
    writeFileSync(store.lockFile, String(process.ppid)); // running, and not this process
    const stop = new AbortController();
    const changing = store.update(async () => {}, stop.signal);
    while (!warnings.length) await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await expect(changing).rejects.toThrow();
    expect(warnings[0]).toContain(`process ${process.ppid}`);
    expect(warnings[0]).toContain(store.lockFile);
  });

  it("loses no change when two processes change the login at once", async () => {
    const dir = temp();
    const url = pathToFileURL(path.resolve("src/auth/store.ts")).href;
    const script = path.join(path.dirname(dir), "add.mts");
    // Each process adds five accounts, one change at a time, pausing between reading and saving so
    // that the two overlap.
    writeFileSync(
      script,
      `import { LoginStore } from ${JSON.stringify(url)};
const store = new LoginStore(${JSON.stringify(dir)}, () => {});
for (let i = 0; i < 5; i++) {
  await store.update(async (login, save) => {
    await new Promise((r) => setTimeout(r, 20));
    save({ ...login, accounts: [...login.accounts, { clientId: process.argv[2] + i, sub: "s" }] });
  });
}`,
    );
    const runs = ["a", "b"].map((tag) => new Promise((resolve) => spawn(process.execPath, ["--import", "tsx", script, tag], { stdio: "inherit" }).on("close", resolve)));
    expect(await Promise.all(runs)).toEqual([0, 0]);
    const login = new LoginStore(dir).read();
    expect(login.version).toBe(10);
    expect(login.accounts.map((a) => a.clientId).toSorted()).toEqual(["a0", "a1", "a2", "a3", "a4", "b0", "b1", "b2", "b3", "b4"]);
  }, 60_000);
});
