// Permission policy for web content.
//
// Default deny. Web pages may use fullscreen, pointer lock, sanitized clipboard writes, background
// sync and media *playback*; everything that touches hardware, location, notifications, the
// clipboard contents or other windows is refused. Camera / microphone capture (permission "media"
// with mediaTypes) and screen capture are denied too. The chrome (bucks://app on the default
// session) is trusted. A small in-memory per-origin allow map is exported for a future
// "site settings" UI via allowPermission().

import { createLogger } from '../log.js';

const log = createLogger('permissions');

/** Permissions every web page may use. */
const ALWAYS_ALLOWED = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'background-sync']);

const CHROME_ORIGIN = /^bucks:\/\/app(\/|$)/i;

/** origin -> Set<permission> granted explicitly (in memory, lost on restart). */
const grants = new Map();

/**
 * Normalise a URL or origin to `scheme://host[:port]`. Works for custom standard schemes
 * (ipfs://<cid>) where `URL.origin` would be "null". Returns '' when it cannot be parsed.
 * @param {string} urlOrOrigin
 * @returns {string}
 */
export function originOf(urlOrOrigin) {
  try {
    const u = new URL(String(urlOrOrigin));
    return u.host ? `${u.protocol}//${u.host}` : '';
  } catch {
    return '';
  }
}

/**
 * Grant `permission` to `origin` for the rest of this run (e.g. after the user clicked "Allow").
 * @param {string} origin an origin or any URL on it
 * @param {string} permission Electron permission name, e.g. 'geolocation'
 */
export function allowPermission(origin, permission) {
  const key = originOf(origin);
  if (!key || typeof permission !== 'string' || !permission) throw new Error('allowPermission needs an origin and a permission name');
  if (!grants.has(key)) grants.set(key, new Set());
  grants.get(key).add(permission);
}

/** Remove a previously granted permission. */
export function revokePermission(origin, permission) {
  const set = grants.get(originOf(origin));
  if (!set) return;
  set.delete(permission);
  if (set.size === 0) grants.delete(originOf(origin));
}

/** Forget every grant. */
export function clearPermissions() {
  grants.clear();
}

/** @returns {Array<{ origin: string, permissions: string[] }>} current grants */
export function listPermissions() {
  return [...grants].map(([origin, set]) => ({ origin, permissions: [...set].sort() }));
}

/**
 * Pure permission decision.
 * @param {object} q
 * @param {string} q.permission Electron permission name
 * @param {string} q.origin requesting origin or URL
 * @param {'request'|'check'} q.kind
 * @param {string[]} [q.mediaTypes] ('request') capture kinds asked for: 'audio' / 'video'
 * @param {string} [q.mediaType] ('check') 'audio' | 'video' | 'unknown'
 * @param {boolean} [q.trustedChrome] true when the session is the chrome's and the origin is bucks://app
 * @returns {boolean}
 */
export function decidePermission({ permission, origin, kind, mediaTypes, mediaType, trustedChrome = false }) {
  if (trustedChrome) return true;
  const key = originOf(origin);
  if (key && grants.get(key)?.has(permission)) return true;
  if (ALWAYS_ALLOWED.has(permission)) return true;
  if (permission === 'media') {
    // getUserMedia asks for 'audio' and/or 'video' capture: refuse. Anything else (no capture
    // requested, device-agnostic checks) is playback-related and allowed.
    if (kind === 'request') return !Array.isArray(mediaTypes) || mediaTypes.length === 0;
    return mediaType !== 'audio' && mediaType !== 'video';
  }
  return false;
}

/**
 * Install the permission handlers on a session.
 * @param {import('electron').Session} ses
 * @param {{ isDefaultSession?: boolean }} [opts] chrome trust only applies to the default session
 */
export function installPermissions(ses, { isDefaultSession = false } = {}) {
  const trusted = (origin) => isDefaultSession && CHROME_ORIGIN.test(String(origin || ''));

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    let url = details?.requestingUrl || '';
    if (!url) {
      try { url = webContents?.getURL?.() || ''; } catch { /* destroyed */ }
    }
    const allowed = decidePermission({
      permission,
      origin: url,
      kind: 'request',
      mediaTypes: details?.mediaTypes,
      trustedChrome: trusted(url),
    });
    if (!allowed) log.debug(`denied ${permission} for ${url.slice(0, 120)}`);
    callback(allowed);
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const origin = requestingOrigin || details?.requestingUrl || '';
    return decidePermission({
      permission,
      origin,
      kind: 'check',
      mediaType: details?.mediaType,
      trustedChrome: trusted(origin) || trusted(details?.requestingUrl),
    });
  });

  // WebHID / WebUSB / Web Serial device pickers: never grant device access to web content.
  ses.setDevicePermissionHandler(() => false);
  ses.setBluetoothPairingHandler?.((_details, callback) => callback({ confirmed: false }));

  // getDisplayMedia(): no screen or window capture for web content.
  if (!isDefaultSession) {
    ses.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  }
}
