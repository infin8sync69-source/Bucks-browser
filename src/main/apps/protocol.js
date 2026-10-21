// bucks-app://<app id>/… (docs/APP-ENVIRONMENT.md §4.1): an installed app's files, served from its
// pinned version on the local node. One stable origin per app, so its storage survives updates
// (an ipfs:// origin changes with every version). Everything else (site descriptor, SPA fallback,
// type repair, truncation guard, path safety) is the ipfs:// handler's: requests are translated to
// ipfs://<cid>/… and the answer back. Never a public gateway. No Electron imports.

import { renderErrorPage } from '../protocols/ipfs.js';
import { isSafeRequestPath } from '../protocols/site-serving.js';
import { APP_SCHEME } from './policy.js';

function page(html, status, extra = {}) {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      ...extra,
    },
  });
}

/**
 * @param {{ getApp: (id: string) => ({ current: { cid: string }, name: string } | null),
 *   ipfsHandler: (req: Request) => Promise<Response>, kubo: { isReady(): boolean, status(): any, start?(): Promise<any> },
 *   log?: { warn: Function } }} deps
 *   ipfsHandler: an ipfs:// handler that only uses the local node (createIpfsHandler with
 *   preferredGateway forced to local)
 */
export function createAppProtocolHandler({ getApp, ipfsHandler, kubo, log = { warn() {} } }) {
  return async function handleAppRequest(request) {
    let url;
    try { url = new URL(request.url); } catch { return page(renderErrorPage({ title: 'Bad request' }), 400); }
    const id = url.hostname;
    const app = getApp(id);
    if (url.protocol !== `${APP_SCHEME}:` || !app) {
      return page(renderErrorPage({ title: 'App not installed', heading: 'This app is not installed', message: 'Install it again from Apps (bucks://apps).' }), 404);
    }
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return page(renderErrorPage({ title: 'Method not allowed' }), 405, { allow: 'GET, HEAD' });
    if (!isSafeRequestPath(url.pathname)) return page(renderErrorPage({ title: 'Invalid address', heading: 'This address is not valid', message: 'Its path tries to leave the app.' }), 400);

    if (!kubo.isReady()) {
      const st = kubo.status?.() || {};
      if (st.state !== 'initializing' && kubo.start) kubo.start().catch((e) => log.warn(`IPFS start for ${app.name} failed: ${e.message}`));
      return page(renderErrorPage({
        title: `Starting ${app.name}`,
        heading: `Starting ${app.name}…`,
        message: '<span class="spinner"></span>Your IPFS node is starting. The app is kept on this computer and opens as soon as the node is ready.',
        refreshSeconds: 2,
      }), 503, { 'retry-after': '2' });
    }

    const cid = app.current.cid;
    const headers = new Headers();
    for (const h of ['accept', 'range', 'if-none-match', 'if-modified-since']) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    const res = await ipfsHandler(new Request(`ipfs://${cid}${url.pathname}${url.search}`, { method, headers }));
    const out = new Headers(res.headers);
    const loc = out.get('location');
    if (loc) {
      const prefix = `ipfs://${cid}`;
      if (loc.startsWith(prefix)) out.set('location', `${APP_SCHEME}://${id}${loc.slice(prefix.length) || '/'}`);
      else if (/^ipfs:\/\//i.test(loc)) out.delete('location'); // never leave the app's origin by redirect
    }
    // The origin is stable across versions: nothing may be served from Chromium's cache after an
    // update (it reuses custom-scheme subresources without revalidating, see IPNS_CACHE_CONTROL).
    out.set('cache-control', 'no-store');
    out.delete('etag');
    out.delete('x-ipfs-roots');
    out.delete('x-ipfs-path');
    return new Response(method === 'HEAD' ? null : res.body, { status: res.status, statusText: res.statusText, headers: out });
  };
}
