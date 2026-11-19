import { describe, expect, it } from "vitest";
import { shellText } from "../../src/tools/shell.js";
// @ts-expect-error: a build script in plain JavaScript, with no type file.
import { QUERY_MAX, lessonQuery } from "../../scripts/8d/lesson-query.mjs";
// @ts-expect-error: a build script in plain JavaScript, with no type file.
import { firstWord } from "../../scripts/8d/measure-lesson-ask.mjs";
// @ts-expect-error: a build script in plain JavaScript, with no type file.
import { FAMILIES, MARKERS } from "../../scripts/8d/lesson-families.mjs";

// The lesson search's query (8d plan, step 13's re-run, and step 25, "The query"), on made-up text only. Step 25's
// own function is held to these same cases.
const failed = (stderr: string, stdout = "", code: number | null = 1, signal: NodeJS.Signals | null = null) =>
  shellText({ code, signal, stdout, stderr });
const cmd = (command: string) => ({ command });
const chars = (s: string) => [...s].length;

describe("the lesson search's query", () => {
  it("gives a failed command's name, first word and the first line it wrote to its error stream", () => {
    const error = failed("npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\n", "done\n");
    const q = lessonQuery("shell", cmd("npm install react@19"), error);
    expect(q).toBe("shell npm npm error code ERESOLVE");
    expect(q).not.toContain("exit code");
    expect(q).not.toContain("---");
  });

  it("takes the ordinary output's first line when the error stream is empty", () => {
    const error = failed("", "src/cart.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\n");
    expect(lessonQuery("shell", cmd("tsc -p tsconfig.json"), error)).toBe(
      "shell tsc src/cart.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.");
  });

  it("gives the status line when the command printed nothing", () => {
    expect(lessonQuery("shell", cmd("grep -rn TODO src"), failed(""))).toBe("shell grep exit code: 1");
  });

  it("passes over blank lines, Windows line ends included, before the message", () => {
    const error = failed("\r\n   \n\nfatal: Authentication failed\r\nmore\n");
    expect(lessonQuery("shell", cmd("git push"), error)).toBe("shell git fatal: Authentication failed");
  });

  it("handles a command killed by a signal as one that exited with a code", () => {
    expect(lessonQuery("shell", cmd("node seed.js"), failed("", "Seeding rows\n", null, "SIGKILL")))
      .toBe("shell node Seeding rows");
    expect(lessonQuery("shell", cmd("node seed.js"), failed("", "", null, "SIGKILL")))
      .toBe("shell node killed by SIGKILL");
  });

  it("gives a timeout's and a could-not-start text the name and the first line, with no first word", () => {
    const timeout = "Stopped: the command did not complete within its 30s timeout. A command that starts with sleep " +
      "is stopped at its timeout, not moved to the background.";
    expect(lessonQuery("shell", cmd("sleep 45"), timeout)).toBe(`shell ${timeout}`.slice(0, QUERY_MAX));
    const start = "The argument 'args[2]' must be a string without null bytes. Received 'echo a\\x00b'";
    expect(lessonQuery("shell", cmd("echo a\u0000b"), start)).toBe(`shell ${start}`);
  });

  it("gives another tool's failure its name and the error's first line, as before", () => {
    const error = "ENOENT: no such file or directory, open 'C:\\w\\a.ts'\nmore";
    expect(lessonQuery("read_file", { path: "src/a.ts" }, error))
      .toBe("read_file ENOENT: no such file or directory, open 'C:\\w\\a.ts'");
  });

  it("tells apart two commands with the same exit code and different messages, which the old rule did not", () => {
    const a = failed("To github.com:acme/shop.git\n ! [rejected]\n");
    const b = failed("Error: Port 5173 is already in use\n");
    expect(lessonQuery("shell", cmd("git push"), a)).not.toBe(lessonQuery("shell", cmd("vite"), b));
    expect(lessonQuery("shell", cmd("git push"), a, { old: true })).toBe("shell exit code: 1");
    expect(lessonQuery("shell", cmd("vite"), b, { old: true })).toBe("shell exit code: 1");
  });

  it("takes the first word as step 12's script takes it, on every command of step 12's own tests", () => {
    for (const command of ["npm test", "npm run test:all", "npm run build", "npm tset", "echo c1", "a".repeat(40_000),
      "  npm   test  "]) {
      const q = lessonQuery("shell", cmd(command), failed("boom\n"));
      expect(q.split(" ")[1]).toBe(String(firstWord(command)).slice(0, QUERY_MAX - "shell ".length));
    }
  });

  it("cuts a longer query to exactly 250 characters, never half of one", () => {
    const long = failed(`${"x".repeat(236)}${"\u{1F600}".repeat(20)}\n`);
    const q = lessonQuery("shell", cmd("npm test"), long);
    expect(chars(q)).toBe(QUERY_MAX);
    expect(q.endsWith("\u{1F600}")).toBe(true);
    expect(chars(lessonQuery("read_file", {}, "y".repeat(400)))).toBe(QUERY_MAX);
  });
});

type Failure = { tool: string; input: { command?: string }; error: string };
type Family = { id: string; failures: Failure[]; lessons: string[] };

describe("the made-up families", () => {
  const families = FAMILIES as Family[];
  const status = /^(exit code: -?\d+|killed by \S+)$/;
  const DATE = new RegExp("\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b(January|February|March|April|May|June|July|August|" +
    "September|October|November|December)\\b");

  it("give a failed command's error the real shape: a status line, then both markers", () => {
    for (const f of families) {
      for (const x of f.failures) {
        if (x.tool !== "shell" || !status.test(x.error.split("\n")[0]!)) continue;
        const lines = x.error.split("\n");
        expect(lines[1]).toBe(MARKERS[0]);
        expect(lines).toContain(MARKERS[1]);
      }
    }
    expect(families.some((f) => f.failures.some((x) => x.tool === "shell" && status.test(x.error.split("\n")[0]!))))
      .toBe(true);
  });

  it("write every lesson as one or two sentences with no date", () => {
    for (const f of families) {
      for (const l of f.lessons) {
        const ends = l.match(/[.!?](?=\s+[A-Z]|$)/g) ?? [];
        expect(ends.length, `${f.id}: ${l}`).toBeGreaterThanOrEqual(1);
        expect(ends.length, `${f.id}: ${l}`).toBeLessThanOrEqual(2);
        expect(l, f.id).not.toMatch(DATE);
      }
    }
  });

  it("never put a whole error line of a family into one of its lessons", () => {
    for (const f of families) {
      const lines = f.failures.flatMap((x) => x.error.split("\n").map((l) => l.trim()))
        .filter((l) => l && !MARKERS.includes(l));
      for (const l of f.lessons) for (const line of lines) expect(l.includes(line), `${f.id}: ${line}`).toBe(false);
    }
  });
});
