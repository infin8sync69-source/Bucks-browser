/**
 * Persisted state of the new-tab page: the widget board and your profile. Both live in the chrome's
 * localStorage (this computer only) and are re-read when another window of the chrome changes them.
 */
import { writable, type Writable } from 'svelte/store';
import {
    sanitizeBoard,
    addWidget,
    removeWidget,
    moveWidget,
    updateConfig,
    type Board,
    type WidgetConfig,
    type WidgetType,
} from './board';
import { cleanProfile, EMPTY_PROFILE, type Profile } from './profile';

const BOARD_KEY = 'bucks_widgets_v1';
const PROFILE_KEY = 'bucks_profile_v1';

function read<T>(key: string, clean: (raw: unknown) => T, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw ? clean(JSON.parse(raw)) : fallback;
    } catch {
        return fallback;
    }
}

function persisted<T>(key: string, clean: (raw: unknown) => T, fallback: T): Writable<T> {
    const store = writable<T>(read(key, clean, fallback));
    store.subscribe((v) => {
        try {
            localStorage.setItem(key, JSON.stringify(v));
        } catch {
            /* storage unavailable: keep working in memory */
        }
    });
    if (typeof window !== 'undefined') {
        window.addEventListener('storage', (e) => {
            if (e.key === key) store.set(read(key, clean, fallback));
        });
    }
    return store;
}

function createBoardStore() {
    const store = persisted<Board>(BOARD_KEY, sanitizeBoard, sanitizeBoard(undefined));
    return {
        subscribe: store.subscribe,
        add: (type: WidgetType) => store.update((b) => addWidget(b, type)),
        remove: (uid: string) => store.update((b) => removeWidget(b, uid)),
        move: (uid: string, to: number) => store.update((b) => moveWidget(b, uid, to)),
        configure: (uid: string, patch: WidgetConfig) => store.update((b) => updateConfig(b, uid, patch)),
        reset: () => store.set(sanitizeBoard(undefined)),
    };
}

function createProfileStore() {
    const store = persisted<Profile>(PROFILE_KEY, cleanProfile, { ...EMPTY_PROFILE });
    return {
        subscribe: store.subscribe,
        save: (patch: Partial<Profile>) => store.update((p) => cleanProfile({ ...p, ...patch })),
    };
}

export const boardStore = createBoardStore();
export const profileStore = createProfileStore();
