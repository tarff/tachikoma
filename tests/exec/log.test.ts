import { describe, expect, it } from "vitest";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { CommandLog, deliver, headCommand } from "../../src/exec/log.js";

const RUNNING = "t4 is still running.";
const more = (n: number) => `[${n} more characters: shell_output t4 gives them]`;
const dropped = (n: number) => `[${n} earlier characters were dropped]`;

// The output a delivery gave: what lies between its head (and a dropped note) and its more note.
function output(delivery: string, head: string): string {
  expect(delivery.startsWith(`${head}\n`)).toBe(true);
  return delivery
    .slice(head.length + 1)
    .replace(/^\[\d+ earlier characters were dropped\]\n/, "")
    .replace(/\n\[\d+ more characters: shell_output t4 gives them\]$/, "");
}

describe("headCommand", () => {
  it("leaves a command of 1,000 characters or fewer as it is", () => {
    expect(headCommand("npm test")).toBe("npm test");
    expect(headCommand("x".repeat(1_000))).toBe("x".repeat(1_000));
  });

  it("cuts a longer command to its first 1,000 characters and says how many more there were", () => {
    expect(headCommand(`${"x".repeat(1_000)}yz`)).toBe(`${"x".repeat(1_000)}… [+2 chars]`);
  });
});

describe("CommandLog", () => {
  it("keeps the newest 30,000 characters and counts every one added", () => {
    const log = new CommandLog();
    log.add("a".repeat(25_000));
    log.add("b".repeat(10_000));
    expect(log.total).toBe(35_000);
    expect(log.kept()).toBe("a".repeat(20_000) + "b".repeat(10_000));
    expect(log.unread()).toBe(35_000);
  });

  it("keeps the newest characters when one piece is longer than it keeps", () => {
    const log = new CommandLog(5);
    log.add("abc");
    log.add("0123456789");
    expect(log.kept()).toBe("56789");
    expect(log.total).toBe(13);
  });

  it("a read gives what was added since the last read", () => {
    const log = new CommandLog();
    log.add("one\n");
    expect(deliver(RUNNING, log, "t4")).toBe(`${RUNNING}\none\n`);
    log.add("two\n");
    log.add("three\n");
    expect(log.unread()).toBe(10);
    expect(deliver(RUNNING, log, "t4")).toBe(`${RUNNING}\ntwo\nthree\n`);
    expect(log.unread()).toBe(0);
  });

  it("a read past dropped output says how many characters were dropped, then gives the oldest kept", () => {
    const log = new CommandLog(10);
    log.add("abcdefghij");
    expect(deliver(RUNNING, log, "t4")).toBe(`${RUNNING}\nabcdefghij`);
    log.add("0123456789ABCDE");
    expect(log.unread()).toBe(15);
    expect(deliver(RUNNING, log, "t4")).toBe(`${RUNNING}\n${dropped(5)}\n56789ABCDE`);
    expect(log.unread()).toBe(0);
  });

  it("kept() between two reads changes neither", () => {
    const log = new CommandLog();
    log.add("abc");
    expect(log.kept()).toBe("abc");
    expect(deliver(RUNNING, log, "t4")).toBe(`${RUNNING}\nabc`);
    log.add("def");
    expect(log.kept()).toBe("abcdef");
    expect(log.unread()).toBe(3);
    expect(deliver(RUNNING, log, "t4")).toBe(`${RUNNING}\ndef`);
  });

  it("with nothing new, a read gives its head and No new output.", () => {
    const log = new CommandLog();
    expect(deliver(RUNNING, log, "t4")).toBe(`${RUNNING}\nNo new output.`);
    log.add("done");
    deliver(RUNNING, log, "t4");
    expect(deliver(RUNNING, log, "t4")).toBe(`${RUNNING}\nNo new output.`);
  });
});

describe("deliver", () => {
  it("a 40,000-character command in the head still leaves room for the id, the state and output", () => {
    const log = new CommandLog();
    log.add("x".repeat(30_000));
    const command = "y".repeat(40_000);
    const head = `Background command t4 (${headCommand(command)}) ended with exit code 1:`;
    const delivery = deliver(head, log, "t4");
    expect(delivery.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
    expect(delivery.startsWith(`Background command t4 (${"y".repeat(1_000)}… [+39000 chars]) ended with exit code 1:\n`)).toBe(true);
    expect(output(delivery, head).length).toBeGreaterThan(0);
    expect(output(delivery, head)).toMatch(/^x+$/);
  });

  it("a delivery whose two counts have as many digits as the total is exactly 30,000 characters", () => {
    const log = new CommandLog();
    // 45,000 added: 15,000 dropped. A head of 10,500 leaves room for under 20,000, so over 10,000 stay unread: both counts
    // have five digits, as the total does, so the room the notes were given is all used.
    log.add("x".repeat(45_000));
    const head = "h".repeat(10_500);
    const delivery = deliver(head, log, "t4");
    expect(delivery.startsWith(`${head}\n${dropped(15_000)}\n`)).toBe(true);
    expect(log.unread()).toBeGreaterThanOrEqual(10_000);
    expect(delivery.endsWith(`\n${more(log.unread())}`)).toBe(true);
    expect(delivery.length).toBe(MAX_TOOL_OUTPUT);
  });

  it("a full log with a long head comes in parts that fit, each starting where the last stopped, the newest character once", () => {
    const log = new CommandLog();
    // More than the log keeps, so the first part also carries the dropped note; Z is the last character added.
    log.add(`${"x".repeat(34_999)}Z`);
    const head = `Background command t4 (${headCommand("y".repeat(40_000))}) ended with exit code 1:`;

    const first = deliver(head, log, "t4");
    expect(first.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
    expect(first.startsWith(`${head}\n${dropped(5_000)}\n`)).toBe(true);
    expect(first.endsWith(`\n${more(log.unread())}`)).toBe(true);
    expect(log.unread()).toBeGreaterThan(0);
    const firstOut = output(first, head);

    const second = deliver(head, log, "t4");
    expect(second.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
    expect(second).not.toContain("earlier characters were dropped");
    expect(second).not.toContain("more characters: shell_output");
    const secondOut = output(second, head);

    expect(firstOut + secondOut).toBe(log.kept());
    expect(`${firstOut}${secondOut}`.split("Z").length - 1).toBe(1);
    expect(log.unread()).toBe(0);
    expect(deliver(head, log, "t4")).toBe(`${head}\nNo new output.`);
  });
});
