import { describe, expect, it } from "vitest";
import type { TodoItem } from "../../src/tools/todo.js";
import { todoTool } from "../../src/tools/todo.js";
import { brief } from "../../src/tui/describe.js";
import { tempContext } from "../helpers.js";

describe("todo", () => {
  it("hands the whole list on each time and says what it saved", async () => {
    const lists: TodoItem[][] = [];
    const tool = todoTool((items) => lists.push(items));
    const ctx = await tempContext();
    const items: TodoItem[] = [
      { text: "read the login code", status: "done" },
      { text: "find where the token is saved", status: "in_progress" },
      { text: "write the fix", status: "pending" },
    ];
    expect(await tool.run({ items }, ctx)).toBe("Saved 3 items, 2 not done");
    expect(await tool.run({ items: [] }, ctx)).toBe("Saved 0 items, 0 not done");
    expect(lists).toEqual([items, []]);
  });

  it("takes only pending, in_progress and done", async () => {
    const tool = todoTool(() => {});
    await expect(tool.run({ items: [{ text: "x", status: "started" }] }, await tempContext())).rejects.toThrow("Invalid input for todo");
  });

  it("is shown on screen by how many items it has", () => {
    expect(brief("todo", { items: [{ text: "a", status: "done" }, { text: "b", status: "pending" }] })).toBe("2 items");
    expect(brief("todo", { items: [{ text: "a", status: "done" }] })).toBe("1 item");
  });
});
