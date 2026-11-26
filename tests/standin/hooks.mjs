// The resolve hook register.mjs installs: the Docker module of the build TACHI_TEST_BUILD gives the address of (the
// test run's own, tests/cli.test.ts; cleanup plan, step 14d), as any importer resolves it, becomes the stand-in, but for
// the stand-in itself, which takes the real module's other exports from that same build. So does that build's memory
// module (memory.mjs; 8d plan, step 27). A module at any other address is left as it is.
const STANDIN = new URL("./docker.mjs", import.meta.url).href;
const MEMORY = new URL("./memory.mjs", import.meta.url).href;
const BUILT_DOCKER = new URL("sandbox/docker.js", process.env.TACHI_TEST_BUILD).href;
const BUILT_MEMORY = new URL("memory/memory.js", process.env.TACHI_TEST_BUILD).href;

export async function resolve(specifier, context, nextResolve) {
  const got = await nextResolve(specifier, context);
  if (got.url === BUILT_MEMORY && context.parentURL !== MEMORY) {
    return { url: MEMORY, format: "module", shortCircuit: true };
  }
  return got.url === BUILT_DOCKER && context.parentURL !== STANDIN ? { url: STANDIN, format: "module", shortCircuit: true } : got;
}
