// The chrome has no server: adapter-static with an index.html fallback puts SvelteKit in SPA
// mode so the main process can serve ui/build from bucks://app/ with its own SPA fallback.
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    // Content-Security-Policy for the chrome window (see docs/IPC-CONTRACT.md, "Security rules").
    // Scripts only ever come from the chrome's own origin; the only network connections allowed
    // are to the chrome origin and to local services (the Bucks node, Kubo, Ollama).
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:", "https:", "http:", "ipfs:", "ipns:"],
        "connect-src": ["self", "http://127.0.0.1:*", "http://localhost:*"],
        "font-src": ["self", "data:"],
        "object-src": ["none"],
        "base-uri": ["self"],
      },
    },
  },
};

export default config;
