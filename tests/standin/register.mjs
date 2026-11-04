// For tests/cli.test.ts: given to the real command with `--import`, after tsx's loader, it has the command's Docker
// (src/sandbox/docker.ts) resolve to the stand-in beside it (docker.mjs), so a whole launch runs with no Docker reached,
// no box started and no program planted (docker.ts: tests never write or run a fake docker program).
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
