/**
 * Typed accessor for the `window.bucks` bridge exposed by src/preload/preload.cjs.
 *
 * The shapes below mirror docs/IPC-CONTRACT.md and DEFAULT_SETTINGS in src/main/settings.js
 * exactly. When the chrome runs outside Electron (plain `vite dev` in a browser) a clearly
 * labelled in-memory mock is used so the chrome still renders without crashing.
 */

export type Unsubscribe = () => void;

export interface TabError {
    code: number;
    description: string;
    url: string;
}

export interface TabState {
    id: string;
    /** ipfs:// urls are reported in their canonical form (CIDv1 base32). */
    url: string;
    title: string;
    favicon: string | null;
    isLoading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    error: TabError | null;
    audible?: boolean;
}

export interface OpenRequest {
    openerId: string | null;
    url: string;
    /** Chromium disposition ('foreground-tab', 'background-tab', 'new-window', …) or 'current-tab'. */
    disposition: string;
}

export type IpfsNodeState = 'idle' | 'initializing' | 'ready' | 'error' | 'stopped';
export type IpfsSource = 'embedded_kubo' | 'external_api' | 'public_gateway';

export interface IpfsStatus {
    state: IpfsNodeState;
    source: IpfsSource;
    message: string;
    /** e.g. http://127.0.0.1:<port> */
    api_url: string | null;
    /** Path gateway base, e.g. http://127.0.0.1:<port> (no trailing /ipfs/). */
    gateway_url: string | null;
    embedded: boolean;
    /** Kubo version. */
    version: string | null;
    peer_id: string | null;
}

export interface IpfsAddResult {
    cid: string;
    ipfs_uri: string;
    gateway_url: string;
    size: number;
}

export interface IpfsNodeInfo {
    peer_id: string;
    addresses: string[];
    agent_version: string;
}

export interface IpfsLsEntry {
    name: string;
    cid: string;
    size: number;
    type: 'file' | 'dir' | 'unknown';
}

export interface IpfsPinEntry {
    cid: string;
    pin_type: string;
}

export interface IpfsPeer {
    peer: string;
    addr: string;
    latency?: string;
}

export interface IpfsBandwidth {
    rate_in: number;
    rate_out: number;
    total_in: number;
    total_out: number;
}

export interface IpfsStats {
    repo_size: number;
    storage_max: number;
    num_objects: number;
    peers: number;
    bw?: IpfsBandwidth;
}

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted';

export interface DownloadItem {
    id: string;
    url: string;
    filename: string;
    path: string;
    mime: string;
    state: DownloadState;
    receivedBytes: number;
    totalBytes: number;
    startedAt: number;
}

export interface A2UIPayload {
    type: string;
    url?: string;
    action?: string;
    content?: string;
    [k: string]: unknown;
}

export interface AgentResult {
    status: 'ok' | 'offline_fallback' | 'error';
    /** Natural-language answer. */
    evaluation: string;
    cid?: string | null;
    task_id?: string | null;
    a2ui?: A2UIPayload | null;
}

export interface AgentStatus {
    online: boolean;
    provider: string;
    model?: string;
    providers: string[];
}

export interface AgentQuery {
    prompt: string;
    currentUrl: string | null;
    currentTitle: string | null;
    tabId: string | null;
}

export interface AgentFeedback {
    taskId: string;
    score: number;
    correction?: string;
}

export type SearchEngineId = 'duckduckgo' | 'google' | 'brave' | 'bing';

