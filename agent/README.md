# agent/: the Soul Engine

The Python agent behind the browser's **Soul Engine** provider: a FastAPI server
(`soul_engine.py`) with a tool loop (web search and reading, IPFS, weather, shopping lookups,
calendar, files in a workspace folder), a small retrieval memory, a routing policy that learns
from thumbs up/down, and generative UI: answers can carry cards (tables, charts, checklists,
timelines, …) next to the text.

It came from the Electron "Bucks Core" app (Bucks-App v1.1.0, kept in
`infin8sync69-source/buckscore` under `Bucks-App/agent/`), where it was started by
`electron/soul-engine-supervisor.js`. See [docs/ALIGNMENT.md](../docs/ALIGNMENT.md) for what
changed on the way.

## How the browser runs it

`src/main/agent/soul-engine.js` starts it while **Soul Engine** is the agent chosen in
Settings → Agent:

```
python -m uvicorn soul_engine:app --host 127.0.0.1 --port <free port>
```

- **Python.** The first match of: Settings `agent.soul.python`, `$BUCKS_SOUL_PYTHON`, the private
  environment that **Install** in Settings creates (`<profile>/soul-engine/venv`), then
  `agent/.venv` (what `start_soul_engine.sh` creates in a source checkout). Install needs a system
  Python 3.10 or newer and installs `requirements-engine.txt`, plus `requirements-edge.txt` for the
  on-device model.
- **Token.** A new random token at every start, in `BUCKS_SOUL_TOKEN`. Every request except
  `GET /health` must send `Authorization: Bearer <token>` (`local_auth.py`); web pages cannot.
- **Data.** `BUCKS_DATA_DIR` and `BUCKS_HOME` point at `<profile>/soul-engine/`: goals and
  sessions database, learned routing weights, the agent's signing key, downloaded model weights.
  File tools only see `<profile>/soul-engine/workspace/` unless you set `BUCKS_ALLOWED_ROOTS`
  yourself.
- **Backend.** `MODEL_PROVIDER` from Settings: `edge` (embedded model, the default), `ollama`, or
  the opt-in cloud backends `nim` and `litai`, whose keys go in `<profile>/soul-engine/.env`.
- **Lifecycle.** Health is polled; a crash is restarted three times with back-off; quitting the
  browser or choosing another agent stops it.

## Endpoints the browser uses

| Endpoint | Use |
|---|---|
| `GET /health` (open) | `{ model, mode }`, where mode is `local_llm`, `cloud_llm`, `loading`, `error`, `no_model`, `unconfigured` or `offline` |
| `GET /providers`, `POST /providers/select` | keep the engine's backend in line with Settings |
| `POST /agent` | the question, page context, `agentic: false`; answers as server-sent events (`session`, `thinking`, `tool_call`, `tool_result`, `ui_component`, `browser_action`, `token`, `error`, `done`) |
| `POST /agent/deny/{session}` | decline an action that needs approval (there is no approval UI in the browser yet) |
| `POST /agent/feedback` | thumbs up/down for an answer |
| `GET /models` | embedded models the engine knows |

The engine has more (workflows, goals, chat threads, soul identity and peers); see the docstring
at the top of `soul_engine.py`.

## Running it by hand

```sh
cd agent
./start_soul_engine.sh                      # creates .venv on first run, embedded model
MODEL_PROVIDER=ollama ./start_soul_engine.sh  # use a local Ollama server instead
```

Without `BUCKS_SOUL_TOKEN` the server accepts any caller and logs a warning; that mode exists for
development and the older Bucks-App launcher. Set a token if anything else runs on the machine.

`mcp_server.py` (Model Context Protocol, port 9999) uses the same gate with `BUCKS_MCP_TOKEN`. The
browser does not start it.

## Tests

```sh
python -m venv .venv && .venv/bin/pip install -r requirements-engine.txt pytest pytest-asyncio
.venv/bin/python -m pytest -q tests/test_local_security.py tests/test_nexus_endpoints.py
```

`tests/test_ipfs_skills.py` needs a running IPFS API. The browser side has its own tests,
including one against this engine (`test/unit/agent/soul.integration.test.js`, run with
`BUCKS_SOUL_PYTHON=agent/.venv/bin/python npm test`).

## Other servers in this folder

`server.py` and `server_lite.py` are the CrewAI/LangChain "swarm" servers that the browser's
**Remote** agent provider talks to (`POST /api/v1/swarm/task`). They need the full
`requirements.txt` and are not started by the browser.
