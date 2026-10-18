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
    /** Audio muted by the user. */
    muted?: boolean;
    /** Page zoom in percent (100 = actual size). */
    zoom?: number;
    /** Lives in the in-memory private session. */
    private?: boolean;
}

export interface FoundInPage {
    id: string;
    requestId: number;
    activeMatchOrdinal: number;
    matches: number;
    finalUpdate: boolean;
}

export interface ExtensionInfo {
    id: string | null;
    name: string;
    version: string;
    path: string;
    /** Why it could not be loaded. */
    error: string | null;
}

export interface DefaultBrowserStatus {
    /** Bucks handles both http and https. */
    isDefault: boolean;
    protocols: Record<string, boolean>;
    /** Windows: the OS only lets the user change it in Settings, which set opens. */
    opensSystemSettings: boolean;
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
    /** Generative-UI cards (Soul Engine), already sanitised by the main process. Render as text. */
    components?: UiComponent[];
    /** Suggested next questions (Soul Engine). */
    followups?: string[];
    /** Tools the agent used for this answer (Soul Engine). */
    tools?: string[];
}

export interface AgentStatus {
    online: boolean;
    provider: string;
    model?: string;
    /** Why the provider cannot answer right now (Soul Engine). */
    detail?: string;
    providers: string[];
}

// ── Soul Engine (docs/IPC-CONTRACT.md "Soul Engine") ──

export type SoulBackend = 'edge' | 'ollama' | 'nim' | 'litai';

export interface SoulSettings {
    /** Start the engine at launch while it is the selected provider. */
    autoStart: boolean;
    /** edge = on-device model; ollama; nim / litai = cloud, with your key in <userData>/soul-engine/.env */
    backend: SoulBackend;
    /** 0 = a free loopback port at every start */
    port: number;
    /** '' = the private venv from Install, or agent/.venv in a source checkout */
    python: string;
    /** '' = the agent/ shipped with the app */
    agentDir: string;
}

export type SoulState = 'idle' | 'unavailable' | 'installing' | 'starting' | 'loading' | 'ready' | 'error' | 'stopped';

export interface SoulStatus {
    state: SoulState;
    message: string;
    /** http://127.0.0.1:<port> while running */
    url: string | null;
    backend: SoulBackend;
    model: string | null;
    /** The engine's own /health mode (local_llm, cloud_llm, loading, …). */
    mode: string | null;
    python: string | null;
    agentDir: string | null;
    /** The engine's folder in the profile: data, venv, workspace and the .env for cloud API keys. */
    dataDir: string;
}

export type UiComponent =
    | { component: 'answer'; title: string; text: string }
    | { component: 'list'; title: string; items: { title: string; subtitle: string; url: string }[] }
    | { component: 'table'; title: string; columns: string[]; rows: string[][] }
    | { component: 'stats'; title: string; stats: { label: string; value: string; delta: string }[] }
    | { component: 'chart'; title: string; kind: 'line' | 'bar' | 'pie'; series: { label: string; value: number }[] }
    | { component: 'timeline'; title: string; events: { date: string; title: string; text: string }[] }
    | { component: 'checklist'; title: string; items: { text: string; done: boolean }[] }
    | { component: 'accordion'; title: string; items: { heading: string; text: string }[] }
    | { component: 'code'; title: string; language: string; code: string }
    | {
          component: 'weather';
          title: string;
          place: string;
          current: { temp_c: number | null; feels_c: number | null; condition: string; wind_kmh: number | null; humidity: number | null };
          days: { day: string; condition: string; high_c: number | null; low_c: number | null }[];
      }
    | { component: 'links'; title: string; actions: ({ label: string; url: string } | { label: string; query: string })[] };

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

// ── Devices (docs/IPC-CONTRACT.md "Devices: pairing Bucks installs over IPFS peering + pubsub") ──

/** Pubsub topic every Bucks device announces itself on. */
export const DEVICES_TOPIC = 'bucks-devices-v1';

/** This install, as announced to other devices. */
export interface DeviceSelf {
    /** Kubo peer ID; null until the node is up. */
    peerId: string | null;
    name: string;
    /** process.platform of this install ('darwin', 'linux', 'win32', …). */
    platform: string;
    version: string;
    /** Non-loopback listen multiaddrs without the /p2p/<id> suffix. */
    addrs: string[];
}

