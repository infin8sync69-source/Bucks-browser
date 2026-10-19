// Network security for web-content sessions: HTTPS-only upgrades, ad/tracker blocking,
// third-party cookie blocking and permission gating. Registers bucks:security:stats.

import * as electron from 'electron';
import { createLogger } from '../log.js';
import { createFilterController } from './filter.js';
import { installPermissions, allowPermission, revokePermission, listPermissions } from './permissions.js';

const log = createLogger('security');

/**
 * Install the security layer on every given session and react live to settings changes.
 *
 * @param {object} opts
 * @param {import('electron').Session[]} opts.sessions web-content sessions (NOT the chrome's)
 * @param {{ get(): object, onChange(cb: (s: object) => void): () => void }} opts.settings
 * @param {string} opts.userData directory for the ad-block engine cache
 * @param {typeof fetch} [opts.fetchImpl] used to download the filter lists (defaults to Electron's net.fetch)
 * @param {() => Array<string|null>} [opts.nodeUrls] the IPFS node's API and gateway URLs, which web pages may not call
 * @returns {{
 *   stats(): { blockedRequests: number, httpsUpgrades: number, adBlockReady: boolean },
 *   allowHttpHost(host: string): void,
 *   isHttpAllowed(host: string): boolean,
 *   allowPermission(origin: string, permission: string): void,
 *   revokePermission(origin: string, permission: string): void,
 *   listPermissions(): Array<{ origin: string, permissions: string[] }>,
 *   dispose(): void,
 * }}
 */
export function installSecurity({ sessions, settings, userData, fetchImpl, nodeUrls }) {
  const net = electron.net;
  const fetcher = fetchImpl || (net?.fetch ? (...args) => net.fetch(...args) : globalThis.fetch);
  const filter = createFilterController({ settings: settings.get(), userData, fetchImpl: fetcher, nodeUrls });
  const defaultSession = electron.session?.defaultSession;

  for (const ses of sessions) {
    filter.attach(ses);
    installPermissions(ses, { isDefaultSession: ses === defaultSession });
  }

  const unsubscribe = settings.onChange((next) => {
    filter.applySettings(next);
    log.info(`Settings applied: httpsOnly=${next?.security?.httpsOnly}, adBlock=${next?.security?.adBlock}, trackerBlock=${next?.security?.trackerBlock}, blockThirdPartyCookies=${next?.security?.blockThirdPartyCookies}`);
  });

  electron.ipcMain.removeHandler?.('bucks:security:stats');
  electron.ipcMain.handle('bucks:security:stats', () => filter.stats());

  log.info(`Security installed on ${sessions.length} session(s)`);

  return {
    stats: () => filter.stats(),
    /** Called by the tab manager when an https upgrade failed, so the host may load over http. */
    allowHttpHost: (host) => filter.allowHttpHost(host),
    isHttpAllowed: (host) => filter.isHttpAllowed(host),
    allowPermission,
    revokePermission,
    listPermissions,
    dispose() {
      unsubscribe?.();
      filter.dispose();
    },
  };
}
