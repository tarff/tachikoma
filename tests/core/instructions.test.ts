import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTE, type Reached, readInstructions } from "../../src/core/instructions.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// A pretend machine in a fresh temporary folder, so no test reads the user's own files: `top` stands
// for the top of the drive, `home` for the user's folder, and the project is top/work/proj.
async function machine(tree: Record<string, string> = {}) {
  const top = await mkdtemp(path.join(tmpdir(), "tachi-"));
  const at = (p: string) => path.join(top, ...p.split("/"));
  await mkdir(at("home"), { recursive: true });
  await mkdir(at("work/proj"), { recursive: true });
  for (const [p, body] of Object.entries(tree)) {
    await mkdir(path.dirname(at(p)), { recursive: true });
    await writeFile(at(p), body);
  }
  return { top, home: at("home"), root: at("work/proj"), at };
}
type Machine = Awaited<ReturnType<typeof machine>>;

// Asking fails the test unless the test gives its own answer.
const unasked = async (): Promise<boolean> => {
  throw new Error("asked");
};
const read = (m: Machine, approve: (r: Reached[]) => Promise<boolean> = unasked, codexHome?: string) =>
  readInstructions({ root: m.root, home: m.home, top: m.top, ...(codexHome ? { codexHome } : {}) }, approve);
const file = (p: string, body: string) => `<file path="${p}">\n${body}\n</file>`;

describe("readInstructions", () => {
  it("reads the user's files, then each folder's from the top down, both kinds, labelled with their paths", async () => {
    const m = await machine({
      "home/.claude/CLAUDE.md": "user claude",
      "codex/AGENTS.md": "user codex",
      "CLAUDE.md": "top",
      "work/AGENTS.md": "work agents",
      "work/proj/AGENTS.md": "proj agents",
      "work/proj/CLAUDE.local.md": "proj local",
      "work/proj/.claude/CLAUDE.md": "proj dot claude",
      "work/proj/CLAUDE.md": "proj claude",
    });
    const r = await read(m, unasked, m.at("codex"));
    const order = ["home/.claude/CLAUDE.md", "codex/AGENTS.md", "CLAUDE.md", "work/AGENTS.md", "work/proj/CLAUDE.md", "work/proj/.claude/CLAUDE.md", "work/proj/CLAUDE.local.md", "work/proj/AGENTS.md"];
    expect(r.read.map((f) => f.path)).toEqual(order.map(m.at));
    const bodies = ["user claude", "user codex", "top", "work agents", "proj claude", "proj dot claude", "proj local", "proj agents"];
    expect(r.text).toBe([NOTE, ...order.map((p, n) => file(m.at(p), bodies[n]!))].join("\n\n"));
    expect(r.read[0]!.size).toBe("user claude".length);
    expect(r.left).toEqual([]);
  });

  it("reads the user's Codex file from ~/.codex when CODEX_HOME is not set", async () => {
    const m = await machine({ "home/.codex/AGENTS.md": "codex" });
    expect((await read(m)).read.map((f) => f.path)).toEqual([m.at("home/.codex/AGENTS.md")]);
  });

  it("has nothing to add with no files, and skips empty ones", async () => {
    const m = await machine({ "work/proj/CLAUDE.md": "  \n" });
    expect(await read(m)).toEqual({ text: "", read: [], left: [] });
  });

  it("leaves out a file that is not text, and says why", async () => {
    const m = await machine({ "work/proj/AGENTS.md": "a\u0000b", "work/proj/CLAUDE.md": "fine" });
    const r = await read(m);
    expect(r.read.map((f) => f.path)).toEqual([m.at("work/proj/CLAUDE.md")]);
    expect(r.left).toEqual([{ path: m.at("work/proj/AGENTS.md"), why: "not text" }]);
  });

  it("expands @ imports where they stand: relative to the file, absolute, and ~; one that leads nowhere stays", async () => {
    const m = await machine({ "work/proj/docs/a.md": "A, then @b.md", "work/proj/docs/b.md": "B", "work/proj/c.md": "C", "home/.claude/CLAUDE.md": "see @~/d.md", "home/d.md": "D" });
    await writeFile(m.at("work/proj/CLAUDE.md"), `See @docs/a.md and @${m.at("work/proj/c.md")} but not @missing.md.`);
    const r = await read(m);
    expect(r.text).toBe(
      [
        NOTE,
        file(m.at("home/.claude/CLAUDE.md"), `see ${file(m.at("home/d.md"), "D")}`),
        file(m.at("work/proj/CLAUDE.md"), `See ${file(m.at("work/proj/docs/a.md"), `A, then ${file(m.at("work/proj/docs/b.md"), "B")}`)} and ${file(m.at("work/proj/c.md"), "C")} but not @missing.md.`),
      ].join("\n\n"),
    );
    expect(r.read.map((f) => f.path)).toEqual(["home/.claude/CLAUDE.md", "home/d.md", "work/proj/CLAUDE.md", "work/proj/docs/a.md", "work/proj/docs/b.md", "work/proj/c.md"].map(m.at));
  });

  it("follows imports four levels deep and no further", async () => {
    const m = await machine({ "work/proj/CLAUDE.md": "0 @1.md", "work/proj/1.md": "1 @2.md", "work/proj/2.md": "2 @3.md", "work/proj/3.md": "3 @4.md", "work/proj/4.md": "4 @5.md", "work/proj/5.md": "5" });
    const r = await read(m);
    expect(r.read.map((f) => path.basename(f.path))).toEqual(["CLAUDE.md", "1.md", "2.md", "3.md", "4.md"]);
    expect(r.text).toContain(file(m.at("work/proj/4.md"), "4 @5.md"));
  });

  it("expands a file's imports from where it has the most levels left, when reached again higher up", async () => {
    // AGENTS.md is first reached as the fourth import, whose own imports are not followed; the walk then
    // finds it in the project, where they are.
    const m = await machine({ "work/proj/CLAUDE.md": "@a.md", "work/proj/a.md": "@b.md", "work/proj/b.md": "@c.md", "work/proj/c.md": "@AGENTS.md", "work/proj/AGENTS.md": "agents @rules.md", "work/proj/rules.md": "rules" });
    const r = await read(m);
    expect(r.read.map((f) => path.basename(f.path))).toEqual(["CLAUDE.md", "a.md", "b.md", "c.md", "AGENTS.md", "rules.md"]);
    expect(r.text).toContain(file(m.at("work/proj/AGENTS.md"), `agents ${file(m.at("work/proj/rules.md"), "rules")}`));
  });

  it("reads each file once, so an import loop ends", async () => {
    const m = await machine({ "work/proj/CLAUDE.md": "@a.md", "work/proj/a.md": "a @b.md", "work/proj/b.md": "b @a.md @CLAUDE.md" });
    const r = await read(m);
    expect(r.read.map((f) => path.basename(f.path))).toEqual(["CLAUDE.md", "a.md", "b.md"]);
    expect(r.text).toContain(file(m.at("work/proj/b.md"), "b @a.md @CLAUDE.md"));
  });

  it("leaves imports in code blocks and code spans alone", async () => {
    const m = await machine({ "work/proj/x.md": "X", "work/proj/CLAUDE.md": ["```", "@x.md", "```", "`@x.md` and @x.md"].join("\n") });
    const r = await read(m);
    expect(r.text).toContain(file(m.at("work/proj/CLAUDE.md"), ["```", "@x.md", "```", `\`@x.md\` and ${file(m.at("work/proj/x.md"), "X")}`].join("\n")));
  });
});

