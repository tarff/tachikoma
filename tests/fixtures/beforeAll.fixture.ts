import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileTempDir } from "../helpers.js";
import { note, there } from "./note.js";

// A folder made by fileTempDir inside a beforeAll, in a describe as tests/core/sessions.test.ts makes one (cleanup
// plan, step 4).
describe("a describe", () => {
  let folder = "";
  beforeAll(() => {
    folder = fileTempDir("tachi-fixture-beforeall-");
    note({ made: folder });
  });
  afterAll(() => note({ afterAll: there(folder) }));

  it("has the folder", () => expect(there(folder)).toBe("still there"));
  it("still has it in a later test", () => note({ laterTest: there(folder) }));
});
