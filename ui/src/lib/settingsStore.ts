/**
 * Settings mirror: loads `bucks.settings.get()` once, follows `onChange`, and writes patches
 * through `bucks.settings.set()`. Also migrates the pre-Electron localStorage keys.
 */
import { writable, get } from 'svelte/store';
import { bucks, type Settings, type SettingsPatch } from './bridge';
import { buildSearchUrl } from './search';

const LEGACY_SEARCH_KEY = 'bucks_search_engine';
const LEGACY_GATEWAY_KEY = 'bucks_ipfs_gateway';

const LEGACY_GATEWAYS: Record<string, { preferredGateway: 'local' | 'public'; publicGateway?: string }> = {
    local: { preferredGateway: 'local' },
    'ipfs.io': { preferredGateway: 'public', publicGateway: 'https://ipfs.io' },
    cf: { preferredGateway: 'public', publicGateway: 'https://cloudflare-ipfs.com' },
};

function readLegacy(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function removeLegacy(key: string) {
    try {
        localStorage.removeItem(key);
    } catch {
        /* storage unavailable */
    }
}

/** Build the one-time migration patch from the old localStorage keys (null when there is nothing to migrate). */
export function legacyMigrationPatch(): SettingsPatch | null {
    const patch: SettingsPatch = {};
    const engine = readLegacy(LEGACY_SEARCH_KEY);
    if (engine && ['duckduckgo', 'google', 'brave', 'bing'].includes(engine)) {
        patch.searchEngine = engine as Settings['searchEngine'];
    }
    const gateway = readLegacy(LEGACY_GATEWAY_KEY);
    if (gateway && LEGACY_GATEWAYS[gateway]) {
        patch.ipfs = { ...LEGACY_GATEWAYS[gateway] };
    }
    return Object.keys(patch).length > 0 ? patch : null;
}

function createSettingsStore() {
    const store = writable<Settings | null>(null);
    let initialised = false;
    let unsubscribe: (() => void) | null = null;

    async function init() {
        if (initialised) return;
        initialised = true;
        unsubscribe = bucks.settings.onChange((s) => store.set(s));
        try {
            let current = await bucks.settings.get();
            const migration = legacyMigrationPatch();
            if (migration) {
                current = await bucks.settings.set(migration);
            }
            // The legacy keys are deleted even when they held nothing usable.
            removeLegacy(LEGACY_SEARCH_KEY);
            removeLegacy(LEGACY_GATEWAY_KEY);
            store.set(current);
        } catch (e) {
            console.error('[settings] failed to load settings:', e);
        }
    }

    /** Deep-merge a partial patch into the settings (persisted by the main process). */
    async function patch(p: SettingsPatch): Promise<Settings> {
        const next = await bucks.settings.set(p);
        store.set(next);
        return next;
    }

    return {
        subscribe: store.subscribe,
        init,
        patch,
        /** Current snapshot (null until init() resolved). */
        current: () => get(store),
        /** Search URL for `query` using the configured engine. */
        searchUrl: (query: string) => buildSearchUrl(get(store)?.searchEngine, query),
        destroy() {
            unsubscribe?.();
            unsubscribe = null;
            initialised = false;
        },
    };
}

export const settingsStore = createSettingsStore();
