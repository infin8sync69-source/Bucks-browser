'use strict';
// Which key chords typed in page content are browser shortcuts (forwarded to the shell by
// tab-manager) and which belong to the page. Pure, so it is unit-tested.

const SHORTCUT_KEYS = new Set(['t', 'w', 'l', 'r', 'f', 'p', 'j', 'n', '0', '-', '=', '+']);

/**
 * The browser-level chord for a key event from page content, or null when the key belongs to
 * the page. Cmd (macOS) / Ctrl (elsewhere) + a browser key, Cmd/Ctrl+Shift+T / N, F5 and Alt+arrows.
 * @param {{ key: string, control?: boolean, meta?: boolean, shift?: boolean, alt?: boolean }} input
 * @param {string} [platform]
 * @returns {{ key: string, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, altKey: boolean } | null}
 */
function shortcutChord(input, platform = process.platform) {
  const key = String(input.key || '');
  const lower = key.toLowerCase();
  const mod = platform === 'darwin' ? !!input.meta && !input.control : !!input.control && !input.meta;
  const chord = { key, ctrlKey: !!input.control, metaKey: !!input.meta, shiftKey: !!input.shift, altKey: !!input.alt };
  if (key === 'F5' && !input.alt && !input.shift && !input.control && !input.meta) return chord;
  if (input.alt && !input.control && !input.meta && !input.shift && (key === 'ArrowLeft' || key === 'ArrowRight')) return chord;
  if (!mod || input.alt) return null;
  if (input.shift) return lower === 't' || lower === 'n' || key === '+' ? chord : null;
  return SHORTCUT_KEYS.has(lower) ? chord : null;
}

module.exports = { shortcutChord };
