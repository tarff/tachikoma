// The resolve hook register.mjs installs: src/sandbox/docker.ts, as tsx resolves it for any importer, becomes the
// stand-in, but for the stand-in itself, which takes the real module's other exports.
const STANDIN = new URL("./docker.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const got = await nextResolve(specifier, context);
  const real = new URL(got.url).pathname.endsWith("/src/sandbox/docker.ts");
  return real && context.parentURL !== STANDIN ? { url: STANDIN, format: "module", shortCircuit: true } : got;
}
