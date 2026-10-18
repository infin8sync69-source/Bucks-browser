import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";

// The chrome is a static SvelteKit SPA. In development scripts/dev.mjs points Electron at
// http://localhost:1420, so the port is fixed and the dev server fails fast if it is taken.
export default defineConfig({
  plugins: [sveltekit(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
