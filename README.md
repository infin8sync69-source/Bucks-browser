# Bucks Browser

A decentralised, AI-native Web3 browser with a built-in agent backend, IPFS/libp2p swarm layer, and end-to-end encrypted peer-to-peer messaging.

## Repository layout

```
Bucks-browser/
├── tauri/            # v1 — Primary browser (Tauri + SvelteKit)
├── electron/         # v2 — Electron browser (Electron + Next.js shell + C++ native)
├── agent/            # Shared Python AI backend (soul, RAG, RL, p2p, server)
├── scripts/          # Launch, install, and cluster scripts
├── assets/           # Shared static assets (blocklist, new-tab page)
├── package.json      # Root libp2p / Helia dependencies (shared swarm layer)
└── node_modules/     # Root Node dependencies
```

## Quick start

### Tauri browser (primary — v1)

Requires [Rust + Tauri CLI](https://tauri.app/start/prerequisites/) and Node ≥ 18.

```bash
cd tauri
npm install
npm run tauri dev
```

### Electron browser (v2)

```bash
cd electron
npm install
npm start
```

Or from the repo root using the launch helper:

```bash
node scripts/launch.js
```

### Agent backend

Requires Python ≥ 3.11 and either Ollama or a configured LitAI key.

```bash
cd agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server_lite.py        # lightweight server (default)
# python server.py           # full server with all modules
```

## Architecture

| Layer | Technology | Location |
|---|---|---|
| Desktop shell (v1) | Tauri + Rust | `tauri/src-tauri/` |
| UI frontend | SvelteKit + TypeScript | `tauri/src/` |
| Desktop shell (v2) | Electron | `electron/` |
| UI frontend (v2) | Next.js | `electron/next-shell/` |
| Native browser core | C++ / CMake | `electron/bucks-native-browser/` |
| AI agent backend | Python / FastAPI | `agent/` |
| Soul identity | Python | `agent/soul/` |
| RAG memory | Python + ChromaDB | `agent/rag/` |
| Reinforcement loop | Python | `agent/rl/` |
| P2P agent network | Python + libp2p | `agent/p2p/` |
| IPFS / swarm (Electron) | Helia + libp2p JS | `electron/ipfs-node.js` |

## License

See [LICENSE](LICENSE).