/** Mirrors DEFAULT_SETTINGS in src/main/settings.js. */
export interface Settings {
    searchEngine: SearchEngineId;
    homepage: string;
    ipfs: {
        mode: 'embedded' | 'external';
        /** e.g. http://127.0.0.1:5001 when mode === 'external' */
        externalApiUrl: string;
        /** Fallback when the local node is not ready. */
        publicGateway: string;
        preferredGateway: 'local' | 'public';
        autoStart: boolean;
    };
    security: {
        httpsOnly: boolean;
        adBlock: boolean;
        trackerBlock: boolean;
        blockThirdPartyCookies: boolean;
    };
    wallet: {
        nodeUrl: string;
    };
    agent: {
        provider: 'offline' | 'remote' | 'ollama';
        remoteUrl: string;
        ollamaUrl: string;
        ollamaModel: string;
    };
    downloads: {
        /** '' → OS default downloads dir */
        directory: string;
        askWhereToSave: boolean;
    };
    ui: {
        theme: 'dark' | 'light';
    };
}

/** Recursive partial used for `settings.set(patch)`. */
export type SettingsPatch = {
    [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K];
};

export interface ContentBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface AppInfo {
    name: string;
    version: string;
    userData: string;
}

export interface SecurityStats {
    blockedRequests: number;
    httpsUpgrades: number;
    adBlockReady: boolean;
}

export interface WalletRpcRequest {
    method: string;
    path: string;
    body?: unknown;
}

export type ShortcutAction =
    | 'new-tab'
    | 'close-tab'
    | 'focus-omnibox'
    | 'reload'
    | 'back'
    | 'forward'
    | 'next-tab'
    | 'prev-tab'
    | 'find'
    | 'zoom-in'
    | 'zoom-out'
    | 'zoom-reset'
    | 'toggle-devtools'
    | 'open-settings'
    | 'open-downloads'
    | 'open-ipfs'
    | 'open-wallet'
    | 'toggle-agent';

export interface BucksApi {
    platform: string;
    versions: { electron: string; chrome: string; node: string };

    app: {
        info(): Promise<AppInfo>;
        onShortcut(cb: (payload: { action: ShortcutAction | string }) => void): Unsubscribe;
    };

    window: {
        minimize(): Promise<void>;
        /** Toggles maximize / restore. */
        maximize(): Promise<void>;
        close(): Promise<void>;
        isMaximized(): Promise<boolean>;
        onMaximized(cb: (isMaximized: boolean) => void): Unsubscribe;
    };

    tabs: {
        create(id: string, url: string): Promise<TabState>;
        navigate(id: string, url: string): Promise<TabState>;
        close(id: string): Promise<void>;
        activate(id: string | null): Promise<void>;
        back(id: string): Promise<void>;
        forward(id: string): Promise<void>;
        reload(id: string): Promise<void>;
        stop(id: string): Promise<void>;
        getState(id: string): Promise<TabState | null>;
        setContentBounds(bounds: ContentBounds): Promise<void>;
        setContentVisible(visible: boolean): Promise<void>;
        capture(id: string): Promise<string>;
        extractText(id: string): Promise<{ title: string; text: string; url: string }>;
        onUpdated(cb: (state: TabState) => void): Unsubscribe;
        onOpenRequest(cb: (req: OpenRequest) => void): Unsubscribe;
        onClosed(cb: (payload: { id: string }) => void): Unsubscribe;
    };

    ipfs: {
        status(): Promise<IpfsStatus>;
        start(): Promise<void>;
        stop(): Promise<void>;
        nodeInfo(): Promise<IpfsNodeInfo>;
        add(args: { fileName: string; mimeType: string; dataBase64: string }): Promise<IpfsAddResult>;
        addText(content: string, fileName?: string): Promise<IpfsAddResult>;
        /** base64 of the content (capped by maxBytes, default 8 MiB). */
        cat(path: string, opts?: { maxBytes?: number }): Promise<string>;
        ls(path: string): Promise<IpfsLsEntry[]>;
        pinAdd(cid: string): Promise<string>;
        pinRm(cid: string): Promise<string>;
        pinLs(): Promise<IpfsPinEntry[]>;
        peers(): Promise<IpfsPeer[]>;
        stats(): Promise<IpfsStats>;
        resolve(name: string): Promise<string>;
        gatewayUrlFor(url: string): Promise<string>;
        normalizeUrl(url: string): Promise<string>;
        onStatus(cb: (status: IpfsStatus) => void): Unsubscribe;
    };

