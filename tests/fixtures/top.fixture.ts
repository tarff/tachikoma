import { afterAll, expect, it } from "vitest";
import { fileTempDir } from "../helpers.js";
import { note, there } from "./note.js";

// A folder made by fileTempDir at the top of the file (cleanup plan, step 4).
const folder = fileTempDir("tachi-fixture-top-");
note({ made: folder });
afterAll(() => note({ afterAll: there(folder) }));

it("has the folder", () => expect(there(folder)).toBe("still there"));
it("still has it in a later test", () => note({ laterTest: there(folder) }));