/** A device the user paired with (persisted in settings.ipfs.peers). */
export interface PairedDevice {
    peerId: string;
    name: string;
    platform: string | null;
    version: string | null;
    /** Presence received in the last 90 s. */
    online: boolean;
    /** Currently in swarm/peers. */
    connected: boolean;
    /** ms since epoch of the last presence, null when never seen. */
    lastSeen: number | null;
    addrs: string[];
}

/** An unpaired device whose presence was seen in the last 5 minutes (never trusted). */
export interface DiscoveredDevice {
    peerId: string;
    name: string;
    platform: string;
    version: string;
    lastSeen: number;
    addrs: string[];
}

/** A file a paired device shared with this one. */
export interface ReceivedShare {
    cid: string;
    name: string;
    size: number | null;
    /** Sender peer ID. */
    from: string;
    fromName: string;
    ts: number;
    pinned: boolean;
}

/** Result of `bucks:devices:status` and payload of `bucks:devices:updated`. */
export interface DevicesStatus {
    /** Node ready and subscribed to the topic. */
    ready: boolean;
    error: string | null;
    topic: typeof DEVICES_TOPIC;
    self: DeviceSelf;
    paired: PairedDevice[];
    discovered: DiscoveredDevice[];
    received: ReceivedShare[];
}

export interface DevicePairRequest {
    /** A peer ID, or a full multiaddr ending in /p2p/<id>. */
    peerId: string;
    name?: string;
    addrs?: string[];
}

export interface DeviceShareRequest {
    cid: string;
    name?: string;
    size?: number;
}

export interface DeviceShareResult {
    queued: boolean;
    /** Paired devices that were online when the share was announced. */
    onlinePeers: number;
}

