import { describe, expect, it } from "vitest";
import { firstWord, lessonQuery } from "../../src/memory/lessonQuery.js";
import { shellText } from "../../src/tools/shell.js";
// @ts-expect-error: a build script in plain JavaScript, with no type file.
import { lessonQuery as measured } from "../../scripts/8d/lesson-query.mjs";
// @ts-expect-error: a build script in plain JavaScript, with no type file.
import { firstWord as step12 } from "../../scripts/8d/measure-lesson-ask.mjs";

// The lesson search's query (8d plan, step 25, "The query"), held to the rule step 13's re-run measured with: every
// case of tests/memory/lesson-query.test.ts, with its expected query, is run against Tachikoma's own function and
// against the script's, and both must give it letter for letter. The script's `{ old: true }` cases are left out: that
// is the measurement's comparison with Q18's first rule, which Tachikoma does not have. Made-up text only.
const failed = (stderr: string, stdout = "", code: number | null = 1, signal: NodeJS.Signals | null = null) =>
  shellText({ code, signal, stdout, stderr });
const cmd = (command: string) => ({ command });
const chars = (s: string) => [...s].length;

const timeout = "Stopped: the command did not complete within its 30s timeout. A command that starts with sleep " +
  "is stopped at its timeout, not moved to the background.";
const start = "The argument 'args[2]' must be a string without null bytes. Received 'echo a\\x00b'";
const CASES: [name: string, tool: string, input: unknown, error: string, query: string][] = [
  ["a failed command's first error-stream line", "shell", cmd("npm install react@19"),
    failed("npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\n", "done\n"),
    "shell npm npm error code ERESOLVE"],
  ["the ordinary output's first line when the error stream is empty", "shell", cmd("tsc -p tsconfig.json"),
    failed("", "src/cart.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"),
    "shell tsc src/cart.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'."],
  ["the status line when the command printed nothing", "shell", cmd("grep -rn TODO src"), failed(""),
    "shell grep exit code: 1"],
  ["blank lines passed over, Windows line ends included", "shell", cmd("git push"),
    failed("\r\n   \n\nfatal: Authentication failed\r\nmore\n"), "shell git fatal: Authentication failed"],
  ["a command killed by a signal, with output", "shell", cmd("node seed.js"),
    failed("", "Seeding rows\n", null, "SIGKILL"), "shell node Seeding rows"],
  ["a command killed by a signal, with none", "shell", cmd("node seed.js"), failed("", "", null, "SIGKILL"),
    "shell node killed by SIGKILL"],
  ["`exit code: null`, with output", "shell", cmd("npm test"), failed("boom\n", "", null), "shell npm boom"],
  ["`exit code: null`, with none", "shell", cmd("npm test"), failed("", "", null), "shell npm exit code: null"],
  ["a Windows line end off another tool's first line", "read_file", { path: "a.ts" }, "ENOENT: no such file\r\nmore",
    "read_file ENOENT: no such file"],
  ["a Windows line end off a timeout's first line", "shell", cmd("sleep 9"), "Stopped: timeout\r\n",
    "shell Stopped: timeout"],
  ["a timeout: the name and the first line, no first word", "shell", cmd("sleep 45"), timeout,
    `shell ${timeout}`.slice(0, 250)],
  ["a command that could not start: the name and the first line", "shell", cmd("echo a\u0000b"), start,
    `shell ${start}`],
  ["another tool: its name and the error's first line", "read_file", { path: "src/a.ts" },
    "ENOENT: no such file or directory, open 'C:\\w\\a.ts'\nmore",
    "read_file ENOENT: no such file or directory, open 'C:\\w\\a.ts'"],
];

describe("the lesson search's query", () => {
  it.each(CASES)("gives step 13's query for %s", (_name, tool, input, error, query) => {
    expect(lessonQuery(tool, input, error)).toBe(query);
    expect(measured(tool, input, error)).toBe(query);
  });

  it("tells apart two commands with the same exit code and different messages", () => {
    const a = failed("To github.com:acme/shop.git\n ! [rejected]\n");
    const b = failed("Error: Port 5173 is already in use\n");
    expect(lessonQuery("shell", cmd("git push"), a)).not.toBe(lessonQuery("shell", cmd("vite"), b));
    expect(lessonQuery("shell", cmd("git push"), a)).toBe(measured("shell", cmd("git push"), a));
    expect(lessonQuery("shell", cmd("vite"), b)).toBe(measured("shell", cmd("vite"), b));
  });

  it("takes the first word as step 12's script takes it, on every command of step 12's own tests", () => {
    for (const command of ["npm test", "npm run test:all", "npm run build", "npm tset", "echo c1", "a".repeat(40_000),
      "  npm   test  "]) {
      expect(firstWord(command)).toBe(step12(command));
      const q = lessonQuery("shell", cmd(command), failed("boom\n"));
      expect(q).toBe(measured("shell", cmd(command), failed("boom\n")));
      expect(q.split(" ")[1]).toBe(String(step12(command)).slice(0, 250 - "shell ".length));
    }
    for (const command of [undefined, 3, "", "   "]) expect(firstWord(command)).toBe(step12(command));
  });

  it("cuts a longer query to exactly 250 characters, never half of one", () => {
    const long = failed(`${"x".repeat(236)}${"\u{1F600}".repeat(20)}\n`);
    const q = lessonQuery("shell", cmd("npm test"), long);
    expect(chars(q)).toBe(250);
    expect(q.endsWith("\u{1F600}")).toBe(true);
    expect(q).toBe(measured("shell", cmd("npm test"), long));
    expect(chars(lessonQuery("read_file", {}, "y".repeat(400)))).toBe(250);
    expect(lessonQuery("read_file", {}, "y".repeat(400))).toBe(measured("read_file", {}, "y".repeat(400)));
  });
});
