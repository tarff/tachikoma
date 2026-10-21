import path from "node:path";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { Stats } from "../../src/core/stats.js";
import { TOOLS } from "../../src/tools/index.js";
import { App } from "../../src/tui/App.js";
import { SEGMENTS } from "../../src/tui/StatusLine.js";
import { Bus, FakeProvider, callTool, reply, tempContext } from "../helpers.js";

const tick = () => new Promise((r) => setTimeout(r, 50));

// Wait until the screen shows `text`; the session runs real file I/O in the background.
async function until(app: ReturnType<typeof render>, text: string) {
  for (let i = 0; i < 40 && !app.lastFrame()?.includes(text); i++) await tick();
  expect(app.lastFrame()).toContain(text);
}

async function mount(turns: ConstructorParameters<typeof FakeProvider>[1]) {
  const bus = new Bus();
  const stats = new Stats(bus);
  const ctx = await tempContext();
  let ask: (s: string) => Promise<boolean> = async () => false;
  const gate = new PermissionGate("ask", (s) => ask(s));
  const session = new Session({ lead: new FakeProvider("a", turns), tools: TOOLS, system: "t", ctx: { ...ctx, gate }, bus });
  const app = render(
    <App
      session={session}
      bus={bus}
      stats={stats}
      mode="ask"
      errorFile={path.join(ctx.root, "errors.jsonl")}
      segments={SEGMENTS}
      makeProvider={() => new FakeProvider("b", [])}
      bindAsk={(fn) => {
        ask = fn;
      }}
    />,
  );
  await tick();
  return { app, session, ctx, bus };
}

async function type(app: ReturnType<typeof render>, text: string) {
  app.stdin.write(text);
  await tick();
  app.stdin.write("\r");
  await tick();
}

describe("App", () => {
  it("sends what the user types and shows the reply", async () => {
    const { app } = await mount([reply("hello there")]);
    await type(app, "hi");
    expect(app.lastFrame()).toContain("> hi");
    await until(app, "hello there");
    expect(app.lastFrame()).toContain("lead fake:a");
  });

  it("asks before a write and goes ahead on y", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await type(app, "make a file");
    await until(app, `Allow write ${path.join(ctx.root, "a.txt")}? [y/n]`);
    app.stdin.write("y");
    await until(app, "written");
  });

  it("switches the lead with /lead", async () => {
    const { app, session } = await mount([]);
    await type(app, "/lead fake:b");
    expect(session.lead.id).toBe("fake:b");
    expect(app.lastFrame()).toContain("lead is now fake:b");
  });

  it("shows when another model answered a refused turn", async () => {
    const { app, bus } = await mount([]);
    bus.emit("error", { kind: "fallback", attempted: "x", message: "fake:a declined; fake:b answered instead", lead: "fake:a" });
    await until(app, "↪ fake:a declined; fake:b answered instead");
    expect(app.lastFrame()).toContain("0 errors");
  });

  it("summarises the error log with /errors", async () => {
    const { app } = await mount([]);
    await type(app, "/errors");
    expect(app.lastFrame()).toContain("No errors logged yet.");
  });
});
