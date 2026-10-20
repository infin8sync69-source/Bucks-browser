// What an installable app is (docs/APP-ENVIRONMENT.md §2): any site package, plus an optional
// "app" section in its bucks-site.json that names the app and lists what it asks for. Pure: parses
// and describes; the apps service decides. No Electron imports.
//
//   { "name": "Notes", "spa": true,
//     "app": { "name": "Notes", "version": "1.2.0", "description": "…", "icon": "icon.png",
//              "permissions": ["network:https://api.example.com", "notifications", "ipfs"],
//              "agent": { "tools": [{ "name": "search_notes", "description": "…", "input_schema": {…} }] },
//              "window": { "width": 1000, "height": 720 } } }

import { isSafeRelativePath } from '../sites/package.js';

export const APP_ID = /^a_[a-f0-9]{10}$/;
export const MAX_PERMISSIONS = 32;
export const MAX_NETWORK_ORIGINS = 20;
export const MAX_TOOLS = 16;
export const MAX_SCHEMA_BYTES = 8 * 1024;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 300;
const ICON_EXT = /\.(png|svg|webp|jpe?g|ico)$/i;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * What an app may ask for. `electron` lists the Chromium permission names a grant opens; the
 * others are Bucks capabilities enforced by the container (network, ipfs, agent tools).
 */
export const PERMISSIONS = Object.freeze({
  notifications: { label: 'Show notifications', description: 'Desktop notifications, while the app is open.', risk: 'low', icon: 'bell', electron: ['notifications'] },
  'clipboard-read': { label: 'Read your clipboard', description: 'Whatever you last copied, in any app.', risk: 'high', icon: 'clipboard', electron: ['clipboard-read'] },
  geolocation: { label: 'Know your location', description: 'Your approximate position.', risk: 'high', icon: 'location', electron: ['geolocation'] },
  camera: { label: 'Use your camera', description: 'Video from your camera while the app is open.', risk: 'high', icon: 'camera', electron: [] },
  microphone: { label: 'Use your microphone', description: 'Audio from your microphone while the app is open.', risk: 'high', icon: 'mic', electron: [] },
  ipfs: { label: 'Use your IPFS node', description: 'Read ipfs:// content and add files to your node (they are pinned and may be shared with the network).', risk: 'medium', icon: 'drive', electron: [] },
  'agent-tools': { label: 'Offer tools to your agent', description: 'Your agent may call this app\'s tools; you are asked the first time in each session.', risk: 'medium', icon: 'bot', electron: [] },
});

/** Requests that need no permission in a container: always allowed, so dropped from the list. */
const ALWAYS = new Set(['fullscreen', 'clipboard-write', 'pointer-lock']);

/**
 * Normalise a network permission's origin. Only https:// and wss:// (and http://localhost for
 * development), no path, optional "*." for subdomains of a registrable-looking domain.
 * @returns {string|null} e.g. "https://api.example.com" or "https://*.example.com"
 */
export function normalizeNetworkOrigin(spec) {
  const m = /^(https|wss|http):\/\/(\*\.)?([a-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(String(spec || '').trim());
  if (!m) return null;
  const [, scheme, wildcard, hostRaw, port] = m;
  const host = hostRaw.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return null;
  const local = host === 'localhost' || host === '127.0.0.1';
  if (scheme.toLowerCase() === 'http' && !local) return null;
  if (wildcard && (local || host.split('.').length < 2)) return null;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  return `${scheme.toLowerCase()}://${wildcard ? '*.' : ''}${host}${port ? `:${port}` : ''}`;
}

/** Describe one permission id for people (consent dialogs, approval cards). Unknown ids → null. */
export function describePermission(id, { tools = [] } = {}) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('network:')) {
    const origin = id.slice('network:'.length);
    const wild = origin.includes('://*.');
    const host = origin.replace(/^[a-z]+:\/\/(\*\.)?/, '');
    const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
    return {
      id,
      label: wild ? `Connect to ${host} and its subdomains` : `Connect to ${host}`,
      description: local
        ? `The app can talk to a service running on this computer (${origin}). Allow this only for an app you are developing.`
        : `The app can send and receive data with ${origin.replace('*.', 'any subdomain of ')}. Every other address on the internet stays blocked.`,
      risk: local ? 'high' : 'medium',
      icon: 'wifi',
    };
  }
  const p = PERMISSIONS[id];
  if (!p) return null;
  const description = id === 'agent-tools' && tools.length
    ? `${p.description} Tools: ${tools.map((t) => t.name).join(', ')}.`
    : p.description;
  return { id, label: p.label, description, risk: p.risk, icon: p.icon };
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

/** One agent tool declared by an app, or null with the reason in `warnings`. */
function cleanTool(t, warnings) {
  if (!t || typeof t !== 'object' || !TOOL_NAME.test(t.name)) {
    warnings.push('An agent tool without a valid name (lowercase letters, digits and _) was ignored.');
    return null;
  }
  const schema = t.input_schema && typeof t.input_schema === 'object' && !Array.isArray(t.input_schema) ? t.input_schema : { type: 'object', properties: {} };
  if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) {
    warnings.push(`The agent tool "${t.name}" has an input schema over ${MAX_SCHEMA_BYTES / 1024} KB and was ignored.`);
    return null;
  }
  return { name: t.name, description: cleanText(t.description, MAX_DESCRIPTION) || t.name.replace(/_/g, ' '), input_schema: schema };
}

