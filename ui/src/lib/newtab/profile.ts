/**
 * Your profile: the display name the new-tab greeting and the header avatar use, a short bio, and
 * the contact card you give people (your IPFS peer ID plus your name). Kept on this computer only;
 * profileStore.ts persists it.
 */

export const MAX_NAME = 30;
export const MAX_BIO = 280;

export interface Profile {
    name: string;
    bio: string;
}

export const EMPTY_PROFILE: Profile = { name: '', bio: '' };

/** A profile from untrusted storage. */
export function cleanProfile(raw: unknown): Profile {
    const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
        name: typeof o.name === 'string' ? o.name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME) : '',
        bio: typeof o.bio === 'string' ? o.bio.trim().slice(0, MAX_BIO) : '',
    };
}

/** Why a display name cannot be saved, or '' when it can. */
export function nameError(name: string): string {
    const n = name.trim();
    if (!n) return 'Type a name';
    if (n.length > MAX_NAME) return `At most ${MAX_NAME} characters`;
    return '';
}

/** The avatar letter: the name's first character, upper-cased; "B" (Bucks) without a name. */
export function initial(name: string): string {
    const first = Array.from(name.trim())[0];
    return first ? first.toLocaleUpperCase() : 'B';
}

/** Contact card link, the same format as Bucks Core: bucks://user/<peer ID>?name=<name>. */
export function contactCard(peerId: string, name: string): string {
    return `bucks://user/${peerId}?name=${encodeURIComponent(name.trim() || 'Bucks user')}`;
}

/** Peer ID and name from a contact card; null for anything else. */
export function parseContactCard(text: string): { peerId: string; name: string } | null {
    const m = /^bucks:\/\/user\/([1-9A-HJ-NP-Za-km-z]{20,100}|baf[a-z2-7]{20,100})(?:\?name=([^&#\s]*))?$/.exec(text.trim());
    if (!m) return null;
    let name = '';
    try {
        name = decodeURIComponent(m[2] || '').slice(0, MAX_NAME);
    } catch {
        name = '';
    }
    return { peerId: m[1], name };
}
