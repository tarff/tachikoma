import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it, onTestFinished } from "vitest";
import { removeTree } from "../helpers.js";

// Release 8c plan, Task 1: the library loads and talks to a server. The server is a script this test writes, speaking
// MCP's JSON-RPC by hand, one message per line, so the test needs no server package and starts nothing of the user's.
const SERVER = `
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize")
    send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } } });
  else if (m.method === "tools/list")
    send({ id: m.id, result: { tools: [{ name: "echo", description: "Says it back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  else send({ id: m.id, error: { code: -32601, message: "no such method" } });
});
`;

it("connects to a server over stdio and lists its tools", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-mcp-"));
  onTestFinished(() => removeTree(dir));
  const script = path.join(dir, "server.cjs");
  await writeFile(script, SERVER);
  const client = new Client({ name: "tachikoma-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], stderr: "pipe" }));
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(tools[0]!.description).toBe("Says it back");
  } finally {
    await client.close();
  }
});
