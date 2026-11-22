// The resolve hook register.mjs installs: src/sandbox/docker.ts, as tsx resolves it for any importer, becomes the
// stand-in, but for the stand-in itself, which takes the real module's other exports. So does src/memory/memory.ts
// (memory.mjs; 8d plan, step 27).
const STANDIN = new URL("./docker.mjs", import.meta.url).href;
const MEMORY = new URL("./memory.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const got = await nextResolve(specifier, context);
  const real = new URL(got.url).pathname.endsWith("/src/sandbox/docker.ts");
  if (new URL(got.url).pathname.endsWith("/src/memory/memory.ts") && context.parentURL !== MEMORY) {
    return { url: MEMORY, format: "module", shortCircuit: true };
  }
  return real && context.parentURL !== STANDIN ? { url: STANDIN, format: "module", shortCircuit: true } : got;
}
