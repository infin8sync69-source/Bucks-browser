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

/** Error → human-readable message. */
export function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return typeof e === 'string' ? e : JSON.stringify(e);
}
