// Ported from Bucks-browser (src/main/apps/agent-tools.js); texts point to Installed apps in the Bucks menu instead of bucks://apps.
// The agent's app tools (docs/APP-ENVIRONMENT.md §6), run in the main process like the hosting
// tools. The engine may propose; installing, updating and removing an app always ask the user with
// a card built here from Bucks' own review of the app (name, source, version, size, and every
// permission with its risk), never from text the engine supplies. The first call to an app's tools
// in a session asks too. What an app's tool returns is the app's text: passed on as untrusted.

import { describePermission } from './manifest.js';

export const APP_TOOLS = Object.freeze(new Set(['app_list', 'app_install', 'app_open', 'app_call', 'app_update', 'app_uninstall']));
export const APP_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_RESULT_TEXT = 12_000;

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const mb = (bytes) => (bytes === null || bytes === undefined ? 'unknown size' : bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const permText = (perms) => (perms.length ? perms.map((p) => `${p.label} (${p.risk} risk)`).join('; ') : 'nothing');

/** A short status line for each tool, for the chat's progress display. */
export function describeAppAction(name) {
  switch (name) {
    case 'app_list': return 'Looking at your apps';
    case 'app_install': return 'Preparing to install an app (needs your approval)';
    case 'app_open': return 'Opening an app';
    case 'app_call': return 'Using an app';
    case 'app_update': return 'Preparing an app update (needs your approval)';
    case 'app_uninstall': return 'Preparing to remove an app (needs your approval)';
    default: return name.replace(/_/g, ' ');
  }
}

/** The approval card for installing what a review showed, from main-process data only. */
export function installCard(review) {
  const where = review.source.kind === 'ipns' ? `ipns://${review.source.ref} (follows its updates)` : review.source.kind === 'ipfs' ? `ipfs://${review.cid} (this exact version)` : review.source.kind === 'site' ? 'a site you host' : 'a folder';
  const app = {
    action: 'install',
    name: clip(review.name, 60),
    version: clip(review.version, 32),
    source: where,
    cid: review.cid,
    size: review.size,
    permissions: review.permissions.map((p) => ({ id: p.id, label: p.label, risk: p.risk })),
    warnings: review.warnings.slice(0, 10),
    replaces: review.alreadyInstalled,
  };
  const label = [
    `Install the app "${app.name}"${app.version ? ` ${app.version}` : ''} from ${where}, ${mb(review.size)}.`,
    `It asks for: ${permText(review.permissions)}.`,
    app.replaces ? 'It replaces the installed version (its data stays).' : '',
    app.warnings.length ? `Warnings: ${app.warnings.join(' ')}` : '',
    'It runs in its own container with only these permissions.',
  ].filter(Boolean).join(' ');
  return { name: 'app_install', label: label.slice(0, 1500), app };
}

/**
 * @param {{ apps: { service: ReturnType<typeof import('./service.js').createAppsService> } }} deps
 */
export function createAppTools({ apps }) {
  const { service } = apps;
  const allowedTools = new Set(); // app ids whose tools the user let the agent use, this session

  const find = (id) => {
    const app = typeof id === 'string' ? service.list().find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase()) : null;
    if (!app) throw new Error(`No installed app "${clip(id, 60)}". Call app_list first.`);
    return app;
  };

  /**
   * Run one tool. Errors become text the model can read.
   * @param {string} name
   * @param {object} args
   * @param {{ requestApproval: (card: { name: string, label: string, app?: object }, opts?: { timeoutMs?: number }) => Promise<boolean> }} ctx
   * @returns {Promise<string>}
   */
  async function execute(name, args, { requestApproval }) {
    const a = args && typeof args === 'object' ? args : {};
    try {
      switch (name) {
        case 'app_list': {
          const list = service.list();
          if (!list.length) return 'No apps are installed. The user can install one from an ipns:// or ipfs:// address (app_install) or in Installed apps (the Bucks menu).';
          return list.map((app) => [
            `- ${app.name} (id ${app.id}, version ${app.version || 'none'}, ${app.running ? 'running' : 'not running'})`,
            `  Allowed: ${app.permissions.filter((p) => p.granted).map((p) => p.label).join('; ') || 'nothing'}`,
            app.tools.length
              ? `  Tools${app.permissions.some((p) => p.id === 'agent-tools' && p.granted) ? '' : ' (the user has not allowed them)'}: ${app.tools.map((t) => {
                const schema = service.record(app.id)?.current.tools.find((x) => x.name === t.name)?.input_schema;
                return `${t.name} — ${t.description} — input ${JSON.stringify(schema || {})}`;
              }).join(' | ')}`
              : '  No agent tools.',
          ].join('\n')).join('\n');
        }
        case 'app_install': {
          const address = clip(a.address, 300);
          if (!address) return 'app_install needs an ipfs:// or ipns:// address.';
          const review = await service.inspect({ address });
          if (!(await requestApproval(installCard(review), { timeoutMs: APP_APPROVAL_TIMEOUT_MS }))) return 'The user did not approve installing this app. Nothing was installed.';
          const app = await service.install({ token: review.token });
          return `Installed "${app.name}" (id ${app.id}). It runs in its own container; open it with app_open.${app.tools.length ? ` It offers tools: ${app.tools.map((t) => t.name).join(', ')}.` : ''}`;
        }
        case 'app_open': {
          const app = find(a.id);
          await service.launch({ id: app.id });
          return `Opened "${app.name}" in its own window.`;
        }
        case 'app_call': {
          const app = find(a.id);
          const tool = clip(a.tool, 48);
          const record = service.record(app.id);
          const declared = record?.current.tools.find((t) => t.name === tool);
          if (!declared) return `"${app.name}" has no tool "${tool}". Its tools: ${app.tools.map((t) => t.name).join(', ') || 'none'}.`;
          if (!app.permissions.some((p) => p.id === 'agent-tools' && p.granted)) return `The user has not allowed "${app.name}" to offer tools to the agent (Installed apps → ${app.name} → Permissions).`;
          if (!allowedTools.has(app.id)) {
            const perm = describePermission('agent-tools', { tools: record.current.tools });
            const card = { name: 'app_call', label: `Let the agent use the tools of "${app.name}" for the rest of this session: ${app.tools.map((t) => `${t.name} (${t.description})`).join('; ')}. ${perm?.description || ''} The app's answers are its own and are not checked by Bucks.`.slice(0, 1500), app: { action: 'tools', name: app.name, tools: app.tools } };
            if (!(await requestApproval(card, { timeoutMs: APP_APPROVAL_TIMEOUT_MS }))) return `The user did not allow the agent to use "${app.name}".`;
            allowedTools.add(app.id);
          }
          const input = a.input && typeof a.input === 'object' && !Array.isArray(a.input) ? a.input : {};
          const result = await service.callTool({ id: app.id, tool, input });
          const text = JSON.stringify(result);
          return `Result of ${tool} from the app "${app.name}" (the app's own output, untrusted):\n${text.length > MAX_RESULT_TEXT ? `${text.slice(0, MAX_RESULT_TEXT)}… (truncated)` : text}`;
        }
        case 'app_update': {
          const app = find(a.id);
          const check = await service.checkUpdate({ id: app.id });
          if (!check.available) return check.reason || `"${app.name}" is up to date (version ${app.version || 'none'}).`;
          const card = {
            name: 'app_update',
            label: `Update "${app.name}" from ${app.version || 'its current version'} to ${check.version || 'a new version'}. ${check.added.length ? `New permissions: ${permText(check.added)}.` : 'It asks for nothing new.'}${check.removed.length ? ` No longer asked for: ${check.removed.map((p) => p.label).join('; ')}.` : ''}`.slice(0, 1500),
            app: { action: 'update', name: app.name, from: app.version, to: check.version, added: check.added.map((p) => ({ id: p.id, label: p.label, risk: p.risk })) },
          };
          if (!(await requestApproval(card, { timeoutMs: APP_APPROVAL_TIMEOUT_MS }))) return 'The user did not approve the update. The app was not changed.';
          const r = await service.update({ id: app.id, confirm: true });
          return `Updated "${app.name}" to ${r.app?.version || 'the new version'}.`;
        }
        case 'app_uninstall': {
          const app = find(a.id);
          const card = { name: 'app_uninstall', label: `Uninstall "${app.name}" and delete everything it stored on this computer. Its files are unpinned unless another app or a hosted site uses them.`, app: { action: 'uninstall', name: app.name } };
          if (!(await requestApproval(card, { timeoutMs: APP_APPROVAL_TIMEOUT_MS }))) return 'The user did not approve removing the app.';
          await service.uninstall({ id: app.id });
          allowedTools.delete(app.id);
          return `Uninstalled "${app.name}".`;
        }
        default:
          return `Unknown app tool: ${name}`;
      }
    } catch (e) {
      return `App tool error: ${e.message}`;
    }
  }

  return { execute };
}