    settings: {
        get(): Promise<Settings>;
        /** Deep-merges a partial patch and returns the full settings. */
        set(patch: SettingsPatch): Promise<Settings>;
        onChange(cb: (settings: Settings) => void): Unsubscribe;
    };

    downloads: {
        list(): Promise<DownloadItem[]>;
        open(id: string): Promise<void>;
        showInFolder(id: string): Promise<void>;
        cancel(id: string): Promise<void>;
        clear(): Promise<void>;
        onEvent(cb: (item: DownloadItem) => void): Unsubscribe;
    };

    agent: {
        status(): Promise<AgentStatus>;
        query(q: AgentQuery): Promise<AgentResult>;
        feedback(f: AgentFeedback): Promise<void>;
        listModels(): Promise<string[]>;
    };

    wallet: {
        /** Proxied HTTP call to the configured Bucks node; resolves with parsed JSON, rejects on network / non-2xx. */
        rpc(req: WalletRpcRequest): Promise<any>;
    };

    security: {
        stats(): Promise<SecurityStats>;
    };

    shell: {
        /** Open http(s)/mailto URLs in the OS default handler. */
        openExternal(url: string): Promise<void>;
    };
}

// ── In-browser mock ────────────────────────────────────────────────────────────

const MOCK_LABEL = '[bucks bridge mock]';
const NOT_IN_BUCKS = 'Not running inside Bucks Browser';

function defaultSettings(): Settings {
    return {
        searchEngine: 'duckduckgo',
        homepage: 'bucks://newtab',
        ipfs: {
            mode: 'embedded',
            externalApiUrl: '',
            publicGateway: 'https://ipfs.io',
            preferredGateway: 'local',
            autoStart: true,
        },
        security: {
            httpsOnly: true,
            adBlock: true,
            trackerBlock: true,
            blockThirdPartyCookies: true,
        },
        wallet: { nodeUrl: 'http://127.0.0.1:8080' },
        agent: {
            provider: 'offline',
            remoteUrl: 'http://localhost:3000',
            ollamaUrl: 'http://127.0.0.1:11434',
            ollamaModel: 'llama3.2',
        },
        downloads: { directory: '', askWhereToSave: false },
        ui: { theme: 'dark' },
    };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, unknown>): T {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch || {})) {
        if (isPlainObject(v) && isPlainObject(base[k])) out[k] = deepMerge(base[k], v);
        else if (v !== undefined) out[k] = v;
    }
    return out as T;
}

function fakeTabState(id: string, url: string): TabState {
    return { id, url, title: '', favicon: null, isLoading: false, canGoBack: false, canGoForward: false, error: null, audible: false };
}

function mockIpfsStatus(): IpfsStatus {
    return {
        state: 'error',
        source: 'embedded_kubo',
        message: NOT_IN_BUCKS,
        api_url: null,
        gateway_url: null,
        embedded: true,
        version: null,
        peer_id: null,
    };
}

const noSub: Unsubscribe = () => {};
const resolved = () => Promise.resolve();
const unavailable = <T = never>(what: string): Promise<T> => Promise.reject(new Error(`${what}: ${NOT_IN_BUCKS}`));

/**
 * Build the in-browser mock. Tab calls resolve with fake TabState, IPFS reports an error status,
 * settings live in memory, events never fire. Everything logs once so it is obvious in devtools.
 */
