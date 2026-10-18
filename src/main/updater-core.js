// Pure update logic for the in-app updater. No Electron imports, so it runs under plain node.

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Branch names come from git itself, but they are still validated before reaching argv. */
export function isValidBranch(name) {
  return typeof name === 'string' && BRANCH_RE.test(name) && !name.includes('..') && !name.endsWith('/');
}

/** Parses `git rev-list --left-right --count HEAD...origin/<branch>` ("<ahead>\t<behind>"). */
export function parseAheadBehind(stdout) {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(stdout));
  if (!m) throw new Error(`Unexpected git rev-list output: ${JSON.stringify(String(stdout).slice(0, 80))}`);
  return { ahead: Number(m[1]), behind: Number(m[2]) };
}

/** True when `git status --porcelain` output lists any change. */
export function parseDirty(porcelain) {
  return String(porcelain)
    .split('\n')
    .some((line) => line.trim() !== '');
}

/** Decides whether an update may run, given the repository state. */
export function decideInstall({ supported, reason, dirty, ahead, behind }) {
  if (!supported) {
    return { ok: false, updateAvailable: false, reason: reason || 'Updates are only available when Bucks runs from a git checkout.' };
  }
  if (dirty) {
    return { ok: false, updateAvailable: false, reason: 'You have local changes. Commit or stash them, then try again.' };
  }
  if (ahead > 0) {
    return { ok: false, updateAvailable: false, reason: 'You have commits that are not on the remote. Push them, then try again.' };
  }
  if (behind === 0) {
    return { ok: true, updateAvailable: false, reason: 'Already up to date.' };
  }
  return { ok: true, updateAvailable: true, reason: `${behind} new commit${behind === 1 ? '' : 's'} available.` };
}

/**
 * The exact commands the install runs, in order. Arguments are fixed arrays, never shell strings.
 * When this machine needs a different Electron than package.json (macOS 12), the dependency step
 * installs that version directly so the running app's Electron is not swapped twice. That form of
 * `npm install` skips the project's postinstall, so the interface dependencies get their own step.
 * @param {{ branch: string, npmCommand: string, electronOverride?: string | null }} opts
 */
export function installPlan({ branch, npmCommand, electronOverride = null }) {
  if (!isValidBranch(branch)) throw new Error(`Refusing to update: invalid branch name ${JSON.stringify(branch)}`);
  if (electronOverride !== null && !/^\d+$/.test(String(electronOverride))) {
    throw new Error(`Refusing to update: invalid Electron version ${JSON.stringify(electronOverride)}`);
  }
  const pull = { id: 'pull', label: 'Downloading the latest code', cmd: 'git', args: ['pull', '--ff-only', 'origin', branch], timeout: 180_000 };
  const build = { id: 'build', label: 'Building the browser interface', cmd: npmCommand, args: ['run', 'build:ui'], timeout: 600_000 };
  if (!electronOverride) {
    return [
      pull,
      { id: 'deps', label: 'Installing dependencies', cmd: npmCommand, args: ['install', '--no-audit', '--no-fund'], timeout: 900_000 },
      build,
    ];
  }
  return [
    pull,
    {
      id: 'deps',
      label: `Installing dependencies (Electron ${electronOverride} for this macOS version)`,
      cmd: npmCommand,
      args: ['install', '--no-save', '--no-audit', '--no-fund', `electron@${electronOverride}`],
      timeout: 900_000,
    },
    { id: 'ui-deps', label: 'Installing interface dependencies', cmd: npmCommand, args: ['--prefix', 'ui', 'install', '--no-audit', '--no-fund'], timeout: 600_000 },
    build,
  ];
}
