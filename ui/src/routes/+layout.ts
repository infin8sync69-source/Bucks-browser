// The chrome is a pure client-side SPA (adapter-static + index.html fallback): there is no
// server to render on, and every page talks to the main process through window.bucks.
export const ssr = false;
export const prerender = false;
