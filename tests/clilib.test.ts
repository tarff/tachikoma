import { spawn } from "node:child_process";
import { constants } from "node:os";
import { describe, expect, it } from "vitest";
import { headlessAnswer, headlessExit, jsonLine, prose, statusSegments } from "../src/clilib.js";
import { SEGMENTS } from "../src/tui/StatusLine.js";

describe("headlessExit", () => {
  const run = { aborted: false, failed: false, declined: false };

  it("is 0 when the run finished cleanly", () => {
    expect(headlessExit(run)).toBe(0);
  });

  it("is 1 when a turn failed", () => {
    expect(headlessExit({ ...run, failed: true })).toBe(1);
  });

  it("is 1 when an action was declined, so a script does not take it for success", () => {
    expect(headlessExit({ ...run, declined: true })).toBe(1);
  });

  it("is 128 + SIGINT when stopped, whatever else happened", () => {
    expect(headlessExit({ aborted: true, failed: true, declined: true })).toBe(128 + constants.signals.SIGINT);
  });
});

describe("headless output", () => {
  it("shows escape codes and bidi overrides in an answer as text, keeping line breaks and tabs", () => {
    expect(prose("a\u001b]52;c;eA==\u0007\nb\tc\u202e")).toBe("a\\u001b]52;c;eA==\\u0007\nb\tc\\u202e");
  });

  it("escapes what JSON leaves raw, and the line still parses to the same value", () => {
    const data = { text: "x\u009b8m\u202e\u007f\n" };
    const line = jsonLine("message", data);
    expect(line).not.toMatch(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(JSON.parse(line)).toEqual({ event: "message", data });
  });
});

describe("headlessAnswer", () => {
  const piped = { raw: false, tty: false };

  it("leaves ordinary text exactly as written: Windows line endings, tabs and plain direction marks", () => {
    const text = "line one\r\nline two\tתודה\u200f عربي\u061c ok\u200e\n";
    expect(headlessAnswer(text, piped)).toEqual({ out: text });
  });

  it("escapes control codes, a lone carriage return and text-order overrides, and says so when piped", () => {
    expect(headlessAnswer("a\u001b[8mb\rc\u202ed\u2066e", piped)).toEqual({
      out: "a\\u001b[8mb␍c\\u202ed\\u2066e",
      note: "note: 4 control characters in the answer were printed as escapes; --raw prints the answer exactly",
    });
  });

  it("gives no note on a terminal, where the escapes are in plain sight", () => {
    expect(headlessAnswer("a\u001bb", { raw: false, tty: true })).toEqual({ out: "a\\u001bb" });
  });

  it("prints the answer exactly with --raw", () => {
    expect(headlessAnswer("a\u001b]52;c;eA==\u0007", { raw: true, tty: false })).toEqual({ out: "a\u001b]52;c;eA==\u0007" });
  });
});

describe("statusSegments", () => {
  it("shows every segment when none are given", () => {
    expect(statusSegments(undefined)).toEqual(SEGMENTS);
  });

  it("keeps the first of repeated segments", () => {
    expect(statusSegments("cost, lead,cost,lead")).toEqual(["cost", "lead"]);
  });

  it("names --status when a segment is unknown", () => {
    expect(() => statusSegments("lead,nope")).toThrow('--status must be one of: lead, context, tokens, cost, mode, errors, project, time, tools (got "nope")');
  });
});

describe("endOnEpipe", () => {
  it("ends quietly when the reader of its output stops early", async () => {
    // A real pipe: a single large write fails with EPIPE once the reader has gone.
    const script = `import { endOnEpipe } from "./src/clilib.ts"; process.stdout.on("error", endOnEpipe); process.stdout.write("x\\n".repeat(1e6));`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(stderr).toBe("");
    expect(code).toBe(0);
  });
});