function createMockBridge(): BucksApi {
    let settings = defaultSettings();
    if (typeof console !== 'undefined') {
        console.info(`${MOCK_LABEL} window.bucks is missing — using the in-browser mock bridge`);
    }
    return {
        platform: 'browser',
        versions: { electron: 'mock', chrome: 'mock', node: 'mock' },
        app: {
            info: () => Promise.resolve({ name: 'Bucks Browser (mock)', version: '0.0.0', userData: '' }),
            onShortcut: () => noSub,
        },
        window: {
            minimize: resolved,
            maximize: resolved,
            close: resolved,
            isMaximized: () => Promise.resolve(false),
            onMaximized: () => noSub,
        },
        tabs: {
            create: (id, url) => Promise.resolve(fakeTabState(id, url)),
            navigate: (id, url) => Promise.resolve(fakeTabState(id, url)),
            close: resolved,
            activate: resolved,
            back: resolved,
            forward: resolved,
            reload: resolved,
            stop: resolved,
            getState: () => Promise.resolve(null),
            setContentBounds: resolved,
            setContentVisible: resolved,
            capture: () => unavailable('tabs.capture'),
            extractText: () => unavailable('tabs.extractText'),
            onUpdated: () => noSub,
            onOpenRequest: () => noSub,
            onClosed: () => noSub,
        },
        ipfs: {
            status: () => Promise.resolve(mockIpfsStatus()),
            start: () => unavailable('ipfs.start'),
            stop: () => unavailable('ipfs.stop'),
            nodeInfo: () => unavailable('ipfs.nodeInfo'),
            add: () => unavailable('ipfs.add'),
            addText: () => unavailable('ipfs.addText'),
            cat: () => unavailable('ipfs.cat'),
            ls: () => unavailable('ipfs.ls'),
            pinAdd: () => unavailable('ipfs.pinAdd'),
            pinRm: () => unavailable('ipfs.pinRm'),
            pinLs: () => Promise.resolve([]),
            peers: () => Promise.resolve([]),
            stats: () => unavailable('ipfs.stats'),
            resolve: () => unavailable('ipfs.resolve'),
            gatewayUrlFor: (url) => Promise.resolve(url),
            normalizeUrl: (url) => Promise.resolve(url),
            onStatus: () => noSub,
        },
        settings: {
            get: () => Promise.resolve(structuredClone(settings)),
            set: (patch) => {
                settings = deepMerge(settings, (patch || {}) as Record<string, unknown>);
                return Promise.resolve(structuredClone(settings));
            },
            onChange: () => noSub,
        },
        downloads: {
            list: () => Promise.resolve([]),
            open: resolved,
            showInFolder: resolved,
            cancel: resolved,
            clear: resolved,
            onEvent: () => noSub,
        },
        agent: {
            status: () => Promise.resolve({ online: false, provider: 'offline', providers: ['offline'] }),
            query: ({ prompt }) =>
                Promise.resolve({
                    status: 'offline_fallback',
                    evaluation: `${NOT_IN_BUCKS}. The agent heard: "${prompt}"`,
                    a2ui: null,
                    task_id: null,
                    cid: null,
                }),
            feedback: resolved,
            listModels: () => Promise.resolve([]),
        },
        wallet: {
            rpc: () => unavailable('wallet.rpc'),
        },
        security: {
            stats: () => Promise.resolve({ blockedRequests: 0, httpsUpgrades: 0, adBlockReady: false }),
        },
        shell: {
            openExternal: (url) => {
                if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
                return Promise.resolve();
            },
        },
    };
}

function resolveBridge(): { api: BucksApi; real: boolean } {
    if (typeof window !== 'undefined' && window.bucks && typeof window.bucks === 'object') {
        return { api: window.bucks, real: true };
    }
    return { api: createMockBridge(), real: false };
}

const resolvedBridge = resolveBridge();

/** True when the real preload bridge is present (running inside Bucks Browser). */
export const hasBridge: boolean = resolvedBridge.real;

/** The bridge: the real `window.bucks` inside Bucks Browser, otherwise the in-browser mock. */
export const bucks: BucksApi = resolvedBridge.api;

/** True on macOS, where the window has native traffic lights instead of our window controls. */
export const isMac: boolean = bucks.platform === 'darwin';
