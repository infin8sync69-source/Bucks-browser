// apps.json: the apps installed in this browser (docs/APP-ENVIRONMENT.md §3), kept by the shared
// record store (atomic, schema-versioned, re-read on outside changes). This module validates the
// records. No Electron imports.

import { createRecordStore } from '../lib/record-store.js';
import { APP_ID, PERMISSIONS, normalizeNetworkOrigin } from './manifest.js';

export const APPS_STORE_VERSION = 1;
const MAX_APPS = 200;
const MAX_HISTORY = 3;
const SOURCE_KINDS = new Set(['ipfs', 'ipns', 'folder', 'site']);
const CID_RE = /^[a-z0-9]{20,120}$/i;

const str = (v, max = 1024) => (typeof v === 'string' && v.length <= max ? v : null);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/** A permission id this Bucks understands, normalised; null otherwise. */
export function cleanPermission(p) {
  if (typeof p !== 'string') return null;
  if (p.startsWith('network:')) {
    const origin = normalizeNetworkOrigin(p.slice('network:'.length));
    return origin ? `network:${origin}` : null;
  }
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, p) ? p : null;
}

const cleanPermissions = (list) => [...new Set((Array.isArray(list) ? list : []).map(cleanPermission).filter(Boolean))].slice(0, 40);

function cleanTools(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t && typeof t.name === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(t.name)).slice(0, 16).map((t) => ({
    name: t.name,
    description: str(t.description, 300) || t.name,
    input_schema: t.input_schema && typeof t.input_schema === 'object' && !Array.isArray(t.input_schema) ? t.input_schema : { type: 'object', properties: {} },
  }));
}

function cleanVersion(v) {
  if (!v || typeof v !== 'object' || !CID_RE.test(String(v.cid))) return null;
  return {
    cid: v.cid,
    version: str(v.version, 32) || '',
    installedAt: iso(v.installedAt),
    permissions: cleanPermissions(v.permissions),
    tools: cleanTools(v.tools),
  };
}

function cleanSource(s) {
  if (!s || typeof s !== 'object' || !SOURCE_KINDS.has(s.kind)) return null;
  const ref = str(s.ref, 4096);
  if (!ref) return null;
  if (s.kind === 'ipfs' && !CID_RE.test(ref)) return null;
  if (s.kind === 'ipns' && !/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(ref)) return null;
  if (s.kind === 'site' && !/^s_[a-f0-9]{8,32}$/.test(ref)) return null;
  return { kind: s.kind, ref, name: s.kind === 'site' ? (str(s.name, 120) || null) : null };
}

/** Validate one app record; null when it is unusable. Unknown fields are dropped. */
export function sanitizeApp(a) {
  if (!a || typeof a !== 'object' || !APP_ID.test(a.id)) return null;
  const current = cleanVersion(a.current);
  const source = cleanSource(a.source);
  if (!current || !source) return null;
  const requested = current.permissions;
  const pending = a.pendingUpdate && typeof a.pendingUpdate === 'object' ? cleanVersion(a.pendingUpdate) : null;
  return {
    id: a.id,
    name: str(a.name, 60) || 'App',
    description: str(a.description, 300) || '',
    source,
    current,
    history: (Array.isArray(a.history) ? a.history : []).map(cleanVersion).filter(Boolean).filter((v) => v.cid !== current.cid).slice(0, MAX_HISTORY),
    // never more than the current version asks for
    granted: cleanPermissions(a.granted).filter((p) => requested.includes(p)),
    window: {
      width: Number.isSafeInteger(a.window?.width) ? Math.min(3840, Math.max(360, a.window.width)) : 1100,
      height: Number.isSafeInteger(a.window?.height) ? Math.min(2160, Math.max(320, a.window.height)) : 760,
    },
    icon: typeof a.icon === 'string' && /^icon\.(png|svg|webp|jpg|jpeg|ico)$/.test(a.icon) ? a.icon : null,
    pendingUpdate: pending && pending.cid !== current.cid ? pending : null,
    installedAt: iso(a.installedAt),
    updatedAt: iso(a.updatedAt),
  };
}

/** @param {{ file: string, log?: { warn: Function, error: Function } }} opts */
export function createAppStore({ file, log }) {
  return createRecordStore({ file, key: 'apps', version: APPS_STORE_VERSION, max: MAX_APPS, what: 'apps', sanitize: sanitizeApp, log });
}
