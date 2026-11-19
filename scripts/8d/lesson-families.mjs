// MADE-UP failures and MADE-UP lessons for measurement 5's re-run (8d plan, step 13, after the user's answers). Not
// part of Tachikoma. Every failure and every lesson here was written by hand by the builder for this measurement: none
// is taken from the user's logs or transcripts, and no model wrote or chose any of it (nothing here calls a model).
// Every path, command, server, number and message is made up, in the shape of Tachikoma's own tool errors.
//
// A family is one kind of failure: several failures a person would call the same failure. Each failure has a tool's
// name, the call's input, and the whole error text as the tool gives it: a failed command's error is built by
// Tachikoma's own shellText (src/tools/shell.ts:4-8), so it has the real shape (a status line, `--- stderr ---`, the
// error stream, `--- stdout ---`, the ordinary output). Each family with lessons has one or two, written as sentences
// the way record_lesson and /lesson will store them: what went wrong, what fixed it, and how to spot it, with no date
// and no project. Seven families have no lesson, on purpose, to count how often a failure with nothing to learn from
// is handed another family's lesson.
//
// Sizes: 29 families, 4 failures each (116 failures): enough members to vary each family's paths, numbers, arguments
// and wording, and few enough to read through by hand. 28 lessons, so one search of `lessons` (at most 100 results,
// _MAX_RESULTS, mempalace/mcp_server/_session.py:681) scores every lesson. The failed-command families (C1 to C14)
// cover the cases the plan names: one command with one message several times (C1); one command with two different
// messages (C2, C3); two different commands with the same message (C4); no output at all (C5); killed by a signal
// (C6); a timeout (C7); a command that could not be started (C8); a message only in the ordinary output (C9, C13). The
// other families (N1 to N15) keep the first run's groups that fit.
import { shellText } from "../../src/tools/shell.ts";
import { MARKERS } from "./lesson-query.mjs";

export { MARKERS };

const sh = (command, { code = 1, signal = null, stderr = "", stdout = "" }) =>
  ({ tool: "shell", input: { command }, error: shellText({ code, signal, stderr, stdout }) });
const call = (tool, input, error) => ({ tool, input, error });
// src/tools/commands.ts:72-75.
const timeout = (s) => `Stopped: the command did not complete within its ${s}s timeout. A command that starts with ` +
  "sleep is stopped at its timeout, not moved to the background.";
// Node's own text when a command cannot be spawned at all (src/exec/local.ts:101-102), seen in the build folder.
const nul = (shown) => `The argument 'args[2]' must be a string without null bytes. Received '${shown}'`;
const NOT_FOUND = "'jest' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
const vite = (cwd) => "error when starting dev server:\nError: Port 5173 is already in use\n    at Server.onError " +
  `(file:///${cwd}/node_modules/vite/dist/node/chunks/dep-a1.js:123:28)\n`;
const rejected = (remote, branch) => `To ${remote}\n ! [rejected]        ${branch} -> ${branch} (fetch first)\n` +
  `error: failed to push some refs to '${remote}'\nhint: Updates were rejected because the remote contains work that ` +
  "you do not\n";
const traceback = (file, line, mod) => `Traceback (most recent call last):\n  File "${file}", line ${line}, in ` +
  `<module>\n    import ${mod}\nModuleNotFoundError: No module named '${mod}'\n`;
const eresolve = (pkg) => `npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\nnpm error\n` +
  `npm error While resolving: ${pkg}\n`;
const ts2322 = (file, line, col) => `${file}(${line},${col}): error TS2322: Type 'string' is not assignable to type ` +
  `'number'.\n\nFound 1 error in ${file}:${line}\n\n`;

