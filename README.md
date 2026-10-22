# Bucks Browser

A decentralised, AI-native Web3 browser: an Electron shell with native
`WebContentsView` tabs, an AI agent (the Python Soul Engine), an IPFS/libp2p
swarm layer (Helia), end-to-end encrypted peer-to-peer messaging, and site
hosting over `ipfs://` and `ipns://`.

This is the `electron-core` branch, the main line of development.

## Repository layout

```
.
├── electron/          # The browser app (Electron). Entry point: main.js
│   ├── hosting/       # Site hosting over ipfs:// and ipns:// (own package, runs Kubo)
│   ├── security/      # Request filter, cookie policy, ad/tracker blocking
│   ├── scripts/       # Manual IPFS smoke and stress tests
│   ├── test/unit/     # node --test unit tests
│   └── tests/         # Playwright end-to-end tests (drive the real app)
├── agent/             # Python AI backend, the Soul Engine (FastAPI on :8765)
├── ipfs/              # IPFS cluster file-manager proxy (server.js on :3939) and cluster setup
├── data/              # Agent runtime state and the cached Quran source
├── scripts/           # Multi-device test harnesses and release tooling
├── docs/              # Architecture, specs and audits; docs/research/ holds research notes
├── install.sh         # One-command install for macOS and Linux
└── package.json       # `npm start` / `npm test` launchers for electron/
```

## Prerequisites

- **Node.js 18 or newer** and npm
- **Python 3.10 to 3.12** (the agent's dependencies do not support 3.13+ yet)
- macOS, Windows or Linux

## Quick start

```bash
git clone -b electron-core https://github.com/infin8sync69-source/Bucks-browser.git
cd Bucks-browser
./install.sh            # macOS / Linux: installs everything, then launches the app
```

Or step by step:

```bash
# 1. Browser dependencies
cd electron && npm install && cd ..

# 2. Agent venv + dependencies (one-time)
./agent/start_soul_engine.sh   # Ctrl-C once it reports "Uvicorn running on :8765"

# 3. Optional: site hosting (downloads a pinned Kubo binary)
cd electron/hosting && npm install && npm run fetch:kubo && cd ../..

# 4. Launch the browser
npm start
```

`npm start` (from the repo root) runs the Electron app. On boot the app
**supervises the Soul Engine itself** (`electron/soul-engine-supervisor.js`): it
starts `agent/soul_engine.py` on `127.0.0.1:8765` and restarts it if it dies, so
step 2 is only needed once, to create the Python venv.

### Environment configuration

Copy [`agent/.env.example`](agent/.env.example) to `agent/.env` to choose the
model provider with `MODEL_PROVIDER`:

| Provider | Runs | Needs |
|---|---|---|
| `nim` (the default when unset) | NVIDIA NIM API | `NGC_API_KEY` |
| `edge` | Embedded llama-cpp-python, in process | Nothing external |
| `slm`, `ollama` | A local Ollama server | Ollama and a pulled model |
| `litai` | Lightning AI API | `LITAI_API_KEY` |

Conversations are stored in local SQLite (`~/.bucks/agent-memory/`). A Postgres
database is used only if you set `DATABASE_URL`.

For the optional multi-machine IPFS pin cluster, copy
[`ipfs/cluster-config.env.example`](ipfs/cluster-config.env.example) to
`ipfs/cluster-config.env` and generate a fresh `CLUSTER_SECRET`. The real file
is gitignored; never commit it.

## Tests

```bash
cd electron && npm run test:unit       # unit tests (node --test)
cd electron && npm test                # Playwright end-to-end tests against the real app
cd electron/hosting && npm test        # hosting unit and Kubo integration tests
cd agent && .venv/bin/python -m pytest tests/ -q   # agent tests (pytest is not in requirements.txt)
```

Some tests need a network or a running node: the end-to-end split-pane test loads
`example.com`, `agent/tests/test_ipfs_skills.py` needs an IPFS API, and the
devices end-to-end test needs the hosting Kubo binary.

## Building distributables

```bash
cd electron
npm run dist     # electron-builder → electron/dist/ (dmg/zip on macOS, NSIS + portable on Windows, AppImage on Linux)
npm run pack     # unpacked build for local inspection
```

The build bundles `agent/` (minus venv and caches) as an extra resource.
Releases are not published to GitHub: `scripts/build-and-pin-release.js` pins a
signed release to IPFS through a running Bucks instance, and installed copies
pick it up through `electron/cluster-updater.js`.

## Further documentation

| Doc | What it covers |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Locked definitions: swarm intelligence, soul, RAG, RL loop |
| [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) | Production audit, open P0s, fixes applied |
| [docs/EPHEMERAL-UI.md](docs/EPHEMERAL-UI.md) | Generative UI architecture (components rendered in chat) |
| [docs/CHROMIUM-ENGINE.md](docs/CHROMIUM-ENGINE.md) | Chromium engine architecture |
| [docs/DEVICES.md](docs/DEVICES.md) | Pairing your Bucks installs over Kubo peering and pubsub |
| [docs/IPFS-HOSTING-IMPLEMENTATION.md](docs/IPFS-HOSTING-IMPLEMENTATION.md) | Hosting sites over `ipfs://` and `ipns://` |
| [docs/research/](docs/research/) | IPFS hosting research report and its evidence notes |
| [ipfs/README.md](ipfs/README.md) | IPFS cluster + file-manager component |

## License

[MIT](LICENSE)
