// The helper: what the box's Workspace (boxWorkspace.ts) runs in the box, by the box's own Node, to resolve, read, write,
// find and search there (release 7 design, "Nothing on the host opens a path in the box's folder while the box
// runs"; plan, Task 13). Its function's own source is sent with each call, so it stands alone: it uses nothing from
// outside the function but its arguments, takes Node's modules from the `require` it is given, and gets the `ignore`
// library as given. Only types are imported, which go. tsx adds a `__name(...)` call for each named function in it,
// which the call's code defines (boxWorkspace.ts, helperCode).
//
// Each answer is what the same code on the host gives (files.ts, search.ts, git.ts), but that every path
// whose real place leaves the root is refused, as in the box there is no question to allow it (design, "A path outside
// it is refused"). Tachikoma's data folder, its settings files and other programs' environments are not in the box, so
// they are not checked for.

type Fs = typeof import("node:fs");
type Path = typeof import("node:path");
type Rules = { base: string; rules: { test(p: string): { ignored: boolean; unignored: boolean } } }[];
// The `ignore` library's factory, as its index.js exports it.
export type Ignore = () => { add(text: string): Rules[number]["rules"] };

export type Request = { root: string } & (
  | { op: "resolve" | "readText"; path: string }
  | { op: "writeText"; path: string; content: string }
  | { op: "find"; path: string; pattern: string }
  | { op: "search"; path: string; pattern: string; glob?: string; cap: number; binaryBytes: number; lineCut: number }
  | { op: "branch" }
);

export function helper(request: Request, ignore: Ignore, require: NodeJS.Require): unknown {
  const fs: Fs = require("node:fs");
  const path: Path = require("node:path");
  const { root } = request;
  const base = fs.realpathSync.native(root);
  const posix = (p: string) => p.split(path.sep).join("/");
  const leaves = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  // Where `p` really leads, as files.ts's realTarget works it out: parts not made yet are added back onto the deepest
  // part that is. Refused when that leaves the root, or when a link on the way leads nowhere, as writing through it could
  // make its missing target, wherever that is.
  const place = (p: string): { abs: string; real: string } => {
    const abs = path.resolve(root, p);
    let existing = abs;
    const rest: string[] = [];
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
      if (fs.lstatSync(existing, { throwIfNoEntry: false })) throw new Error(`${abs} goes through a link that leads nowhere, which the sandbox never opens`);
      rest.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
    const real = path.join(fs.realpathSync.native(existing), ...rest);
    if (leaves(path.relative(base, real))) throw new Error(`${abs} is outside the project, which the sandbox never opens`);
    return { abs, real };
  };

  // search.ts's rulesIn, ignored and walk.
  const rulesIn = (folder: string): Rules => {
    const file = path.join(folder, ".gitignore");
    try {
      if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return [];
      return [{ base: folder, rules: ignore().add(fs.readFileSync(file, "utf8")) }];
    } catch {
      return [];
    }
  };
  const ignored = (rules: Rules, abs: string, folder: boolean) => {
    let out = false;
    for (const r of rules) {
      const t = r.rules.test(posix(path.relative(r.base, abs)) + (folder ? "/" : ""));
      if (t.ignored) out = true;
      else if (t.unignored) out = false;
    }
    return out;
  };
  const walk = (folder: string, rules: Rules, out: string[]): void => {
    const here = [...rules, ...rulesIn(folder)];
    let entries: import("node:fs").Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => byName(a.name, b.name))) {
      const abs = path.join(folder, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name !== ".git" && !ignored(here, abs, true)) walk(abs, here, out);
      } else if (e.isFile() && !ignored(here, abs, false)) out.push(abs);
    }
  };
  // search.ts's filesIn: the files under `start`, with the .gitignore rules from the root down.
  const files = (start: string): string[] => {
    const { real } = place(start);
    const rules: Rules = [];
    let folder = base;
    for (const part of path.relative(base, real).split(path.sep).filter(Boolean)) {
      rules.push(...rulesIn(folder));
      folder = path.join(folder, part);
    }
    if (fs.statSync(real).isFile()) return ignored(rules, real, false) ? [] : [real];
    const out: string[] = [];
    walk(real, rules, out);
    return out;
  };
  const shown = (real: string) => posix(path.relative(base, real));

  switch (request.op) {
    case "resolve": {
      const { abs, real } = place(request.path);
      const typed = path.relative(root, abs);
      const rel = path.relative(base, real);
      const asTyped = process.platform === "win32" ? rel.toLowerCase() === typed.toLowerCase() : rel === typed;
      return { abs, outside: false, shown: asTyped ? abs : `${abs} (really ${real})`, real };
    }
    case "readText":
      return fs.readFileSync(place(request.path).abs, "utf8");
    case "writeText": {
      const { abs } = place(request.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, request.content, "utf8");
      return null;
    }
    case "find": {
      const glob = request.pattern.replaceAll("\\", "/");
      return files(request.path)
        .map(shown)
        .filter((rel) => path.posix.matchesGlob(rel, glob))
        .sort(byName);
    }
    // search.ts's searchIn and its worker's grep, with the same cap and cut, given by the host.
    case "search": {
      const { pattern, cap, binaryBytes, lineCut } = request;
      const name = request.glob?.replaceAll("\\", "/");
      const regex = new RegExp(pattern);
      const matches: { file: string; line: number; text: string }[] = [];
      let size = 0;
      let beyond = 0;
      for (const f of files(request.path)) {
        const file = shown(f);
        if (name && !path.posix.matchesGlob(name.includes("/") ? file : path.basename(f), name)) continue;
        let buf: Buffer;
        try {
          buf = fs.readFileSync(f);
        } catch {
          continue;
        }
        if (buf.subarray(0, binaryBytes).includes(0)) continue;
        buf
          .toString("utf8")
          .split(/\r?\n/)
          .forEach((text, i) => {
            if (!regex.test(text)) return;
            const cut = text.length > lineCut ? `${text.slice(0, lineCut)} [cut: ${text.length - lineCut} more characters]` : text;
            const line = `${file}:${i + 1}: ${cut}`;
            if (!beyond && size + line.length + 1 <= cap) {
              matches.push({ file, line: i + 1, text: cut });
              size += line.length + 1;
            } else beyond++;
          });
      }
      return { matches, beyond };
    }
    // git.ts's gitBranch, but only in the root itself, whose folders above are not in the box, and only where the
    // repository's files are in the root.
    case "branch": {
      try {
        const dotGit = place(".git").real;
        const kind = fs.statSync(dotGit, { throwIfNoEntry: false });
        if (!kind) return null;
        const gitDir = kind.isDirectory() ? dotGit : place(path.resolve(root, fs.readFileSync(dotGit, "utf8").replace(/^gitdir: /, "").trim())).real;
        const head = fs.readFileSync(place(path.join(gitDir, "HEAD")).real, "utf8").trim();
        return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "HEAD";
      } catch {
        return null;
      }
    }
  }
}