describe("readInstructions, files that lead elsewhere", () => {
  it("asks once about imports leading out of the project, naming who imported each, and reads them when allowed", async () => {
    const m = await machine({ "elsewhere/one.md": "one", "elsewhere/two.md": "two", "work/notes.md": "notes" });
    await writeFile(m.at("work/proj/CLAUDE.md"), `@${m.at("elsewhere/one.md")} @../notes.md`);
    await writeFile(m.at("work/AGENTS.md"), `@${m.at("elsewhere/two.md")}`);
    const asked: Reached[][] = [];
    const r = await read(m, async (reached) => (asked.push(reached), true));
    expect(asked).toEqual([
      [
        { path: m.at("elsewhere/two.md"), how: `imported by ${m.at("work/AGENTS.md")}` },
        { path: m.at("elsewhere/one.md"), how: `imported by ${m.at("work/proj/CLAUDE.md")}` },
        { path: m.at("work/notes.md"), how: `imported by ${m.at("work/proj/CLAUDE.md")}` },
      ],
    ]);
    expect(r.text).toContain(file(m.at("elsewhere/one.md"), "one"));
  });

  it("leaves them out when declined, the import staying as text, and says so", async () => {
    const m = await machine({ "elsewhere/one.md": "one" });
    await writeFile(m.at("work/proj/CLAUDE.md"), `see @${m.at("elsewhere/one.md")}`);
    const r = await read(m, async () => false);
    expect(r.text).toBe([NOTE, file(m.at("work/proj/CLAUDE.md"), `see @${m.at("elsewhere/one.md")}`)].join("\n\n"));
    expect(r.left).toEqual([{ path: m.at("elsewhere/one.md"), why: "not allowed" }]);
  });

  it("still reads a project file that a declined file imports, in its own place, and once when allowed", async () => {
    const m = await machine({ "elsewhere/x.md": "x @../work/proj/AGENTS.md", "work/proj/AGENTS.md": "agents" });
    await writeFile(m.at("work/proj/CLAUDE.md"), `see @${m.at("elsewhere/x.md")}`);
    const declined = await read(m, async () => false);
    const agents = file(m.at("work/proj/AGENTS.md"), "agents");
    expect(declined.text).toBe([NOTE, file(m.at("work/proj/CLAUDE.md"), `see @${m.at("elsewhere/x.md")}`), agents].join("\n\n"));
    expect(declined.left).toEqual([{ path: m.at("elsewhere/x.md"), why: "not allowed" }]);
    const allowed = await read(m, async () => true);
    expect(allowed.text).toBe([NOTE, file(m.at("work/proj/CLAUDE.md"), `see ${file(m.at("elsewhere/x.md"), `x ${agents}`)}`)].join("\n\n"));
  });

  it("asks about a found file that a link takes to another folder", async () => {
    const m = await machine({ "elsewhere/CLAUDE.md": "far" });
    // A junction needs no special rights on Windows; elsewhere it is an ordinary symlink.
    await symlink(m.at("elsewhere"), m.at("work/proj/.claude"), "junction");
    const asked: Reached[][] = [];
    const r = await read(m, async (reached) => (asked.push(reached), false));
    expect(asked).toEqual([[{ path: realpathSync(m.at("elsewhere/CLAUDE.md")), how: `found as ${m.at("work/proj/.claude/CLAUDE.md")}` }]]);
    expect(r).toEqual({ text: "", read: [], left: [{ path: realpathSync(m.at("elsewhere/CLAUDE.md")), why: "not allowed" }] });
  });

  it("reads unasked a CLAUDE.md that is a link to the AGENTS.md beside it, once", async (ctx) => {
    const m = await machine({ "work/proj/AGENTS.md": "shared" });
    try {
      symlinkSync(m.at("work/proj/AGENTS.md"), m.at("work/proj/CLAUDE.md"), "file");
    } catch {
      return ctx.skip(); // Windows allows file symlinks only with Developer Mode or as an administrator
    }
    const r = await read(m);
    expect(r.text).toBe([NOTE, file(m.at("work/proj/CLAUDE.md"), "shared")].join("\n\n"));
  });

  it("asks about a found CLAUDE.md that is a link to a file in another folder", async (ctx) => {
    const m = await machine({ "elsewhere/x.md": "far" });
    try {
      symlinkSync(m.at("elsewhere/x.md"), m.at("work/proj/CLAUDE.md"), "file");
    } catch {
      return ctx.skip(); // Windows allows file symlinks only with Developer Mode or as an administrator
    }
    const asked: Reached[][] = [];
    await read(m, async (reached) => (asked.push(reached), false));
    expect(asked).toEqual([[{ path: realpathSync(m.at("elsewhere/x.md")), how: `found as ${m.at("work/proj/CLAUDE.md")}` }]]);
  });

  it("reads the user's own files and what they import unasked, wherever it is", async () => {
    const m = await machine({ "elsewhere/y.md": "Y", "codex/AGENTS.md": "codex @../elsewhere/y.md" });
    await mkdir(m.at("home/.claude"));
    await writeFile(m.at("home/.claude/CLAUDE.md"), `@${m.at("elsewhere/y.md")}`);
    const r = await read(m, unasked, m.at("codex"));
    expect(r.read.map((f) => f.path)).toEqual([m.at("home/.claude/CLAUDE.md"), m.at("elsewhere/y.md"), m.at("codex/AGENTS.md")]);
  });

  it("never reads Tachikoma's data folder, even when allowed, imported or found through a link", async () => {
    const m = await machine({ "data/chatgpt.json": "token", "data/CLAUDE.md": "data" });
    vi.stubEnv("TACHI_DATA_DIR", m.at("data"));
    await writeFile(m.at("work/proj/CLAUDE.md"), `@${m.at("data/chatgpt.json")}`);
    await mkdir(m.at("home/.claude"));
    await writeFile(m.at("home/.claude/CLAUDE.md"), `@${m.at("data/chatgpt.json")}`);
    await symlink(m.at("data"), m.at("work/proj/.claude"), "junction");
    const r = await read(m, async () => true);
    expect(r.text).not.toContain("token");
    expect(r.text).not.toContain(file(m.at("work/proj/.claude/CLAUDE.md"), "data"));
    expect(r.left.map((l) => l.path)).toEqual([m.at("data/chatgpt.json"), m.at("data/chatgpt.json"), m.at("work/proj/.claude/CLAUDE.md")]);
    for (const l of r.left) expect(l.why).toContain("Tachikoma's data folder");
  });

  it.runIf(process.platform === "linux")("never reads a program's environment", async () => {
    const m = await machine({ "home/.claude/CLAUDE.md": "@/proc/self/environ" });
    const r = await read(m, async () => true);
    expect(r.read.map((f) => f.path)).toEqual([m.at("home/.claude/CLAUDE.md")]);
    expect(r.left[0]!.why).toContain("a program's environment");
  });
});
