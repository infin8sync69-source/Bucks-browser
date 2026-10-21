# Bucks Browser

A decentralised, AI-native Web3 browser: Electron shell with native
`WebContentsView` tabs, a fully embedded local AI agent (llama.cpp — no cloud
APIs, no external LLM services), an IPFS/libp2p swarm layer (Helia), and
end-to-end encrypted peer-to-peer messaging. `ipfs://` and `ipns://` pages,
hosting your own sites and pairing your devices run on an embedded Kubo node,
as in Bucks-browser ([docs/IPFS-PARITY.md](docs/IPFS-PARITY.md)).

## Repository layout

```
.
├── electron/         # The browser app (Electron). Entry point: main.js
│   └── hosting/      # Kubo, ipfs:// / ipns://, site hosting, devices (from Bucks-browser)
├── agent/            # Python AI backend — the Soul Engine (FastAPI on :8765)
├── ipfs/             # IPFS cluster file-manager proxy (server.js on :3939)
├── data/             # Soul identity seeds (world_soul.locked, sources)
├── assets/           # Shared static assets (blocklist, new-tab page)
├── scripts/          # Windows launch/install scripts
├── docs/             # Architecture and audit docs
└── package.json      # Root libp2p/Helia deps + `npm start` launcher
```

## Prerequisites

- **Node.js ≥ 18** and npm
- **Python 3.11 or 3.12** (3.14+ is not compatible with the agent deps)
- macOS, Windows, or Linux. 8 GB RAM minimum — the embedded model is
  RAM-tiered and picks the strongest GGUF that fits your machine.

No Ollama, no API keys, and no cloud accounts are required. The agent runs an
embedded llama.cpp model in-process; weights download once to
`~/.bucks/models/` on first run.

## Quick start (clone → running app)

```bash
git clone git@github.com:infin8sync69-source/buckscore.git
cd buckscore

# 1. Root swarm-layer deps
npm install

# 2. Browser deps
cd electron && npm install && cd ..

# 2b. IPFS node and hosting deps (Kubo; without it here the app downloads it on first start)
cd electron/hosting && npm install && npm run fetch:kubo && cd ../..

# 3. Agent venv + deps (one-time; also downloads model weights on first run)
./agent/start_soul_engine.sh   # Ctrl-C once it reports "Uvicorn running on :8765"

# 4. Launch the browser
npm start
```

`./install.sh` does steps 1 to 4 in one go on macOS and Linux (`--no-run` to
skip the launch).

`npm start` (from the repo root) runs the Electron app. On boot, the app
**supervises the Soul Engine itself** (`electron/soul-engine-supervisor.js`) —
it starts `agent/soul_engine.py` on `127.0.0.1:8765` and restarts it if it
dies, so step 3 is only needed the first time to create the Python venv.

### Environment configuration

Copy [`agent/.env.example`](agent/.env.example) to `agent/.env` to customise.
The default (`MODEL_PROVIDER=edge`) is the embedded model and needs no keys.
Setting `MODEL_PROVIDER=ollama` is an explicit opt-in and requires a running
Ollama server.

For the optional multi-machine IPFS pin cluster, copy
[`ipfs/cluster-config.env.example`](ipfs/cluster-config.env.example) to
`ipfs/cluster-config.env` and generate a fresh `CLUSTER_SECRET`. The real file
is gitignored — never commit it.

## Tests

```bash
# Browser E2E + visual regression (Playwright drives the real Electron app)
cd electron && npm test

# IPFS node, ipfs:// handler, hosting and devices (real Kubo daemons)
cd electron/hosting && npm test

# Agent tests
cd agent && .venv/bin/python -m pytest tests/ -x -q
```

## Building distributables

```bash
cd electron
npm run dist     # electron-builder → electron/dist/ (dmg/zip on macOS, nsis on Windows)
npm run pack     # unpacked build for local inspection
```

The build bundles `agent/` (minus venv/caches) and the Kubo binary
(`npm run hosting:prepare` fetches it first) as extra resources, so the
packaged app is fully self-contained. Auto-update publishes GitHub releases on
`infin8sync69-source/buckscore`.

## Further documentation

| Doc | What it covers |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Locked definitions: swarm intelligence, soul, RAG, RL loop |
| [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) | Principal-engineer audit, open P0s, fixes applied |
| [docs/EPHEMERAL-UI.md](docs/EPHEMERAL-UI.md) | Generative UI architecture (components rendered in chat) |
| [docs/IPFS-PARITY.md](docs/IPFS-PARITY.md) | The Bucks-browser IPFS work in this app: Kubo and Helia, what is done, what is left |
| [docs/IPFS-HOSTING-IMPLEMENTATION.md](docs/IPFS-HOSTING-IMPLEMENTATION.md) | Specification for hosting sites over `ipfs://` and `ipns://` |
| [ipfs/README.md](ipfs/README.md) | IPFS cluster + file-manager component |
| [docs/SETUP-legacy.md](docs/SETUP-legacy.md) | ⚠️ Superseded 2026-07 setup guide (Ollama-era) — kept for reference |

## License

[MIT](LICENSE)
