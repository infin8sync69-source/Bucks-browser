// Which Electron a machine can run. Pure (no Electron import) so the installer script, the
// in-app updater and the unit tests share one rule.
//
// Electron 44 and later need macOS 13 (Ventura). Electron 43 is the last major that runs on
// macOS 12 (Monterey) and it still receives security fixes until Electron 46 ships. Older macOS
// versions would need an Electron that no longer gets security fixes, so they are refused.
// https://github.com/electron/electron/blob/main/docs/breaking-changes.md

/** Electron major that macOS 12 machines run instead of the version in package.json. */
export const MONTEREY_ELECTRON_MAJOR = '43';

/**
 * Maps a Darwin kernel release (os.release(), e.g. '21.6.0') to the macOS major version.
 * Darwin 20 = macOS 11, 21 = macOS 12, 22 = macOS 13, and so on.
 * @param {string} release
 * @returns {number | null}
 */
export function macosMajorFromDarwin(release) {
  const m = /^(\d+)\./.exec(String(release || ''));
  if (!m) return null;
  const darwin = Number(m[1]);
  return darwin >= 20 ? darwin - 9 : null;
}

/**
 * Decides whether this machine must run a different Electron than package.json asks for.
 * @param {{ platform: string, release: string }} system  process.platform and os.release()
 * @returns {{ override: string | null, macosMajor: number | null, reason: string | null }}
 * @throws {Error} when the OS is too old for any Electron that still gets security fixes
 */
export function electronOverrideFor({ platform, release }) {
  if (platform !== 'darwin') return { override: null, macosMajor: null, reason: null };
  const macosMajor = macosMajorFromDarwin(release);
  if (macosMajor === null || macosMajor < 12) {
    throw new Error(
      'Bucks Browser needs macOS 12 (Monterey) or newer. Older macOS versions can only run Electron ' +
        'releases that no longer get security fixes.',
    );
  }
  if (macosMajor === 12) {
    return {
      override: MONTEREY_ELECTRON_MAJOR,
      macosMajor,
      reason:
        'macOS 12 cannot run Electron 44 or later, so Electron 43 is used instead. Electron 43 gets ' +
        'security fixes only until Electron 46 ships (expected around December 2026). Update to ' +
        'macOS 13 or newer if this Mac supports it.',
    };
  }
  return { override: null, macosMajor, reason: null };
}

/** npm arguments that install the override without touching package.json or package-lock.json. */
export function overrideInstallArgs(override) {
  return ['install', '--no-save', '--no-audit', '--no-fund', `electron@${override}`];
}
