// For tests/cli.test.ts: given to the real command with `--import`, before the program, it has the Docker module of the
// build the start runs (sandbox/docker.js) resolve to the stand-in beside it (docker.mjs), so a whole launch runs with
// no Docker reached, no box started and no program planted (docker.ts: tests never write or run a fake docker program).
// That build's memory module (memory/memory.js) resolves to memory.mjs too, which reaches only the stand-ins its test
// names (8d plan, step 27). The build is the one at the address TACHI_TEST_BUILD gives (cleanup plan, step 14d).
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
