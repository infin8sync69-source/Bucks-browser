// Remembered window bounds. Pure helpers (no Electron import) so the display-validation
// logic is unit-testable; window.js owns the Electron glue.

import fs from 'node:fs';
import path from 'node:path';

/** Smallest window the chrome layout supports. */
export const MIN_WINDOW_SIZE = Object.freeze({ width: 900, height: 600 });
/** First-run window size. */
export const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 1360, height: 860 });

/** How much of the window's top edge must sit on a display for the saved position to be reused. */
const MIN_VISIBLE_PX = 64;

const isInt = (n) => Number.isInteger(n);

/**
 * Read a previously saved state. Any unreadable / malformed file yields null.
 * @param {string} file
 * @returns {object | null}
 */
export function readWindowState(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist state. Never throws (a failed write only loses the remembered bounds).
 * @param {string} file
 * @param {{ x?: number, y?: number, width: number, height: number, maximized: boolean }} state
 * @returns {boolean} true when written
 */
export function writeWindowState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the top strip of `rect` (what the user grabs to move the window) overlaps one of
 * the displays' work areas by at least MIN_VISIBLE_PX in both directions.
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {Array<{ workArea?: object, bounds?: object }>} displays Electron Display-like objects
 */
export function isOnVisibleDisplay(rect, displays) {
  const strip = { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, MIN_VISIBLE_PX) };
  return (displays || []).some((d) => {
    const area = d.workArea || d.bounds;
    if (!area) return false;
    const w = Math.min(strip.x + strip.width, area.x + area.width) - Math.max(strip.x, area.x);
    const h = Math.min(strip.y + strip.height, area.y + area.height) - Math.max(strip.y, area.y);
    return w >= MIN_VISIBLE_PX && h >= MIN_VISIBLE_PX;
  });
}

/**
 * Turn a saved (possibly stale or corrupt) state into safe BrowserWindow options.
 * Size falls back to defaults when missing or below the minimum; position is only kept when
 * it is on a currently connected display, otherwise it is omitted so Electron centres the window.
 *
 * @param {object | null} saved
 * @param {Array<object>} displays  `screen.getAllDisplays()`
 * @param {{ defaults?: { width: number, height: number }, min?: { width: number, height: number } }} [opts]
 * @returns {{ x?: number, y?: number, width: number, height: number, maximized: boolean }}
 */
export function sanitizeWindowState(saved, displays, { defaults = DEFAULT_WINDOW_SIZE, min = MIN_WINDOW_SIZE } = {}) {
  const out = { width: defaults.width, height: defaults.height, maximized: false };
  if (!saved || typeof saved !== 'object') return out;

  if (isInt(saved.width) && isInt(saved.height) && saved.width >= min.width && saved.height >= min.height) {
    out.width = saved.width;
    out.height = saved.height;
  }

  // Never exceed the largest work area (e.g. a monitor was replaced by a smaller one).
  let maxW = 0;
  let maxH = 0;
  for (const d of displays || []) {
    const area = d.workArea || d.bounds;
    if (!area) continue;
    maxW = Math.max(maxW, area.width);
    maxH = Math.max(maxH, area.height);
  }
  if (maxW && out.width > maxW) out.width = Math.max(min.width, maxW);
  if (maxH && out.height > maxH) out.height = Math.max(min.height, maxH);

  if (isInt(saved.x) && isInt(saved.y) && isOnVisibleDisplay({ x: saved.x, y: saved.y, width: out.width, height: out.height }, displays)) {
    out.x = saved.x;
    out.y = saved.y;
  }
  out.maximized = saved.maximized === true;
  return out;
}
