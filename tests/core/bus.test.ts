import { describe, expect, it } from "vitest";
import { Bus } from "../../src/core/bus.js";

describe("Bus", () => {
  it("carries on when an error is reported and nobody is listening", () => {
    const bus = new Bus();
    expect(() => bus.emit("error", { kind: "tool", attempted: "shell", message: "exit code: 1", lead: "fake:a" })).not.toThrow();
  });
});