/** One entry of settings.ipfs.peers. */
export interface PeerSetting {
    peerId: string;
    name: string;
    addrs: string[];
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
        /** Paired Bucks devices, kept connected through Kubo Peering. Arrays are replaced wholesale on set(). */
        peers: PeerSetting[];
    };
    devices: {
        /** '' → the computer's host name */
        name: string;
        /** Pin files shared by paired devices automatically. */
        autoPin: boolean;
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
        provider: 'offline' | 'remote' | 'ollama' | 'soul';
        remoteUrl: string;
        ollamaUrl: string;
        ollamaModel: string;
        /** The Soul Engine sidecar (agent/), started while it is the selected provider. */
        soul: SoulSettings;
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
    | 'toggle-agent'
    | 'new-private-tab'
    | 'reopen-closed-tab'
    | 'print'
    | 'save-pdf';

export interface BucksApi {
    platform: string;
    versions: { electron: string; chrome: string; node: string };

    app: {
        info(): Promise<AppInfo>;
        onShortcut(cb: (payload: { action: ShortcutAction | string }) => void): Unsubscribe;
        chromeReady(): Promise<void>;
        defaultBrowser(): Promise<DefaultBrowserStatus>;
        setDefaultBrowser(): Promise<DefaultBrowserStatus>;
    };

    browsingData: {
        clear(what: { cookies?: boolean; cache?: boolean; siteData?: boolean }): Promise<{ cleared: string[] }>;
    };

    extensions: {
        list(): Promise<{ folder: string; extensions: ExtensionInfo[] }>;
        reload(): Promise<{ folder: string; extensions: ExtensionInfo[] }>;
        openFolder(): Promise<void>;
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
        create(id: string, url: string, opts?: { private?: boolean }): Promise<TabState>;
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
        find(id: string, text: string, opts?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): Promise<number>;
        stopFind(id: string, action?: 'clearSelection' | 'keepSelection' | 'activateSelection'): Promise<void>;
        onFoundInPage(cb: (result: FoundInPage) => void): Unsubscribe;
        zoom(id: string, action: 'in' | 'out' | 'reset'): Promise<number>;
        setMuted(id: string, muted: boolean): Promise<void>;
        print(id: string): Promise<{ printed: boolean }>;
        printToPdf(id: string): Promise<{ path: string | null }>;
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
        soulStatus(): Promise<SoulStatus>;
        soulStart(): Promise<SoulStatus>;
        soulStop(): Promise<SoulStatus>;
        /** Create the engine's private Python environment, then start it. */
        soulInstall(): Promise<SoulStatus>;
        onSoulStatus(cb: (status: SoulStatus) => void): Unsubscribe;
    };

    wallet: {
        /** Proxied HTTP call to the configured Bucks node; resolves with parsed JSON, rejects on network / non-2xx. */
        rpc(req: WalletRpcRequest): Promise<any>;
    };

    security: {
        stats(): Promise<SecurityStats>;
    };

    devices: {
        status(): Promise<DevicesStatus>;
        /** Pair with another Bucks device (peer ID or pairing address). */
        pair(req: DevicePairRequest): Promise<DevicesStatus>;
        unpair(peerId: string): Promise<DevicesStatus>;
        /** Set this device's display name ('' resets to the host name). */
        rename(name: string): Promise<DevicesStatus>;
        /** Offer a CID to every paired device. */
        share(req: DeviceShareRequest): Promise<DeviceShareResult>;
        /** Remove a received share from the list (does not unpin). */
        dismiss(req: { cid: string; from: string }): Promise<DevicesStatus>;
        onUpdated(cb: (status: DevicesStatus) => void): Unsubscribe;
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
            peers: [],
        },
        devices: { name: '', autoPin: false },
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
            soul: { autoStart: true, backend: 'edge', port: 0, python: '', agentDir: '' },
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
    return { id, url, title: '', favicon: null, isLoading: false, canGoBack: false, canGoForward: false, error: null, audible: false, muted: false, zoom: 100, private: false };
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

/** Devices status outside Bucks: not ready, nothing paired, nothing seen. */
function mockDevicesStatus(name: string): DevicesStatus {
    return {
        ready: false,
        error: NOT_IN_BUCKS,
        topic: DEVICES_TOPIC,
        self: { peerId: null, name, platform: 'browser', version: '0.0.0', addrs: [] },
        paired: [],
        discovered: [],
        received: [],
    };
}

/** Soul Engine status outside Bucks: there is no main process to run it. */
function mockSoulStatus(): SoulStatus {
    return { state: 'unavailable', message: NOT_IN_BUCKS, url: null, backend: 'edge', model: null, mode: null, python: null, agentDir: null, dataDir: '' };
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
            chromeReady: resolved,
            defaultBrowser: () => Promise.resolve({ isDefault: false, protocols: {}, opensSystemSettings: false }),
            setDefaultBrowser: () => unavailable('app.setDefaultBrowser'),
        },
        browsingData: {
            clear: () => unavailable('browsingData.clear'),
        },
        extensions: {
            list: () => Promise.resolve({ folder: '', extensions: [] }),
            reload: () => Promise.resolve({ folder: '', extensions: [] }),
            openFolder: () => unavailable('extensions.openFolder'),
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
            find: () => Promise.resolve(0),
            stopFind: resolved,
            onFoundInPage: () => noSub,
            zoom: () => Promise.resolve(100),
            setMuted: resolved,
            print: () => unavailable('tabs.print'),
            printToPdf: () => unavailable('tabs.printToPdf'),
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
            soulStatus: () => Promise.resolve(mockSoulStatus()),
            soulStart: () => unavailable('agent.soulStart'),
            soulStop: () => Promise.resolve(mockSoulStatus()),
            soulInstall: () => unavailable('agent.soulInstall'),
            onSoulStatus: () => noSub,
        },
        wallet: {
            rpc: () => unavailable('wallet.rpc'),
        },
        security: {
            stats: () => Promise.resolve({ blockedRequests: 0, httpsUpgrades: 0, adBlockReady: false }),
        },
        devices: {
            status: () => Promise.resolve(mockDevicesStatus(settings.devices.name)),
            // Pairing and sharing need a running IPFS node, so they fail loudly instead of pretending.
            pair: () => unavailable('devices.pair'),
            unpair: () => Promise.resolve(mockDevicesStatus(settings.devices.name)),
            rename: (name) => {
                settings = deepMerge(settings, { devices: { name: String(name ?? '').trim() } });
                return Promise.resolve(mockDevicesStatus(settings.devices.name));
            },
            share: () => unavailable('devices.share'),
            dismiss: () => Promise.resolve(mockDevicesStatus(settings.devices.name)),
            onUpdated: () => noSub,
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
