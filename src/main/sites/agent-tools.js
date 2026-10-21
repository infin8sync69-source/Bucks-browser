// The Soul Engine's hosting tools, run in the main process (docs/IPFS-HOSTING-IMPLEMENTATION.md §11).
// The engine may propose hosting; it never performs it. site_publish and site_update always ask the
// user with an approval card built here from Bucks' own inspection of the folder (name, folder,
// files, size, warnings, whether a public address is created) — never from text the engine or a
// web page supplies. Folders reach a tool only through the native folder dialog (site_inspect) or
// as the id of a site the user already published.

export const SITE_TOOLS = Object.freeze(new Set(['site_inspect', 'site_publish', 'site_update', 'site_status']));
export const SITE_APPROVAL_TIMEOUT_MS = 120_000; // time to read the card

const mib = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

/** A short status line for each tool, for the chat's progress display. */
export function describeSiteAction(name) {
  switch (name) {
    case 'site_inspect': return 'Asking you to choose a site folder';
    case 'site_publish': return 'Preparing to publish a site (needs your approval)';
    case 'site_update': return 'Preparing a site update (needs your approval)';
    case 'site_status': return 'Checking a hosted site';
    default: return name.replace(/_/g, ' ');
  }
}

function checksText(checks) {
  const lines = checks.filter((c) => !c.resolved || c.level !== 'block').map((c) => `- [${c.level}] ${c.id}: ${c.message}${c.fix ? ` (fix: ${c.fix.action})` : ''}`);
  return lines.length ? lines.join('\n') : '- no problems found';
}

/**
 * The approval card for a publish or an update, from main-process data only.
 * @returns {{ name: string, label: string, site: object }}
 */
export function approvalCard({ action, siteName, inspection, ipns, diff = null, fixes }) {
  const warnings = inspection.checks
    .filter((c) => c.level === 'warn' || (c.level === 'block' && c.resolved))
    .map((c) => c.message);
  const site = {
    action,
    siteName: clip(siteName, 100),
    folder: inspection.folderName,
    files: inspection.files,
    bytes: inspection.bytes,
    warnings,
    createsPublicAddress: action === 'publish' && ipns,
    updatesPublicAddress: action === 'update' && ipns,
    fixes: { useShellAsIndex: Boolean(fixes.useShellAsIndex), enableSpa: Boolean(fixes.enableSpa) },
    ...(diff ? { diff: { ...diff.counts, newBlocks: diff.blocks.new } } : {}),
  };
  const what = action === 'publish'
    ? `Publish the folder "${site.folder}" as the site "${site.siteName}" (name proposed by the assistant): ${site.files} files, ${mib(site.bytes)}. ${ipns ? 'This creates a public, updatable ipns:// address and a permanent ipfs:// link that anyone can open.' : 'This creates a permanent public ipfs:// link that anyone can open.'}`
    : `Update the site "${site.siteName}" from the folder "${site.folder}": ${diff.counts.added} added, ${diff.counts.changed} changed, ${diff.counts.removed} removed (${site.files} files, ${mib(site.bytes)}).${ipns ? ' Visitors of its ipns:// address will see the new version.' : ''}`;
  const fixesText = [site.fixes.useShellAsIndex && '_shell.html will be published as index.html', site.fixes.enableSpa && 'single-page-app mode will be turned on'].filter(Boolean);
  const label = [what, fixesText.length ? `Fixes: ${fixesText.join('; ')}.` : '', warnings.length ? `Warnings: ${warnings.join(' ')}` : ''].filter(Boolean).join(' ');
  return { name: action === 'publish' ? 'site_publish' : 'site_update', label: label.slice(0, 1500), site };
}

/**
 * @param {{ sites: { service: ReturnType<typeof import('./service.js').createSitesService>, chooseFolder: () => Promise<object|null> } }} deps
 */
