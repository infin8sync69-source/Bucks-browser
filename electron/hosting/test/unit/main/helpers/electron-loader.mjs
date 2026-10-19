// Module resolve hook: maps the bare specifier "electron" to the stub above.
// Registered per test file with `register('./helpers/electron-loader.mjs', import.meta.url)`.

const STUB_URL = new URL('./electron-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: STUB_URL, shortCircuit: true };
  return nextResolve(specifier, context);
}
