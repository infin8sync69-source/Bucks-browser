> ⚠️ **SUPERSEDED (2026-07-15).** This guide predates the embedded edge model and still
> mandates Ollama and references removed components (tauri, Next.js shell). Follow the
> root [README](../README.md) instead. Kept only as a historical reference.

# Unified Setup & Run Guide — Bucks Browser

This guide explains how to set up, build, and run the entire unified **Bucks Browser** project on a fresh machine. The repository contains the desktop shell, the AI agent backend, and the decentralized IPFS file manager.

---

## 📂 Repository Layout

```text
Bucks-browser/
├── electron/         # Desktop shell (Electron, Next.js dashboard, native bindings)
├── agent/            # Shared Python AI agent server (RAG, P2P swarm, local tools)
├── ipfs/             # IPFS Cluster NIM-style File Manager (spawning auto-proxy on :3939)
├── tauri/            # Legacy Tauri Svelte browser core (v1)
├── assets/           # Shared icons and asset configurations
├── scripts/          # Workspace batch launchers and utility scripts
├── SETUP.md          # This setup guide
└── README.md         # General repository overview
```

---

## 🛠️ Prerequisites

Ensure you have the following installed on your machine:
1. **Node.js** (v18.0.0 or higher) & **npm**
2. **Python** (v3.11.x or v3.12.x; Python 3.14+ is currently not compatible with CrewAI)
3. **Ollama** (for local agent intelligence)
   - [Download Ollama](https://ollama.com/)
   - Start the Ollama app, then pull the necessary models:
     ```bash
     ollama pull hermes3:latest
     ollama pull qwen2.5:3b
     ```

---

## 🚀 Setup Steps

### 1. Root Repository Swarm Dependencies
In the root directory of the workspace, install the shared libp2p/Helia swarm dependencies:
```bash
npm install
```

### 2. Electron Frontend & Dashboard
Navigate to the `electron` directory and install the Node dependencies:
```bash
cd electron
npm install
```

### 3. IPFS Commander Server
Navigate to the consolidated `ipfs` directory and install the proxy server dependencies:
```bash
cd ../ipfs
npm install
```

### 4. AI Agent Backend
Setup the Python virtual environment and install the FastAPI backend dependencies:
```bash
cd ../agent

# Create the virtualenv (using python3.11 or python3.12)
python3.11 -m venv .venv
source .venv/bin/activate

# Install dependencies (utilizing PyPI simple mirror to avoid package backtracking)
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple fastapi "uvicorn[standard]" httpx beautifulsoup4 duckduckgo-search python-dotenv pydantic openai cryptography aiohttp python-multipart
```

---

## 🟢 Running the Project

To run all components together, start the three separate layers. It is recommended to run each in a separate terminal window (or background processes):

### Terminal 1: Soul Engine (Port 8765)
The Soul Engine handles direct tool calls (web searching, browser snapshotting) and streams typed trace events.
```bash
cd agent
./start_soul_engine.sh
```

### Terminal 2: Agent Server v2 (Port 3000)
The Agent Server hosts the RAG memory indexing, WorldSoul identity registry, and P2P gossipsub swarm bridge.
```bash
cd agent
./start_agent_server.sh
```

### Terminal 3: Electron Browser
Starts the browser desktop application. On launch, the Electron app will **automatically spawn** the IPFS Commander proxy server (`ipfs/server.js`) on port 3939:
```bash
cd electron
npm start
```

---

## 🔍 Verification

Once the Electron app starts up:
1. **NEXUS Agent Chat**: Click the bottom chat input (or press `⌘+Shift+A` for the floating NEXUS panel) and type: `search for the latest Space news`.
   - You should see the **Thinking...** steps, **Tool Call (web_search)** steps, and the final answer complete with **clickable source links** and **follow-up chips**!
2. **IPFS File Manager**: Click **Files** on the left side navigation panel.
   - Nimble Commander should load your local folder pane directly and let you browse local/dWeb directories dynamically.