export function createSiteTools({ sites }) {
  const { service, chooseFolder } = sites;

  /**
   * Run one tool. Errors become text the model can read.
   * @param {string} name
   * @param {object} args
   * @param {{ requestApproval: (card: { name: string, label: string, site: object }, opts?: { timeoutMs?: number }) => Promise<boolean> }} ctx
   * @returns {Promise<string>}
   */
  async function execute(name, args, { requestApproval }) {
    const a = args && typeof args === 'object' ? args : {};
    const fixes = { useShellAsIndex: a.useShellAsIndex === true, enableSpa: a.enableSpa === true };
    try {
      switch (name) {
        case 'site_inspect': {
          const chosen = await chooseFolder();
          if (!chosen) return 'The user closed the folder dialog without choosing a folder.';
          const insp = await service.inspect({ token: chosen.token, ...fixes });
          return [
            `Folder token: ${chosen.token}`,
            `Folder: ${insp.folderName} (${insp.files} files, ${mib(insp.bytes)})${chosen.hints.framework ? `, framework: ${chosen.hints.framework}` : ''}`,
            chosen.hints.note ? `Note: ${chosen.hints.note}` : '',
            `Can be published: ${insp.blocked ? 'no, fix the blocking problems first' : 'yes'}`,
            'Checks:',
            checksText(insp.checks),
            'To publish, call site_publish with this token (the user approves it).',
          ].filter(Boolean).join('\n');
        }
        case 'site_publish': {
          const token = clip(a.token, 64);
          if (!token) return 'site_publish needs the folder token from site_inspect.';
          const insp = await service.inspect({ token, ...fixes });
          if (insp.blocked) return `This folder cannot be published yet:\n${checksText(insp.checks)}`;
          const ipns = a.ipns !== false;
          const siteName = clip(a.name, 100) || insp.folderName;
          const card = approvalCard({ action: 'publish', siteName, inspection: insp, ipns, fixes });
          if (!(await requestApproval(card, { timeoutMs: SITE_APPROVAL_TIMEOUT_MS }))) return 'The user did not approve publishing this site. Nothing was published.';
          const res = await service.publish({ token, name: siteName, ipns, ...fixes });
          return [
            `Published "${siteName}" (site id ${res.id}).`,
            res.urls.ipns ? `Updatable address: ${res.urls.ipns}` : '',
            `Permanent link to this version: ${res.urls.ipfs}`,
            `For people without Bucks (availability not guaranteed): ${res.urls.gatewayIpns || res.urls.gateway}`,
            res.announce.ok ? 'It was announced to the network.' : `It is saved on this computer but not announced yet (${res.announce.error}).`,
            res.ipns ? 'Remind the user to back up the site key (without it the address can never be updated).' : '',
          ].filter(Boolean).join('\n');
        }
        case 'site_update': {
          const id = clip(a.id, 64);
          const site = id ? service.store.get(id) : null;
          if (!site) return 'site_update needs the id of a site the user already published (see site_status).';
          const review = await service.update({ id, ...fixes });
          if (review.unchanged) return `The folder has not changed since the last version of "${site.name}"; nothing to update.`;
          const insp = { checks: review.checks, files: review.files, bytes: review.bytes, folderName: site.sourceDir ? site.sourceDir.split(/[\\/]/).pop() : site.name };
          const card = approvalCard({ action: 'update', siteName: site.name, inspection: insp, ipns: Boolean(site.ipns), diff: review.diff, fixes });
          if (!(await requestApproval(card, { timeoutMs: SITE_APPROVAL_TIMEOUT_MS }))) return 'The user did not approve the update. The site was not changed.';
          const res = await service.update({ id, ...fixes, confirm: true, expectCid: review.cid });
          return `Updated "${site.name}": ${res.diff.counts.added} added, ${res.diff.counts.changed} changed, ${res.diff.counts.removed} removed.\nNew version: ${res.urls.ipfs}${res.urls.ipns ? `\nThe address ${res.urls.ipns} now serves it.` : ''}`;
        }
        case 'site_status': {
          const id = clip(a.id, 64);
          if (!id) {
            const list = service.list();
            if (!list.length) return 'The user has not published any site from this browser yet.';
            return list.map((s) => `- ${s.name} (id ${s.id}): ${s.urls.ipns || s.urls.ipfs}${s.keyBackedUp || !s.ipns ? '' : ' — key not backed up'}`).join('\n');
          }
          const h = await service.status({ id });
          return [`Health: ${h.state || 'not available'} — ${h.label}`, h.failing ? `Not yet: ${h.failing.message}` : '', ...h.checks.map((c) => `- ${c.id}: ${c.ok === null ? 'not tested' : c.ok ? 'ok' : 'failed'} (${c.detail})`)].filter(Boolean).join('\n');
        }
        default:
          return `Unknown site tool: ${name}`;
      }
    } catch (e) {
      return `Site tool error: ${e.message}`;
    }
  }

  return { execute };
}
