// For tests/cli.test.ts: given to the real command with `--import`, as register.mjs is, it writes the URL of every module
// the start resolves, one a line, to the file TACHI_TEST_LOADED names, so a case can see what a start loads (cleanup
// plan, step 14a). It needs no tsx: the same hook records a start from source or from the build. Imported with
// `--import`, it installs itself as the hook; installed, it records. The file is opened once and each line written as it
// comes, so a start that ends with process.exit has written them all.
import { openSync, writeSync } from "node:fs";
import { register } from "node:module";

const HOOK = "?hook";

if (new URL(import.meta.url).search !== HOOK) register(`${import.meta.url}${HOOK}`);

let fd;

export async function resolve(specifier, context, nextResolve) {
  const got = await nextResolve(specifier, context);
  const file = process.env.TACHI_TEST_LOADED;
  if (file) {
    fd ??= openSync(file, "a");
    writeSync(fd, `${got.url}\n`);
  }
  return got;
}
