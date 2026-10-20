/**
 * Home Screen Store — Mini-app registry, grid layout, drag state.
 * Persists to localStorage so the home screen survives restarts.
 */
import { writable, get } from 'svelte/store';
import type { Tone } from './tones';

// ── App definition ────────────────────────────────────────────────────────────

export interface MiniApp {
    id: string;
    name: string;
    icon: string;                         // lucide-svelte component name (PascalCase)
    tone: Tone;                           // icon colour (a design-system tone, see tones.ts)
    description: string;
    category: Category;
    href?: string;                        // bucks:// internal route
    action?: string;                      // a2ui action type
    badge?: string;                       // optional notification badge text
    isBuiltIn?: boolean;                  // can't be removed
}

export type Category =
    | 'finance'
    | 'transport'
    | 'web3'
    | 'social'
    | 'tools'
    | 'ai';

export interface GridCell {
    row: number;
    col: number;
    appId: string | null;
}

// ── Full app registry ─────────────────────────────────────────────────────────

export const APP_REGISTRY: MiniApp[] = [
    // Finance
    {
        id: 'wallet',
        name: 'Wallet',
        icon: 'Wallet',
        tone: 'violet',
        description: 'Multi-chain crypto wallet, DID payments',
        category: 'finance',
        href: 'bucks://wallet',
        isBuiltIn: true,
    },
    {
        id: 'pay',
        name: 'Pay',
        icon: 'SendHorizontal',
        tone: 'emerald',
        description: 'Send & receive instantly',
        category: 'finance',
        href: 'bucks://wallet',
    },
    {
        id: 'portfolio',
        name: 'Portfolio',
        icon: 'TrendingUp',
        tone: 'sky',
        description: 'Track your assets & performance',
        category: 'finance',
        href: 'bucks://wallet',
    },
    // Transport
    {
        id: 'taxi',
        name: 'Taxi',
        icon: 'Car',
        tone: 'amber',
        description: 'Book a ride in seconds',
        category: 'transport',
        href: 'bucks://superapp',
    },
    {
        id: 'food',
        name: 'Food',
        icon: 'UtensilsCrossed',
        tone: 'red',
        description: 'Order from nearby restaurants',
        category: 'transport',
        href: 'bucks://superapp',
    },
    {
        id: 'delivery',
        name: 'Delivery',
        icon: 'Package',
        tone: 'violet',
        description: 'Track parcels & shipments',
        category: 'transport',
        href: 'bucks://superapp',
    },
    // Web3
    {
        id: 'ipfs',
        name: 'IPFS',
        icon: 'Globe',
        tone: 'cyan',
        description: 'Decentralised file storage',
        category: 'web3',
        href: 'bucks://ipfs',
        isBuiltIn: true,
    },
    {
        id: 'identity',
        name: 'Identity',
        icon: 'Fingerprint',
        tone: 'violet',
        description: 'DID & self-sovereign identity',
        category: 'web3',
        href: 'bucks://login',
    },
    {
        id: 'nft',
        name: 'NFTs',
        icon: 'Image',
        tone: 'pink',
        description: 'Browse & manage NFT collections',
        category: 'web3',
        href: 'bucks://wallet',
    },
    {
        id: 'dao',
        name: 'DAO',
        icon: 'Vote',
        tone: 'sky',
        description: 'Participate in governance',
        category: 'web3',
        href: 'bucks://implementation',
    },
    // Social
    {
        id: 'profile',
        name: 'Profile',
        icon: 'CircleUser',
        tone: 'indigo',
        description: 'Your decentralised identity',
        category: 'social',
        href: 'bucks://login',
    },
    {
        id: 'messages',
        name: 'Messages',
        icon: 'MessageCircle',
        tone: 'blue',
        description: 'Encrypted peer-to-peer chat',
        category: 'social',
        href: 'bucks://messages',
    },
    {
        id: 'feed',
        name: 'Feed',
        icon: 'Rss',
        tone: 'emerald',
        description: 'Global decentralised feed',
        category: 'social',
        href: 'bucks://feed',
    },
    // Tools
    {
        id: 'settings',
        name: 'Settings',
        icon: 'Settings2',
        tone: 'slate',
        description: 'Browser & agent configuration',
        category: 'tools',
        href: 'bucks://settings',
    },
    {
        id: 'history',
        name: 'History',
        icon: 'History',
        tone: 'slate',
        description: 'Browse your web history',
        category: 'tools',
        href: 'bucks://history',
    },
    {
        id: 'bookmarks',
        name: 'Bookmarks',
        icon: 'Bookmark',
        tone: 'amber',
        description: 'Saved pages & links',
        category: 'tools',
        href: 'bucks://bookmarks',
    },
    {
        id: 'node',
        name: 'Node',
        icon: 'Network',
        tone: 'emerald',
        description: 'Network & implementation status',
        category: 'tools',
        href: 'bucks://implementation',
    },
    // AI
    {
        id: 'agent',
        name: 'Agent',
        icon: 'Bot',
        tone: 'violet',
        description: 'Bucks AI — your intelligent assistant',
        category: 'ai',
        isBuiltIn: true,
        action: 'open_agent',
    },
    {
        id: 'research',
        name: 'Research',
        icon: 'Search',
        tone: 'sky',
        description: 'Deep-dive research with web tools',
        category: 'ai',
        action: 'open_agent',
    },
    {
        id: 'code',
        name: 'Code',
        icon: 'Code2',
        tone: 'emerald',
        description: 'AI code assistant & executor',
        category: 'ai',
        href: 'bucks://implementation',
    },
];

