// The Bucks container's rules (docs/APP-ENVIRONMENT.md §4), as pure functions: which requests an
// app may make, which Chromium permissions it gets, where its navigations go. container.js
// installs them on the app's own session. No Electron imports.

import { networkMatchers } from './manifest.js';

export const APP_SCHEME = 'bucks-app';
const ALWAYS_ALLOWED = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);
const DEFAULT_PORT = { http: '80', https: '443', ws: '80', wss: '443' };

/** Does a granted network origin cover this URL? https covers wss on the same host, http covers ws. */
function matches(m, u) {
  const scheme = u.protocol.slice(0, -1);
  const okScheme = m.scheme === scheme || (m.scheme === 'https' && scheme === 'wss') || (m.scheme === 'http' && scheme === 'ws');
  if (!okScheme) return false;
  const port = u.port || '';
  const wanted = m.port || '';
  if (wanted ? port !== wanted && !(port === '' && DEFAULT_PORT[scheme] === wanted) : port !== '' && port !== DEFAULT_PORT[scheme]) return false;
  const host = u.hostname.toLowerCase();
  return m.wildcard ? host.endsWith(`.${m.host}`) : host === m.host;
}

/**
 * May the app with these grants load this URL (any resource type)?
 * @param {string} url
 * @param {{ appId: string, granted: string[], nodeOrigins?: string[] }} ctx nodeOrigins: the local
 *   node's API and gateway (never reachable from an app, whatever it was granted)
 * @returns {boolean}
 */
export function allowRequest(url, { appId, granted = [], nodeOrigins = [] }) {
  let u;
  try { u = new URL(url); } catch { return false; }
  switch (u.protocol) {
    case `${APP_SCHEME}:`: return u.hostname === appId;
    case 'data:': case 'blob:': case 'about:': case 'devtools:': case 'chrome-devtools:': return true;
    case 'ipfs:': case 'ipns:': return granted.includes('ipfs');
    case 'http:': case 'https:': case 'ws:': case 'wss:': {
      const origin = `${u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol}//${u.host}`.toLowerCase();
      if (nodeOrigins.some((o) => typeof o === 'string' && o && origin === new URL(o).origin.toLowerCase())) return false;
      return networkMatchers(granted).some((m) => matches(m, u));
    }
    default: return false;
  }
}

/**
 * Chromium permission decision for an app.
 * @param {{ permission: string, granted: string[], kind?: 'request'|'check', mediaTypes?: string[], mediaType?: string }} q
 */
export function allowPermission({ permission, granted = [], kind = 'request', mediaTypes, mediaType }) {
  if (ALWAYS_ALLOWED.has(permission)) return true;
  switch (permission) {
    case 'notifications': return granted.includes('notifications');
    case 'geolocation': return granted.includes('geolocation');
    case 'clipboard-read': return granted.includes('clipboard-read');
    case 'media': {
      const wants = kind === 'request' ? (Array.isArray(mediaTypes) ? mediaTypes : []) : (mediaType && mediaType !== 'unknown' ? [mediaType] : []);
      return wants.every((t) => (t === 'video' ? granted.includes('camera') : t === 'audio' ? granted.includes('microphone') : false));
    }
    default: return false;
  }
}

/**
 * Where a navigation of the app's window goes: stay in the app, open in a Bucks tab (web and IPFS
 * links), or nowhere.
 * @returns {'stay'|'browser'|'block'}
 */
export function navigationTarget(url, appId) {
  let u;
  try { u = new URL(url); } catch { return 'block'; }
  if (u.protocol === `${APP_SCHEME}:`) return u.hostname === appId ? 'stay' : 'block';
  if (['http:', 'https:', 'ipfs:', 'ipns:'].includes(u.protocol)) return 'browser';
  return 'block';
}

/** The session partition of an app: its storage is its own, and survives updates. */
export const partitionOf = (appId) => `persist:bucks-app-${appId}`;
