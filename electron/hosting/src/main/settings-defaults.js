// Default settings and the merge rule for patches. No Electron import, so scripts and tests can use
// them (scripts/site.mjs reads the same profile as the app). settings.js re-exports both.

export const DEFAULT_SETTINGS = Object.freeze({
  searchEngine: 'duckduckgo', // duckduckgo | google | brave | bing
  homepage: 'bucks://newtab',
  ipfs: {
    mode: 'embedded', // embedded | external
    externalApiUrl: '', // e.g. http://127.0.0.1:5001 when mode === 'external'
    publicGateway: 'https://ipfs.io', // fallback when the local node is not ready
    preferredGateway: 'local', // local | public
    autoStart: true,
    // Paired Bucks devices: [{ peerId, name, addrs: ['/ip4/…/tcp/…'] }]. Kept connected via Kubo Peering.
    peers: [],
    storageMaxGB: 10, // Kubo Datastore.StorageMax; garbage collection never removes pins
  },
  // Hosting sites from this browser (src/main/sites, docs/HOSTING.md).
  sites: {
    quotaMiB: 500, // largest site that can be published
    maxFiles: 50_000,
    historyLimit: 5, // versions kept pinned for rollback
    // Health checks ("Is my site discoverable / reachable?"), run only when asked:
    routerUrl: 'https://delegated-ipfs.dev', // a public delegated router (/routing/v1/providers/<cid>)
    probeUrl: '', // a trustless gateway that fetches the root block from outside; '' = not configured
  },
  devices: {
    name: '', // '' → the computer's host name
    autoPin: false, // pin files shared by paired devices automatically
  },
  security: {
    httpsOnly: true,
    adBlock: true,
    trackerBlock: true,
    blockThirdPartyCookies: true,
  },
  wallet: {
    nodeUrl: 'http://127.0.0.1:8080',
  },
  agent: {
    provider: 'offline', // offline | remote | ollama | soul
    remoteUrl: 'http://localhost:3000',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.2',
    // The Soul Engine sidecar (agent/), started by the browser when provider === 'soul'.
    soul: {
      autoStart: true, // start it at launch while it is the selected provider
      backend: 'edge', // edge (on-device model) | ollama | nim | litai (cloud: your key in <userData>/soul-engine/.env)
      port: 0, // 0 = a free loopback port at every start
      python: '', // '' = the private venv from Install, or agent/.venv in a source checkout
      agentDir: '', // '' = the agent/ shipped with the app
    },
  },
  downloads: {
    directory: '', // '' → OS default downloads dir
    askWhereToSave: false,
  },
  ui: {
    theme: 'dark',
  },
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(base?.[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}