/**
 * The app described by a package's bucks-site.json (or its absence).
 * @param {string|null} manifestText bucks-site.json, or null when the package has none
 * @param {{ fallbackName?: string }} [opts]
 * @returns {{ name: string, version: string, description: string, icon: string|null,
 *   permissions: string[], tools: { name: string, description: string, input_schema: object }[],
 *   window: { width: number, height: number }, warnings: string[] }}
 */
export function parseAppManifest(manifestText, { fallbackName = 'App' } = {}) {
  const warnings = [];
  let doc = {};
  if (manifestText !== null && manifestText !== undefined) {
    try {
      doc = JSON.parse(manifestText);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object');
    } catch (e) {
      warnings.push(`bucks-site.json could not be read (${e.message}); the app gets no permissions.`);
      doc = {};
    }
  }
  const app = doc.app && typeof doc.app === 'object' && !Array.isArray(doc.app) ? doc.app : {};
  const name = cleanText(app.name, MAX_NAME) || cleanText(doc.name, MAX_NAME) || cleanText(fallbackName, MAX_NAME) || 'App';
  const version = /^[0-9A-Za-z.+-]{1,32}$/.test(String(app.version || '')) ? String(app.version) : '';
  let icon = null;
  if (app.icon !== undefined) {
    if (typeof app.icon === 'string' && isSafeRelativePath(app.icon.replace(/^\/+/, '')) && ICON_EXT.test(app.icon)) icon = app.icon.replace(/^\/+/, '');
    else warnings.push('The app icon must be a png, svg, webp, jpg or ico file inside the package; it was ignored.');
  }

  const permissions = [];
  const seen = new Set();
  let networks = 0;
  for (const raw of Array.isArray(app.permissions) ? app.permissions : []) {
    if (typeof raw !== 'string') continue;
    let id = raw.trim();
    if (ALWAYS.has(id)) continue;
    if (id.startsWith('network:')) {
      const origin = normalizeNetworkOrigin(id.slice('network:'.length));
      if (!origin) { warnings.push(`"${raw.slice(0, 100)}" is not a usable network permission (https:// origin, no path); it was ignored.`); continue; }
      if (networks >= MAX_NETWORK_ORIGINS) { warnings.push(`Only ${MAX_NETWORK_ORIGINS} network permissions are allowed; the rest were ignored.`); continue; }
      id = `network:${origin}`;
      networks += 1;
    } else if (!PERMISSIONS[id] || id === 'agent-tools') {
      warnings.push(`"${raw.slice(0, 60)}" is not a permission this version of Bucks knows; it was ignored.`);
      continue;
    }
    if (seen.has(id)) continue;
    if (permissions.length >= MAX_PERMISSIONS) { warnings.push(`Only ${MAX_PERMISSIONS} permissions are allowed; the rest were ignored.`); break; }
    seen.add(id);
    permissions.push(id);
  }

  const tools = [];
  const declared = app.agent && typeof app.agent === 'object' && Array.isArray(app.agent.tools) ? app.agent.tools : [];
  for (const t of declared) {
    if (tools.length >= MAX_TOOLS) { warnings.push(`Only ${MAX_TOOLS} agent tools are allowed; the rest were ignored.`); break; }
    const tool = cleanTool(t, warnings);
    if (tool && !tools.some((x) => x.name === tool.name)) tools.push(tool);
  }
  if (tools.length) permissions.push('agent-tools'); // implied by declaring tools; shown and revocable like the others

  const win = app.window && typeof app.window === 'object' ? app.window : {};
  const dim = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  return {
    name,
    version,
    description: cleanText(app.description, MAX_DESCRIPTION),
    icon,
    permissions,
    tools,
    window: { width: dim(win.width, 1100, 360, 3840), height: dim(win.height, 760, 320, 2160) },
    warnings,
  };
}

/** Which permissions a new version adds and drops. */
export function permissionDiff(before = [], after = []) {
  const a = new Set(before);
  const b = new Set(after);
  return { added: after.filter((p) => !a.has(p)), removed: before.filter((p) => !b.has(p)) };
}

/** The granted network origins of an app, as matchers. */
export function networkMatchers(granted = []) {
  return granted.filter((p) => p.startsWith('network:')).map((p) => {
    const u = /^([a-z]+):\/\/(\*\.)?([^:/]+)(?::(\d+))?$/.exec(p.slice('network:'.length));
    if (!u) return null;
    return { scheme: u[1], wildcard: Boolean(u[2]), host: u[3], port: u[4] || '' };
  }).filter(Boolean);
}
