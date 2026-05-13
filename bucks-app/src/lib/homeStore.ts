/**
 * Home Screen Store — Mini-app registry, grid layout, drag state.
 * Persists to localStorage so the home screen survives restarts.
 */
import { writable, get } from 'svelte/store';

// ── App definition ────────────────────────────────────────────────────────────

export interface MiniApp {
    id: string;
    name: string;
    icon: string;                         // lucide-svelte component name (PascalCase)
    gradient: [string, string];           // CSS gradient stops
    glow: string;                         // box-shadow glow color (rgba)
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
        gradient: ['#6d28d9', '#4c1d95'],
        glow: 'rgba(109,40,217,0.4)',
        description: 'Multi-chain crypto wallet, DID payments',
        category: 'finance',
        href: 'bucks://wallet',
        isBuiltIn: true,
    },
    {
        id: 'pay',
        name: 'Pay',
        icon: 'SendHorizontal',
        gradient: ['#059669', '#064e3b'],
        glow: 'rgba(5,150,105,0.4)',
        description: 'Send & receive instantly',
        category: 'finance',
        href: 'bucks://wallet',
    },
    {
        id: 'portfolio',
        name: 'Portfolio',
        icon: 'TrendingUp',
        gradient: ['#0284c7', '#0c4a6e'],
        glow: 'rgba(2,132,199,0.4)',
        description: 'Track your assets & performance',
        category: 'finance',
        href: 'bucks://wallet',
    },
    // Transport
    {
        id: 'taxi',
        name: 'Taxi',
        icon: 'Car',
        gradient: ['#d97706', '#78350f'],
        glow: 'rgba(217,119,6,0.4)',
        description: 'Book a ride in seconds',
        category: 'transport',
        href: 'bucks://superapp',
    },
    {
        id: 'food',
        name: 'Food',
        icon: 'UtensilsCrossed',
        gradient: ['#dc2626', '#7f1d1d'],
        glow: 'rgba(220,38,38,0.4)',
        description: 'Order from nearby restaurants',
        category: 'transport',
        href: 'bucks://superapp',
    },
    {
        id: 'delivery',
        name: 'Delivery',
        icon: 'Package',
        gradient: ['#7c3aed', '#4c1d95'],
        glow: 'rgba(124,58,237,0.4)',
        description: 'Track parcels & shipments',
        category: 'transport',
        href: 'bucks://superapp',
    },
    // Web3
    {
        id: 'ipfs',
        name: 'IPFS',
        icon: 'Globe',
        gradient: ['#0891b2', '#0c4a6e'],
        glow: 'rgba(8,145,178,0.4)',
        description: 'Decentralised file storage',
        category: 'web3',
        href: 'bucks://ipfs',
        isBuiltIn: true,
    },
    {
        id: 'identity',
        name: 'Identity',
        icon: 'Fingerprint',
        gradient: ['#7c3aed', '#5b21b6'],
        glow: 'rgba(124,58,237,0.4)',
        description: 'DID & self-sovereign identity',
        category: 'web3',
        href: 'bucks://login',
    },
    {
        id: 'nft',
        name: 'NFTs',
        icon: 'Image',
        gradient: ['#db2777', '#831843'],
        glow: 'rgba(219,39,119,0.4)',
        description: 'Browse & manage NFT collections',
        category: 'web3',
        href: 'bucks://wallet',
    },
    {
        id: 'dao',
        name: 'DAO',
        icon: 'Vote',
        gradient: ['#0284c7', '#1e3a5f'],
        glow: 'rgba(2,132,199,0.3)',
        description: 'Participate in governance',
        category: 'web3',
        href: 'bucks://implementation',
    },
    // Social
    {
        id: 'profile',
        name: 'Profile',
        icon: 'CircleUser',
        gradient: ['#4f46e5', '#2e1065'],
        glow: 'rgba(79,70,229,0.4)',
        description: 'Your decentralised identity',
        category: 'social',
        href: 'bucks://login',
    },
    {
        id: 'messages',
        name: 'Messages',
        icon: 'MessageCircle',
        gradient: ['#2563eb', '#1e3a8a'],
        glow: 'rgba(37,99,235,0.4)',
        description: 'Encrypted peer-to-peer chat',
        category: 'social',
        href: 'bucks://messages',
    },
    {
        id: 'feed',
        name: 'Feed',
        icon: 'Rss',
        gradient: ['#059669', '#064e3b'],
        glow: 'rgba(5,150,105,0.3)',
        description: 'Global decentralised feed',
        category: 'social',
        href: 'bucks://feed',
    },
    // Tools
    {
        id: 'settings',
        name: 'Settings',
        icon: 'Settings2',
        gradient: ['#374151', '#111827'],
        glow: 'rgba(55,65,81,0.5)',
        description: 'Browser & agent configuration',
        category: 'tools',
        href: 'bucks://settings',
    },
    {
        id: 'history',
        name: 'History',
        icon: 'History',
        gradient: ['#6b7280', '#1f2937'],
        glow: 'rgba(107,114,128,0.4)',
        description: 'Browse your web history',
        category: 'tools',
        href: 'bucks://history',
    },
    {
        id: 'bookmarks',
        name: 'Bookmarks',
        icon: 'Bookmark',
        gradient: ['#b45309', '#451a03'],
        glow: 'rgba(180,83,9,0.4)',
        description: 'Saved pages & links',
        category: 'tools',
        href: 'bucks://bookmarks',
    },
    {
        id: 'node',
        name: 'Node',
        icon: 'Network',
        gradient: ['#065f46', '#022c22'],
        glow: 'rgba(6,95,70,0.4)',
        description: 'Network & implementation status',
        category: 'tools',
        href: 'bucks://implementation',
    },
    // AI
    {
        id: 'agent',
        name: 'Agent',
        icon: 'Bot',
        gradient: ['#7c3aed', '#4f46e5'],
        glow: 'rgba(124,58,237,0.5)',
        description: 'Bucks AI — your intelligent assistant',
        category: 'ai',
        isBuiltIn: true,
        action: 'open_agent',
    },
    {
        id: 'research',
        name: 'Research',
        icon: 'Search',
        gradient: ['#0369a1', '#0c4a6e'],
        glow: 'rgba(3,105,161,0.4)',
        description: 'Deep-dive research with web tools',
        category: 'ai',
        action: 'open_agent',
    },
    {
        id: 'code',
        name: 'Code',
        icon: 'Code2',
        gradient: ['#064e3b', '#022c22'],
        glow: 'rgba(6,78,59,0.4)',
        description: 'AI code assistant & executor',
        category: 'ai',
        href: 'bucks://implementation',
    },
];

export const CATEGORIES: { id: Category; label: string; emoji: string; color: string }[] = [
    { id: 'finance',   label: 'Finance',   emoji: '💎', color: '#6d28d9' },
    { id: 'transport', label: 'Transport',  emoji: '🚀', color: '#d97706' },
    { id: 'web3',      label: 'Web3',       emoji: '🌐', color: '#0891b2' },
    { id: 'social',    label: 'Social',     emoji: '✨', color: '#4f46e5' },
    { id: 'tools',     label: 'Tools',      emoji: '🛠', color: '#374151' },
    { id: 'ai',        label: 'AI',         emoji: '🤖', color: '#7c3aed' },
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