export const FAMILIES = [
  { id: "C1", what: "npm test: jest is not installed", failures: [
    sh("npm test", { stderr: NOT_FOUND, stdout: "\r\n> shop@1.0.0 test\r\n> jest\r\n\r\n" }),
    sh("npm test -- --runInBand", { stderr: NOT_FOUND, stdout: "\r\n> shop@1.0.0 test\r\n> jest --runInBand\r\n" }),
    sh("npm test src/cart", { stderr: NOT_FOUND, stdout: "\r\n> shop@1.0.0 test\r\n> jest src/cart\r\n" }),
    sh("npm  test", { stderr: NOT_FOUND, stdout: "\r\n> blog@0.2.0 test\r\n> jest\r\n" }),
  ], lessons: [
    "npm test failed because jest was not installed in node_modules; running npm install first fixed it. The sign " +
      "is the error stream saying that jest is not recognized or not found.",
    "When the test command cannot find jest, the packages were never installed in this checkout, so install them " +
      "before running the tests again.",
  ] },
  { id: "C2", what: "git push: rejected, the remote has new commits", failures: [
    sh("git push", { stderr: rejected("github.com:acme/shop.git", "main") }),
    sh("git push origin develop", { stderr: rejected("github.com:acme/blog.git", "develop") }),
    sh("git push", { stderr: rejected("gitlab.com:dev/notes.git", "main") }),
    sh("git push -u origin release", { stderr: rejected("github.com:acme/api.git", "release") }),
  ], lessons: [
    "git push was rejected because the remote branch had commits the local one lacked; git pull --rebase and then " +
      "pushing again fixed it. Look for rejected and fetch first in the push output.",
    "A push that is refused because the remote has newer work needs the remote's commits brought in first, never a " +
      "forced push.",
  ] },
  { id: "C3", what: "git push: authentication failed", failures: [
    sh("git push", { code: 128, stderr: "remote: Invalid username or password.\nfatal: Authentication failed for " +
      "'https://github.com/acme/shop.git/'\n" }),
    sh("git push origin main", { code: 128, stderr: "fatal: Authentication failed for " +
      "'https://gitlab.com/dev/notes.git/'\n" }),
    sh("git push", { code: 128, stderr: "remote: Invalid username or password.\nfatal: Authentication failed for " +
      "'https://github.com/acme/blog.git/'\n" }),
    sh("git push --tags", { code: 128, stderr: "remote: Support for password authentication was removed.\nfatal: " +
      "Authentication failed for 'https://github.com/acme/api.git/'\n" }),
  ], lessons: [
    "git push failed because the saved credentials were wrong or had expired; signing in again through the " +
      "credential helper fixed it. The push output says that authentication failed.",
  ] },
  { id: "C4", what: "the dev server's port is taken (two commands, one message)", failures: [
    sh("npm run dev", { stderr: vite("C:/work/blog"), stdout: "\n> blog@0.2.0 dev\n> vite\n\n" }),
    sh("npm run dev -- --host", { stderr: vite("C:/work/blog"), stdout: "\n> blog@0.2.0 dev\n> vite --host\n\n" }),
    sh("vite", { stderr: vite("C:/work/shop") }),
    sh("vite --port 5173", { stderr: vite("D:/repos/site") }),
  ], lessons: [
    "The dev server would not start because another copy of it was still holding its port; stopping the old process " +
      "or choosing another port fixed it. The error says the port is already in use.",
  ] },
  { id: "C5", what: "grep finds nothing (no output at all)", failures: [
    sh("grep -rn TODO src", {}),
    sh("grep -q 'use strict' lib/index.js", {}),
    sh("grep -l deprecated src/*.ts", {}),
    sh("grep -rn console.log app", {}),
  ], lessons: [
    "grep exiting with code 1 and printing nothing only means that no line matched, not that the command broke, so " +
      "treat it as an empty result.",
  ] },
  { id: "C6", what: "a long node script killed by a signal (no lesson)", failures: [
    sh("node scripts/seed.js", { code: null, signal: "SIGKILL", stdout: "Seeding 120000 rows...\n" }),
    sh("node scripts/seed.js --all", { code: null, signal: "SIGKILL", stdout: "Seeding 480000 rows...\n" }),
    sh("node --max-old-space-size=512 scripts/import.js", { code: null, signal: "SIGKILL",
      stdout: "Importing data/export.csv\n" }),
    sh("node scripts/seed.js --fresh", { code: null, signal: "SIGTERM" }),
  ], lessons: [] },
  { id: "C7", what: "a command that starts with sleep, stopped at its timeout", failures: [
    call("shell", { command: "sleep 45", timeout: 30000 }, timeout(30)),
    call("shell", { command: "sleep 120 && curl http://localhost:3000/health", timeout: 60000 }, timeout(60)),
    call("shell", { command: "sleep 10; npm run check", timeout: 5000 }, timeout(5)),
    call("shell", { command: "sleep 200", timeout: 120000 }, timeout(120)),
  ], lessons: [
    "A command that begins with sleep is stopped at its timeout instead of moving to the background; using a shorter " +
      "wait, or starting the job in the background and reading it with shell_output, fixed it.",
  ] },
  { id: "C8", what: "a command that could not be started (a NUL character)", failures: [
    call("shell", { command: "echo a\u0000b" }, nul("echo a\\x00b")),
    call("shell", { command: "git commit -m \"fix\u0000\"" }, nul("git commit -m \"fix\\x00\"")),
    call("shell", { command: "cat notes\u0000.txt" }, nul("cat notes\\x00.txt")),
    call("shell", { command: "npm run build\u0000" }, nul("npm run build\\x00")),
  ], lessons: [
    "The command could not be started at all because it held a NUL character, which no shell accepts; removing the " +
      "stray character from the command fixed it.",
  ] },
  { id: "C9", what: "tsc: a type error, printed on the ordinary output only", failures: [
    sh("tsc -p tsconfig.json", { code: 2, stdout: ts2322("src/cart.ts", 12, 7) }),
    sh("tsc --noEmit", { code: 2, stdout: ts2322("src/checkout.tsx", 48, 15) }),
    sh("tsc -b", { code: 2, stdout: ts2322("lib/util/strings.ts", 3, 1) }),
    sh("tsc -p tsconfig.build.json", { code: 2, stdout: ts2322("app/models/user.ts", 90, 22) }),
  ], lessons: [
    "tsc failed with TS2322 because a string was passed where a number was expected; converting the value with " +
      "Number() before the call fixed it. tsc prints these on its ordinary output, not on its error stream.",
  ] },
  { id: "C10", what: "npm install: the dependency tree cannot be resolved", failures: [
    sh("npm install", { stderr: eresolve("shop@1.0.0") }),
    sh("npm install react@19", { stderr: eresolve("blog@0.2.0") }),
    sh("npm i", { stderr: eresolve("api@3.1.4") }),
    sh("npm install --save-dev eslint@9", { stderr: eresolve("site@0.0.1") }),
  ], lessons: [
    "npm install failed with ERESOLVE because two packages wanted different versions of one peer dependency; " +
      "installing with --legacy-peer-deps got past it.",
    "When npm cannot resolve the dependency tree, lining up the conflicting versions in package.json is the lasting " +
      "fix. The error stream opens with the code ERESOLVE.",
  ] },
  { id: "C11", what: "docker: Docker Desktop is not running (two wordings)", failures: [
    sh("docker build -t shop .", { stderr: "ERROR: Cannot connect to the Docker daemon at " +
      "unix:///var/run/docker.sock. Is the docker daemon running?\n" }),
    sh("docker compose up -d", { stderr: "error during connect: this error may indicate that the docker daemon is " +
      "not running\n" }),
    sh("docker ps", { stderr: "error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/" +
      "containers/json\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.\n" }),
    sh("docker build .", { stderr: "ERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is " +
      "the docker daemon running?\n" }),
  ], lessons: [
    "docker failed because Docker Desktop was not running, so there was no daemon to connect to; starting Docker " +
      "Desktop and waiting for it fixed it. The sign is a message about connecting to the Docker daemon or its pipe.",
  ] },
  { id: "C12", what: "cargo build: an unknown name in Rust (no lesson)", failures: [
    sh("cargo build", { code: 101, stderr: "error[E0425]: cannot find value `total` in this scope\n --> " +
      "src/main.rs:14:5\n" }),
    sh("cargo build --release", { code: 101, stderr: "error[E0425]: cannot find value `count` in this scope\n --> " +
      "src/lib.rs:88:9\n" }),
    sh("cargo test", { code: 101, stderr: "error[E0425]: cannot find value `rows` in this scope\n --> " +
      "src/db.rs:31:13\n" }),
    sh("cargo run", { code: 101, stderr: "error[E0425]: cannot find value `port` in this scope\n --> " +
      "src/main.rs:7:20\n" }),
  ], lessons: [] },
  { id: "C13", what: "git commit with nothing to commit (ordinary output only; no lesson)", failures: [
    sh("git commit -m \"update\"", { stdout: "On branch main\nnothing to commit, working tree clean\n" }),
    sh("git commit -am wip", { stdout: "On branch develop\nnothing to commit, working tree clean\n" }),
    sh("git commit -m \"fix typo\"", { stdout: "On branch release\nnothing to commit, working tree clean\n" }),
    sh("git commit", { stdout: "On branch feature/cart\nnothing to commit, working tree clean\n" }),
  ], lessons: [] },
  { id: "C14", what: "python: a module is missing", failures: [
    sh("python app.py", { stderr: traceback("C:\\work\\api\\app.py", 3, "requests") }),
    sh("python scripts/fetch.py --all", { stderr: traceback("C:\\work\\api\\scripts\\fetch.py", 1, "requests") }),
    sh("python -m server", { stderr: traceback("/work/server/__main__.py", 5, "fastapi") }),
    sh("python report.py", { stderr: traceback("D:\\repos\\stats\\report.py", 2, "numpy") }),
  ], lessons: [
    "python failed because the requests package was missing from the environment it ran in; activating the " +
      "project's virtual environment before running it fixed it.",
    "A ModuleNotFoundError from python usually means the wrong interpreter ran; installing the package into the " +
      "project's environment with pip fixed it. The last line of the traceback names the missing module.",
  ] },
  { id: "N1", what: "read_file: no such file (the first run's F3)", failures: [
    call("read_file", { path: "src/cart.ts" },
      "ENOENT: no such file or directory, open 'C:\\work\\shop\\src\\cart.ts'"),
    call("read_file", { path: "posts/2026/intro.md" },
      "ENOENT: no such file or directory, open 'C:\\work\\blog\\posts\\2026\\intro.md'"),
    call("read_file", { path: "src/server/index.js" },
      "ENOENT: no such file or directory, open '/work/src/server/index.js'"),
    call("read_file", { path: "config/routes.yaml" },
      "ENOENT: no such file or directory, open 'D:\\repos\\api\\config\\routes.yaml'"),
  ], lessons: [
    "read_file could not find the file because the path was written from the wrong folder; finding it with " +
      "find_files first gave the right path.",
    "When read_file says there is no such file, the name or the folder is wrong, so search for the file by name " +
      "before guessing again.",
  ] },
  { id: "N2", what: "edit_file: old_text not found (the first run's F7)", failures: [
    call("edit_file", { path: "src/cart.ts", old_text: "  12\tconst total = 0;", new_text: "let total = 0;" },
      "old_text was not found in src/cart.ts"),
    call("edit_file", { path: "lib/util/strings.js", old_text: "trim(s)", new_text: "trimEnd(s)" },
      "old_text was not found in lib/util/strings.js"),
    call("edit_file", { path: "docs/guide/setup.md", old_text: "## Install", new_text: "## Setup" },
      "old_text was not found in docs/guide/setup.md"),
    call("edit_file", { path: "app/models/user.rb", old_text: "def name", new_text: "def full_name" },
      "old_text was not found in app/models/user.rb"),
  ], lessons: [
    "edit_file did not find old_text because it still held the line numbers that read_file shows; copying the text " +
      "without them fixed it.",
    "When edit_file cannot find old_text, reading the file again first helps, as it may have changed since it was " +
      "read.",
  ] },
  { id: "N3", what: "edit_file: old_text not found, CRLF file (the first run's F8)", failures: [
    call("edit_file", { path: "src/cart.ts", old_text: "a\nb", new_text: "c" },
      "old_text was not found in src/cart.ts (the file uses CRLF line endings in places)"),
    call("edit_file", { path: "posts/2026/intro.md", old_text: "x\ny", new_text: "z" },
      "old_text was not found in posts/2026/intro.md (the file uses CRLF line endings in places)"),
    call("edit_file", { path: "lib/util/strings.js", old_text: "p\nq", new_text: "r" },
      "old_text was not found in lib/util/strings.js (the file uses CRLF line endings in places)"),
    call("edit_file", { path: "app/models/user.rb", old_text: "m\nn", new_text: "o" },
      "old_text was not found in app/models/user.rb (the file uses CRLF line endings in places)"),
  ], lessons: [
    "edit_file did not find text that spanned lines in a file with Windows line endings; giving a shorter piece " +
      "from within one line fixed it.",
  ] },
  { id: "N4", what: "edit_file: old_text appears several times (the first run's F9)", failures: [
    call("edit_file", { path: "src/cart.ts", old_text: "total", new_text: "sum" },
      "old_text appears 2 times in src/cart.ts; include more surrounding text so it is unique"),
    call("edit_file", { path: "posts/2026/intro.md", old_text: "the", new_text: "a" },
      "old_text appears 12 times in posts/2026/intro.md; include more surrounding text so it is unique"),
    call("edit_file", { path: "lib/util/strings.js", old_text: "return s;", new_text: "return t;" },
      "old_text appears 5 times in lib/util/strings.js; include more surrounding text so it is unique"),
    call("edit_file", { path: "docs/guide/setup.md", old_text: "npm", new_text: "pnpm" },
      "old_text appears 3 times in docs/guide/setup.md; include more surrounding text so it is unique"),
  ], lessons: [
    "edit_file refused because old_text matched in several places; adding the lines around it so that it matched " +
      "once fixed it.",
  ] },
  { id: "N5", what: "edit_file: not UTF-8 text (the first run's F10; no lesson)", failures: [
    call("edit_file", { path: "assets/logo.png", old_text: "a", new_text: "b" },
      "assets/logo.png is not UTF-8 text, so edit_file would damage it"),
    call("edit_file", { path: "data/export.xlsx", old_text: "a", new_text: "b" },
      "data/export.xlsx is not UTF-8 text, so edit_file would damage it"),
    call("edit_file", { path: "bin/tool.exe", old_text: "a", new_text: "b" },
      "bin/tool.exe is not UTF-8 text, so edit_file would damage it"),
    call("edit_file", { path: "docs/old.doc", old_text: "a", new_text: "b" },
      "docs/old.doc is not UTF-8 text, so edit_file would damage it"),
  ], lessons: [] },
  { id: "N6", what: "write_file: not permitted (the first run's F12)", failures: [
    call("write_file", { path: "dist/bundle.js", content: "x" },
      "EPERM: operation not permitted, open 'C:\\work\\shop\\dist\\bundle.js'"),
    call("write_file", { path: "public/feed.xml", content: "x" },
      "EPERM: operation not permitted, open 'C:\\work\\blog\\public\\feed.xml'"),
    call("write_file", { path: "out/report.html", content: "x" },
      "EPERM: operation not permitted, open '/work/out/report.html'"),
    call("write_file", { path: "logs/server.log", content: "x" },
      "EPERM: operation not permitted, open 'D:\\repos\\api\\logs\\server.log'"),
  ], lessons: [
    "write_file was not permitted because the file was read-only or held open by another program; closing that " +
      "program or clearing the read-only flag fixed it.",
  ] },
  { id: "N7", what: "write_file: busy or locked (the first run's F13; no lesson)", failures: [
    call("write_file", { path: "dist/bundle.js", content: "x" },
      "EBUSY: resource busy or locked, open 'C:\\work\\shop\\dist\\bundle.js'"),
    call("write_file", { path: "public/feed.xml", content: "x" },
      "EBUSY: resource busy or locked, open 'C:\\work\\blog\\public\\feed.xml'"),
    call("write_file", { path: "out/report.html", content: "x" },
      "EBUSY: resource busy or locked, open '/work/out/report.html'"),
    call("write_file", { path: "logs/server.log", content: "x" },
      "EBUSY: resource busy or locked, open 'D:\\repos\\api\\logs\\server.log'"),
  ], lessons: [] },
  { id: "N8", what: "read_file: Tachikoma's data folder (the first run's F4)", failures: [
    call("read_file", { path: "C:\\Users\\dev\\AppData\\Local\\tachikoma\\sessions\\a1\\run.jsonl" },
      "C:\\Users\\dev\\AppData\\Local\\tachikoma\\sessions\\a1\\run.jsonl is in Tachikoma's data folder, which the " +
      "file tools never touch"),
    call("read_file", { path: "C:\\Users\\dev\\AppData\\Local\\tachikoma\\errors\\a1.jsonl" },
      "C:\\Users\\dev\\AppData\\Local\\tachikoma\\errors\\a1.jsonl is in Tachikoma's data folder, which the file " +
      "tools never touch"),
    call("read_file", { path: "C:\\Users\\ana\\AppData\\Local\\tachikoma\\prompts.jsonl" },
      "C:\\Users\\ana\\AppData\\Local\\tachikoma\\prompts.jsonl is in Tachikoma's data folder, which the file tools " +
      "never touch"),
    call("read_file", { path: "/home/dev/.local/share/tachikoma/sessions/b2/c3.jsonl" },
      "/home/dev/.local/share/tachikoma/sessions/b2/c3.jsonl is in Tachikoma's data folder, which the file tools " +
      "never touch"),
  ], lessons: [
    "The file tools never open Tachikoma's own data folder, so reading a session file there fails by design; asking " +
      "the user for what was needed was the way forward.",
  ] },
  { id: "N9", what: "find_files: the folder does not exist (the first run's F15)", failures: [
    call("find_files", { pattern: "*.tsx", path: "src/widgets" },
      "ENOENT: no such file or directory, realpath 'C:\\work\\shop\\src\\widgets'"),
    call("find_files", { pattern: "*.spec.ts", path: "tests/e2e" },
      "ENOENT: no such file or directory, realpath '/work/tests/e2e'"),
    call("find_files", { pattern: "*.go", path: "handlers" },
      "ENOENT: no such file or directory, realpath 'D:\\repos\\api\\handlers'"),
    call("find_files", { pattern: "*.md", path: "drafts" },
      "ENOENT: no such file or directory, realpath 'C:\\work\\blog\\drafts'"),
  ], lessons: [
    "find_files failed because the folder it was given does not exist; listing the parent folder first showed the " +
      "right name.",
  ] },
  { id: "N10", what: "search_files: a flag inside the pattern (the first run's S6 and S7)", failures: [
    call("search_files", { pattern: "(?i)error" }, "(?i)error is not a regular expression: Invalid regular " +
      "expression: /(?i)error/: Invalid group. JavaScript has no flags inside a pattern, such as (?i); search_files " +
      "matches case exactly, so give both cases where it matters, as in [Mm]ax"),
    call("search_files", { pattern: "(?i)warning" }, "(?i)warning is not a regular expression: Invalid regular " +
      "expression: /(?i)warning/: Invalid group. JavaScript has no flags inside a pattern, such as (?i); " +
      "search_files matches case exactly, so give both cases where it matters, as in [Mm]ax"),
    call("search_files", { pattern: "(?i)todo" }, "(?i)todo is not a regular expression: Invalid regular " +
      "expression: /(?i)todo/: Invalid group. JavaScript has no flags inside a pattern, such as (?i); search_files " +
      "matches case exactly, so give both cases where it matters, as in [Mm]ax"),
    call("search_files", { pattern: "(?m)^export" }, "(?m)^export is not a regular expression: Invalid regular " +
      "expression: /(?m)^export/: Invalid group. JavaScript has no flags inside a pattern, such as (?m); " +
      "search_files matches case exactly, so give both cases where it matters, as in [Mm]ax"),
  ], lessons: [
    "search_files takes JavaScript patterns, which have no flags inside them such as (?i); writing both cases, as " +
      "in [Ee]rror, fixed it.",
  ] },
  { id: "N11", what: "read_file: invalid input (the first run's S4 and S5; no lesson)", failures: [
    call("read_file", {}, "Invalid input for read_file: \u2716 Invalid input: expected string, received undefined\n" +
      "  \u2192 at path"),
    call("read_file", { path: 3 }, "Invalid input for read_file: \u2716 Invalid input: expected string, received " +
      "number\n  \u2192 at path"),
    call("read_file", { path: "a.ts", offset: 0 }, "Invalid input for read_file: \u2716 Too small: expected number " +
      "to be >=1\n  \u2192 at offset"),
    call("read_file", { path: "a.ts", limit: 0 }, "Invalid input for read_file: \u2716 Too small: expected number " +
      "to be >=1\n  \u2192 at limit"),
  ], lessons: [] },
  { id: "N12", what: "an MCP server answers with a server error (the first run's F16)", failures: [
    call("mcp__docs__search", { query: "rate limits" }, "https://docs.example.com/mcp answered 500"),
    call("mcp__docs__search", { query: "webhooks" }, "https://docs.example.com/mcp answered 502"),
    call("mcp__docs__search", { query: "auth tokens" }, "https://docs.example.com/mcp answered 503"),
    call("mcp__docs__search", { query: "pagination" }, "https://docs.example.com/mcp answered 504"),
  ], lessons: [
    "The docs server answered with a server error, which passes on its own; waiting a little and calling the search " +
      "again worked.",
  ] },
  { id: "N13", what: "an MCP server has stopped (the first run's S8)", failures: [
    call("mcp__github__create_issue", { title: "Cart total wrong" },
      "The MCP server github has stopped; the user can reconnect it from /mcp."),
    call("mcp__github__create_issue", { title: "Login loops" },
      "The MCP server github has stopped; the user can reconnect it from /mcp."),
    call("mcp__github__create_issue", { title: "Docs typo" },
      "The MCP server github has stopped; the user can reconnect it from /mcp."),
    call("mcp__github__create_issue", { title: "Flaky test" },
      "The MCP server github has stopped; the user can reconnect it from /mcp."),
  ], lessons: [
    "When the github MCP server has stopped, its tools keep failing until the user reconnects it; asking the user " +
      "to reconnect it from the MCP menu was the fix.",
  ] },
  { id: "N14", what: "an MCP server needs sign-in (the first run's S12; no lesson)", failures: [
    call("mcp__github__create_issue", { title: "Cart total wrong" },
      "The MCP server github needs sign-in, which the user does from /mcp."),
    call("mcp__github__list_issues", { state: "open" },
      "The MCP server github needs sign-in, which the user does from /mcp."),
    call("mcp__github__get_repo", { repo: "acme/shop" },
      "The MCP server github needs sign-in, which the user does from /mcp."),
    call("mcp__github__create_issue", { title: "Flaky test" },
      "The MCP server github needs sign-in, which the user does from /mcp."),
  ], lessons: [] },
  { id: "N15", what: "an MCP server's local service is not running (the first run's S13)", failures: [
    call("mcp__local__query", { sql: "select 1" },
      "its new connection failed, so the call was not sent: connect ECONNREFUSED 127.0.0.1:3000"),
    call("mcp__local__query", { sql: "select count(*) from orders" },
      "its new connection failed, so the call was not sent: connect ECONNREFUSED 127.0.0.1:3000"),
    call("mcp__local__schema", {},
      "its new connection failed, so the call was not sent: connect ECONNREFUSED 127.0.0.1:3000"),
    call("mcp__local__query", { sql: "select * from users" },
      "its new connection failed, so the call was not sent: connect ECONNREFUSED 127.0.0.1:3000"),
  ], lessons: [
    "The call failed because the local service behind the MCP tool was not running; starting it and calling again " +
      "fixed it.",
  ] },
];