export const CATEGORIES: { id: Category; label: string; emoji: string; tone: Tone }[] = [
    { id: 'finance',   label: 'Finance',   emoji: '💎', tone: 'violet' },
    { id: 'transport', label: 'Transport',  emoji: '🚀', tone: 'amber' },
    { id: 'web3',      label: 'Web3',       emoji: '🌐', tone: 'cyan' },
    { id: 'social',    label: 'Social',     emoji: '✨', tone: 'indigo' },
    { id: 'tools',     label: 'Tools',      emoji: '🛠', tone: 'slate' },
    { id: 'ai',        label: 'AI',         emoji: '🤖', tone: 'violet' },
];

export function getApp(id: string): MiniApp | undefined {
    return APP_REGISTRY.find(a => a.id === id);
}

export function appsByCategory(cat: Category): MiniApp[] {
    return APP_REGISTRY.filter(a => a.category === cat);
}

// ── Grid layout ───────────────────────────────────────────────────────────────

export const GRID_COLS = 5;
export const GRID_ROWS = 4;

const STORAGE_KEY = 'bucks_home_layout_v1';

const DEFAULT_LAYOUT: Record<string, string> = {
    '0,0': 'wallet',
    '0,1': 'agent',
    '0,2': 'ipfs',
    '0,3': 'taxi',
    '0,4': 'profile',
    '1,0': 'pay',
    '1,1': 'feed',
    '1,2': 'identity',
    '1,3': 'food',
    '1,4': 'settings',
};

function loadLayout(): Record<string, string> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : DEFAULT_LAYOUT;
    } catch {
        return DEFAULT_LAYOUT;
    }
}

function saveLayout(layout: Record<string, string>) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {}
}

// layout: { "row,col": appId }
function createHomeStore() {
    const { subscribe, set, update } = writable<Record<string, string>>(loadLayout());

    return {
        subscribe,

        placeApp(row: number, col: number, appId: string) {
            update(l => {
                const next = { ...l };
                // Remove app from any previous cell
                for (const k of Object.keys(next)) {
                    if (next[k] === appId) delete next[k];
                }
                // Swap if target is occupied
                const key = `${row},${col}`;
                next[key] = appId;
                saveLayout(next);
                return next;
            });
        },

        swapApps(fromRow: number, fromCol: number, toRow: number, toCol: number) {
            update(l => {
                const next = { ...l };
                const fromKey = `${fromRow},${fromCol}`;
                const toKey   = `${toRow},${toCol}`;
                const tmp = next[fromKey];
                if (next[toKey]) next[fromKey] = next[toKey];
                else delete next[fromKey];
                next[toKey] = tmp;
                saveLayout(next);
                return next;
            });
        },

        removeApp(appId: string) {
            update(l => {
                const next = { ...l };
                for (const k of Object.keys(next)) {
                    if (next[k] === appId) { delete next[k]; break; }
                }
                saveLayout(next);
                return next;
            });
        },

        addToFirstEmpty(appId: string) {
            update(l => {
                // Already on screen?
                if (Object.values(l).includes(appId)) return l;
                const next = { ...l };
                for (let r = 0; r < GRID_ROWS; r++) {
                    for (let c = 0; c < GRID_COLS; c++) {
                        const k = `${r},${c}`;
                        if (!next[k]) {
                            next[k] = appId;
                            saveLayout(next);
                            return next;
                        }
                    }
                }
                return next;
            });
        },

        isInstalled(appId: string): boolean {
            return Object.values(get({ subscribe })).includes(appId);
        },

        reset() {
            saveLayout(DEFAULT_LAYOUT);
            set(DEFAULT_LAYOUT);
        },
    };
}

export const homeStore = createHomeStore();

// ── Drag state ────────────────────────────────────────────────────────────────

export const dragState = writable<{
    active: boolean;
    appId: string | null;
    fromRow: number | null;
    fromCol: number | null;
    source: 'grid' | 'store' | null;
}>({ active: false, appId: null, fromRow: null, fromCol: null, source: null });
