import { afterAll, describe, expect, it } from "vitest";
import { fileTempDir } from "../helpers.js";
import { note, there } from "./note.js";

// A folder made by fileTempDir in a describe's body (cleanup plan, step 4).
describe("a describe", () => {
  const folder = fileTempDir("tachi-fixture-describe-");
  note({ made: folder });
  afterAll(() => note({ afterAll: there(folder) }));

  it("has the folder", () => expect(there(folder)).toBe("still there"));
  it("still has it in a later test", () => note({ laterTest: there(folder) }));
});
