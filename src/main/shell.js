// bucks:shell:open-external — hand a URL to the OS default handler. Only http(s) and mailto
// are allowed: anything else (file:, javascript:, custom app schemes) is rejected.

import { ipcMain, shell } from 'electron';
import { createLogger } from './log.js';

const log = createLogger('shell');

/** Schemes the OS may be asked to open. */
export const EXTERNAL_SCHEMES = Object.freeze(['http:', 'https:', 'mailto:']);
const MAX_URL_LENGTH = 8 * 1024;

/**
 * Validate a URL for shell.openExternal. Returns the normalised URL string.
 * @param {unknown} url
 * @returns {string}
 * @throws {Error} with a human-readable reason
 */
export function assertExternalUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('A URL is required');
  if (url.length > MAX_URL_LENGTH) throw new Error('URL is too long');
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`Not a valid URL: ${url.slice(0, 120)}`);
  }
  if (!EXTERNAL_SCHEMES.includes(parsed.protocol)) {
    throw new Error(`Refusing to open "${parsed.protocol}" links externally (only http, https and mailto are allowed)`);
  }
  return parsed.href;
}

/**
 * True when the URL may be opened externally.
 * @param {unknown} url
 */
export function isAllowedExternalUrl(url) {
  try {
    assertExternalUrl(url);
    return true;
  } catch {
    return false;
  }
}

/** Registers `bucks:shell:open-external` ({ url }). */
export function registerShellIpc() {
  ipcMain.handle('bucks:shell:open-external', async (_event, payload) => {
    const url = assertExternalUrl(payload?.url);
    log.info('open-external', url);
    await shell.openExternal(url);
  });
}
