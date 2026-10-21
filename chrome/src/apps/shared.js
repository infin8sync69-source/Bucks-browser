// @ts-check
// Helpers shared by the Apps screens (bucks://apps). Framework-free: these components run in the
// Svelte chrome today and move unchanged to the framework-free chrome (docs/CONSOLIDATION-PLAN.md).

/** @typedef {import('../../../ui/src/lib/bridge').BucksApi['apps']} AppsApi */
/** @typedef {import('../../../ui/src/lib/bridge').AppSummary} AppSummary */
/** @typedef {import('../../../ui/src/lib/bridge').AppReview} AppReview */
/** @typedef {import('../../../ui/src/lib/bridge').AppPermission} AppPermission */

/** The chrome's apps API (window.bucks.apps); components accept another for tests. @returns {AppsApi} */
export function appsApi() {
  return /** @type {any} */ (globalThis).bucks?.apps;
}

/** Human size: 1.2 MB, 34 KB. @param {number | null | undefined} bytes */
export function size(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'unknown size';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** What a source means to a person. @param {{ kind: string }} source */
export function sourceLabel(source) {
  switch (source.kind) {
    case 'ipns': return { text: 'Follows updates', tone: 'accent' };
    case 'ipfs': return { text: 'Fixed version', tone: 'neutral' };
    case 'folder': return { text: 'From a folder', tone: 'warning' };
    case 'site': return { text: 'Hosted here', tone: 'success' };
    default: return { text: source.kind, tone: 'neutral' };
  }
}

/** The message of an IPC error, without Electron's "Error invoking remote method …" prefix. @param {unknown} e */
export function errorText(e) {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** A short CID for display. @param {string} cid */
export const shortCid = (cid) => (cid.length > 16 ? `${cid.slice(0, 8)}…${cid.slice(-6)}` : cid);
