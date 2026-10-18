/** Small formatting helpers shared by the internal pages. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1536 → "1.5 KB". Non-finite or negative input yields "0 B". */
export function formatBytes(bytes: number | null | undefined): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

/** Bytes per second → "12 KB/s". */
export function formatRate(bytesPerSecond: number | null | undefined): string {
    return `${formatBytes(bytesPerSecond)}/s`;
}

/** "bafybeigdyr…xyz4" — keeps both ends of a long identifier. */
export function shortId(id: string, head = 8, tail = 6): string {
    return id.length > head + tail + 2 ? `${id.slice(0, head)}…${id.slice(-tail)}` : id;
}

/**
 * Electron prefixes errors thrown by IPC handlers with
 * "Error invoking remote method 'bucks:…': Error: ". Strip that so the user sees the real reason.
 */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

/** Error → human-readable message (IPC wrapper prefixes removed). */
export function errorMessage(e: unknown): string {
    const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
    return (raw ?? '').replace(IPC_PREFIX, '') || 'Unknown error';
}

/**
 * ms timestamp → "just now", "5 min ago", "3 h ago", "2 days ago", or a date for older times.
 * `now` is injectable so callers can re-render on a shared clock.
 */
export function relativeTime(ts: number | null | undefined, now: number = Date.now()): string {
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 'never';
    const seconds = Math.round((now - ts) / 1000);
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    return new Date(ts).toLocaleDateString();
}

const PLATFORM_LABELS: Record<string, string> = {
    darwin: 'macOS',
    linux: 'Linux',
    win32: 'Windows',
    freebsd: 'FreeBSD',
    openbsd: 'OpenBSD',
    android: 'Android',
    browser: 'Web browser',
};

/** process.platform → "macOS" / "Linux" / "Windows"; unknown values are shown as-is. */
export function platformLabel(platform: string | null | undefined): string {
    if (!platform) return 'Unknown platform';
    return PLATFORM_LABELS[platform] ?? platform;
}
