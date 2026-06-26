"""
Soul Engine — local inference server for the Bucks Browser (Electron).

Project NEXUS enhancements:
  • Every /agent call now returns a session_id and emits typed SSE events:
      {type:"thinking"|"tool_call"|"tool_result"|"browser_action"|"token"|"done"|"error"}
  • POST /agent/approve/{session_id}  — resume a paused browser action
  • POST /agent/cancel/{session_id}   — abort a running agent session
  • GET  /agent/goals                 — list persisted goals
  • POST /agent/goals                 — create / update a goal

Speaks the exact contract the renderer expects at http://localhost:8765:

    GET  /health                 -> { model, device, mode }
    GET  /router/classify?q=...  -> { domain: chat|agent|wallet, use_agent }
    POST /chat   { message, system, stream }  -> SSE { token } ... [DONE]
    POST /agent  { message, context, agentic, session_id? }
                                              -> SSE typed events ... [DONE]

Backed by Ollama (default model: hermes3:latest), which supports native
tool-calling. The /agent endpoint runs a tool loop over the existing
tools/registry.py so the agent can search the web, read pages, manage the
calendar, inspect the project, etc.

Run:
    .venv/bin/python -m uvicorn soul_engine:app --host 127.0.0.1 --port 8765
"""
from __future__ import annotations

import os
import json
import asyncio
import uuid
import sqlite3
import time
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse

from tools.registry import TOOLS

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("soul-engine")

OLLAMA = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
MODEL = os.getenv("BUCKS_MODEL", "hermes3:latest")
MAX_TOOL_STEPS = int(os.getenv("BUCKS_MAX_TOOL_STEPS", "5"))
TIMEOUT = httpx.Timeout(120.0, connect=5.0)

# ---------------------------------------------------------------------------
# Goal / session persistence (SQLite)
# ---------------------------------------------------------------------------
_DB_PATH = Path(os.getenv("BUCKS_DATA_DIR", Path.home() / ".bucks")) / "nexus_goals.db"
_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

def _init_db():
    con = sqlite3.connect(_DB_PATH)
    con.execute("""
        CREATE TABLE IF NOT EXISTS goals (
            session_id TEXT PRIMARY KEY,
            goal       TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'running',
            result     TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    con.commit()
    con.close()

_init_db()

def _upsert_goal(session_id: str, goal: str, status: str = "running", result: str | None = None):
    now = int(time.time())
    con = sqlite3.connect(_DB_PATH)
    con.execute("""
        INSERT INTO goals (session_id, goal, status, result, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            status=excluded.status, result=excluded.result, updated_at=excluded.updated_at
    """, (session_id, goal, status, result, now, now))
    con.commit()
    con.close()

def _list_goals(limit: int = 50) -> list[dict]:
    con = sqlite3.connect(_DB_PATH)
    rows = con.execute(
        "SELECT session_id, goal, status, result, created_at, updated_at FROM goals ORDER BY updated_at DESC LIMIT ?",
        (limit,)
    ).fetchall()
    con.close()
    return [
        {"session_id": r[0], "goal": r[1], "status": r[2],
         "result": r[3], "created_at": r[4], "updated_at": r[5]}
        for r in rows
    ]

# ---------------------------------------------------------------------------
# Tool schemas exposed to the model (safe / read-mostly subset of the registry)
# ---------------------------------------------------------------------------
TOOL_SCHEMAS: list[dict[str, Any]] = [
    {"type": "function", "function": {
        "name": "web_search",
        "description": "Search the web with DuckDuckGo. Use for current events, facts, prices, anything you don't know.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "The search query"},
        }, "required": ["query"]},
    }},
    {"type": "function", "function": {
        "name": "fetch_url",
        "description": "Fetch a URL and return its readable text content.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "Absolute http(s) URL"},
        }, "required": ["url"]},
    }},
    {"type": "function", "function": {
        "name": "extract_links",
        "description": "Extract the hyperlinks from a web page.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"},
        }, "required": ["url"]},
    }},
    {"type": "function", "function": {
        "name": "calendar_add",
        "description": "Add an event to the user's local calendar.",
        "parameters": {"type": "object", "properties": {
            "title": {"type": "string"},
            "date": {"type": "string", "description": "YYYY-MM-DD"},
            "time_str": {"type": "string", "description": "optional, e.g. 15:00"},
            "note": {"type": "string"},
        }, "required": ["title", "date"]},
    }},
    {"type": "function", "function": {
        "name": "calendar_list",
        "description": "List the user's calendar events, optionally filtered by a date prefix.",
        "parameters": {"type": "object", "properties": {
            "date": {"type": "string", "description": "optional YYYY-MM-DD prefix"},
        }},
    }},
    {"type": "function", "function": {
        "name": "list_directory",
        "description": "List files in a directory of the Bucks project.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "relative path, default '.'"},
        }},
    }},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Read a text file inside the Bucks project.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"},
        }, "required": ["path"]},
    }},
    {"type": "function", "function": {
        "name": "track_order",
        "description": "Track a shipment / order by id.",
        "parameters": {"type": "object", "properties": {
            "order_id": {"type": "string"},
            "carrier": {"type": "string"},
        }, "required": ["order_id"]},
    }},
    {"type": "function", "function": {
        "name": "product_search",
        "description": "Search the commerce product catalog.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"},
        }, "required": ["query"]},
    }},
]
EXPOSED_TOOLS = {s["function"]["name"] for s in TOOL_SCHEMAS}

# ---------------------------------------------------------------------------
# Agentic-browser tools — executed in the Electron renderer against the LIVE
# <webview>, not here. When the agent calls one of these, the /agent stream
# emits a {"type":"browser_action", id, name, args, needs_approval} event;
# the renderer runs it via agent-browser-control.js and POSTs the observation
# to /agent/tool_result.
# ---------------------------------------------------------------------------
def _fn(name: str, desc: str, props: dict, required: list[str]) -> dict[str, Any]:
    return {"type": "function", "function": {
        "name": name, "description": desc,
        "parameters": {"type": "object", "properties": props, "required": required},
    }}

BROWSER_TOOL_SCHEMAS: list[dict[str, Any]] = [
    _fn("browser_read_page",
        "Read an indexed accessibility snapshot of the current tab: URL, title, "
        "and interactive elements each with a [ref] number. Call this first, and "
        "again after any action, to see what you can click or type into.",
        {}, []),
    _fn("browser_navigate",
        "Navigate the current tab to a URL.",
        {"url": {"type": "string", "description": "Destination URL"}}, ["url"]),
    _fn("browser_click",
        "Click an element by its [ref] number from the latest snapshot.",
        {"ref": {"type": "integer", "description": "Element ref from browser_read_page"}}, ["ref"]),
    _fn("browser_type",
        "Type text into an input/textarea by its [ref] number.",
        {"ref": {"type": "integer"}, "text": {"type": "string"}}, ["ref", "text"]),
    _fn("browser_scroll",
        "Scroll the page up or down by one viewport.",
        {"direction": {"type": "string", "enum": ["up", "down"]}}, ["direction"]),
    _fn("browser_screenshot",
        "Capture a screenshot of the current tab for visual grounding.",
        {}, []),
]
BROWSER_TOOL_NAMES = {s["function"]["name"] for s in BROWSER_TOOL_SCHEMAS}

# Actions that change state — gated behind user confirmation in the renderer.
STATE_CHANGING_TOOLS = {"browser_click", "browser_type", "browser_navigate"}

# ---------------------------------------------------------------------------
# In-flight state: remote tool calls and session management
# ---------------------------------------------------------------------------
# Remote tool futures: request_id -> Future (resolved by POST /agent/tool_result)
_PENDING_TOOLS: dict[str, "asyncio.Future[Any]"] = {}

# NEXUS session registry: session_id -> asyncio.Event (cancel signal)
_SESSIONS: dict[str, asyncio.Event] = {}

# NEXUS approval futures: action_id -> Future (resolved by POST /agent/approve/{sid})
_PENDING_APPROVALS: dict[str, "asyncio.Future[bool]"] = {}

# Optional local vision model (Ollama) for screenshot grounding.
VISION_MODEL = os.getenv("BUCKS_VISION_MODEL", "llava")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Bucks Soul Engine — NEXUS")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


def sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj)}\n\n"


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> JSONResponse:
    mode = "offline"
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{OLLAMA}/api/tags")
            if r.status_code == 200:
                models = [m["name"] for m in r.json().get("models", [])]
                mode = "local_llm" if any(MODEL.split(":")[0] in m for m in models) else "no_model"
    except Exception:
        mode = "offline"
    return JSONResponse({"model": MODEL, "device": "metal", "mode": mode, "online": True})


# ---------------------------------------------------------------------------
# Router / classify  (fast heuristic — client times out at 2s)
# ---------------------------------------------------------------------------
WALLET_KW = ("wallet", "balance", "send awraq", "awraq", "my address", "receive",
             "transaction", "pay ", "transfer", "token balance")
AGENT_KW = ("search", "find ", "look up", "browse", "open ", "fetch", "latest",
            "news", "weather", "price", "track order", "track my", "calendar",
            "schedule", "remind", "list files", "read file", "in the project",
            "git ", "what's happening", "current ", "today")


@app.get("/router/classify")
async def classify(q: str = "") -> dict[str, Any]:
    ql = q.lower().strip()
    if ql.startswith("/"):
        return {"domain": "agent", "use_agent": True}
    if any(k in ql for k in WALLET_KW):
        return {"domain": "wallet", "use_agent": False}
    if any(k in ql for k in AGENT_KW):
        return {"domain": "agent", "use_agent": True}
    return {"domain": "chat", "use_agent": False}


# ---------------------------------------------------------------------------
# /chat — plain streaming completion
# ---------------------------------------------------------------------------
@app.post("/chat")
async def chat(req: Request) -> StreamingResponse:
    payload = await req.json()
    message = payload.get("message", "")
    system = payload.get("system", "")

    messages = []
    base_system = (
        "You are the Soul Engine, the local AI inside the Bucks Browser. "
        "Be concise, helpful, and direct."
    )
    messages.append({"role": "system", "content": (base_system + "\n\n" + system).strip()})
    messages.append({"role": "user", "content": message})

    async def gen() -> AsyncGenerator[str, None]:
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as c:
                async with c.stream(
                    "POST", f"{OLLAMA}/api/chat",
                    json={"model": MODEL, "messages": messages, "stream": True},
                ) as r:
                    async for line in r.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        tok = obj.get("message", {}).get("content", "")
                        if tok:
                            yield sse({"type": "token", "content": tok})
                        if obj.get("done"):
                            break
        except Exception as e:
            yield sse({"type": "error", "content": f"Soul Engine error: {e}"})
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# /agent — tool-calling loop, streams NEXUS typed events + final answer
# ---------------------------------------------------------------------------
async def run_tool(name: str, args: dict[str, Any]) -> str:
    tool = TOOLS.get(name)
    if not tool or name not in EXPOSED_TOOLS:
        return f"Unknown tool: {name}"
    try:
        return await tool.run(**args)
    except Exception as e:
        return f"Tool error ({name}): {e}"


@app.post("/agent/tool_result")
async def agent_tool_result(req: Request) -> JSONResponse:
    """The renderer posts the observation for a remote browser tool here."""
    body = await req.json()
    rid = body.get("id", "")
    fut = _PENDING_TOOLS.get(rid)
    if fut and not fut.done():
        fut.set_result(body.get("result", ""))
        return JSONResponse({"ok": True})
    return JSONResponse({"ok": False, "error": "unknown or completed request id"})


async def _await_remote_tool(rid: str, timeout: float = 90.0) -> Any:
    fut: "asyncio.Future[Any]" = asyncio.get_running_loop().create_future()
    _PENDING_TOOLS[rid] = fut
    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        return "Browser tool timed out waiting for the tab."
    finally:
        _PENDING_TOOLS.pop(rid, None)


# ── NEXUS: Approval Gate ──────────────────────────────────────────────────────

@app.post("/agent/approve/{session_id}")
async def agent_approve(session_id: str, req: Request) -> JSONResponse:
    """Renderer calls this to approve a pending browser_action."""
    body = await req.json()
    action_id = body.get("action_id", "")
    fut = _PENDING_APPROVALS.get(action_id)
    if fut and not fut.done():
        fut.set_result(True)
        return JSONResponse({"ok": True, "action": "approved"})
    return JSONResponse({"ok": False, "error": "unknown action_id"})


@app.post("/agent/deny/{session_id}")
async def agent_deny(session_id: str, req: Request) -> JSONResponse:
    """Renderer calls this to deny a pending browser_action."""
    body = await req.json()
    action_id = body.get("action_id", "")
    fut = _PENDING_APPROVALS.get(action_id)
    if fut and not fut.done():
        fut.set_result(False)
        return JSONResponse({"ok": True, "action": "denied"})
    return JSONResponse({"ok": False, "error": "unknown action_id"})


async def _await_approval(action_id: str, timeout: float = 30.0) -> bool:
    """Pause execution until the user approves or denies a browser action."""
    fut: "asyncio.Future[bool]" = asyncio.get_running_loop().create_future()
    _PENDING_APPROVALS[action_id] = fut
    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        return False  # Auto-deny on timeout
    finally:
        _PENDING_APPROVALS.pop(action_id, None)


# ── NEXUS: Cancel ─────────────────────────────────────────────────────────────

@app.post("/agent/cancel/{session_id}")
async def agent_cancel(session_id: str) -> JSONResponse:
    """Abort a running agent session."""
    cancel_evt = _SESSIONS.get(session_id)
    if cancel_evt:
        cancel_evt.set()
        _upsert_goal(session_id, "cancelled", "cancelled")
        return JSONResponse({"ok": True, "session_id": session_id})
    return JSONResponse({"ok": False, "error": "session not found"})


# ── NEXUS: Goal Persistence ───────────────────────────────────────────────────

@app.get("/agent/goals")
async def list_goals_endpoint() -> JSONResponse:
    return JSONResponse({"goals": _list_goals()})


@app.post("/agent/goals")
async def create_goal_endpoint(req: Request) -> JSONResponse:
    body = await req.json()
    session_id = body.get("session_id") or uuid.uuid4().hex
    goal = body.get("goal", "")
    status = body.get("status", "pending")
    _upsert_goal(session_id, goal, status)
    return JSONResponse({"ok": True, "session_id": session_id})


# ── NEXUS: Main Agent Endpoint ────────────────────────────────────────────────

@app.post("/agent")
async def agent(req: Request) -> StreamingResponse:
    payload = await req.json()
    message  = payload.get("message", "")
    context  = payload.get("context", "")
    agentic  = bool(payload.get("agentic", False))
    session_id = payload.get("session_id") or uuid.uuid4().hex

    # Register a cancel event for this session
    cancel_evt = asyncio.Event()
    _SESSIONS[session_id] = cancel_evt

    # Persist goal immediately
    _upsert_goal(session_id, message, "running")

    system = (
        "You are the Bucks Soul Engine agent. You can call tools to act on the "
        "user's behalf. Think step by step. When you have enough information, "
        "give a concise final answer to the user. Only call a tool when it is "
        "actually needed.\n\n"
        "CRITICAL RULES:\n"
        "1. Do NOT structure your final answers with 'Step 1', 'Step 2', etc. "
        "Instead, provide a natural, cohesive, and premium summary.\n"
        "2. Do NOT explicitly mention the tool names or result actions in your answer "
        "(e.g., do not say 'I ran web_search and got...'). Just present the findings naturally.\n"
        "3. Always suggest 1 or 2 relevant follow-up questions at the very end of your answer, "
        "wrapped individually in <followup>...</followup> XML tags (e.g., `<followup>What are the details of X?</followup>`). "
        "Do NOT write any conversational transition or introductory text referring to these questions (such as 'Here are some follow-up questions to consider' or 'You might want to ask:'). "
        "Just output the tags directly at the end.\n"
        "4. Include relevant clickable markdown links in your answer when citing sources (e.g. [BBC News](https://www.bbc.com))."
    )
    if agentic:
        system += (
            "\n\nYou can operate the user's live browser tab. Always call "
            "browser_read_page before acting so you have current [ref] numbers, "
            "and again after each action to observe the result. Click and type "
            "only via refs from the latest snapshot."
        )
    if context:
        system += f"\n\nCurrent page context:\n{context}"

    tools = list(TOOL_SCHEMAS) + (BROWSER_TOOL_SCHEMAS if agentic else [])

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
        {"role": "user", "content": message},
    ]

    async def gen() -> AsyncGenerator[str, None]:
        # Emit session_id first so the renderer can register cancel/approve handlers
        yield sse({"type": "session", "session_id": session_id})

        final_result = None
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as c:
                for step in range(MAX_TOOL_STEPS):
                    # Check cancellation
                    if cancel_evt.is_set():
                        yield sse({"type": "cancelled", "content": "Session cancelled by user."})
                        break

                    # Emit thinking indicator
                    yield sse({"type": "thinking", "content": "Reasoning…"})

                    # Inject a reinforcing prompt at the end of the history to ensure local LLM follows rules
                    temp_messages = []
                    for m in messages:
                        temp_messages.append(dict(m))
                    if temp_messages:
                        reminder = (
                            "\n\n(Rule Reminder: If writing your final answer, do NOT structure it with step numbers or mention tool names. "
                            "You MUST include relevant clickable markdown links like [Label](URL) for any web sources/links. "
                            "You MUST suggest 1 or 2 relevant follow-up questions at the very end of your answer, wrapped individually "
                            "in `<followup>Question text</followup>` XML tags. Do NOT write any transition or introductory text referring to "
                            "these questions.)"
                        )
                        temp_messages[-1]["content"] = temp_messages[-1].get("content", "") + reminder

                    r = await c.post(
                        f"{OLLAMA}/api/chat",
                        json={"model": MODEL, "messages": temp_messages,
                              "tools": tools, "stream": False},
                    )
                    r.raise_for_status()
                    msg = r.json().get("message", {})
                    tool_calls = msg.get("tool_calls") or []

                    if not tool_calls:
                        final = msg.get("content", "")
                        if final:
                            messages.append({"role": "assistant", "content": final})
                            final_result = final
                            # Stream the answer in chunks for smooth display
                            for piece in _chunk(final):
                                yield sse({"type": "token", "content": piece})
                        else:
                            yield sse({"type": "token", "content": "(no answer)"})
                        break

                    messages.append(msg)

                    for call in tool_calls:
                        if cancel_evt.is_set():
                            yield sse({"type": "cancelled", "content": "Session cancelled."})
                            return

                        fn   = call.get("function", {})
                        name = fn.get("name", "")
                        args = fn.get("arguments", {}) or {}
                        if isinstance(args, str):
                            try:
                                args = json.loads(args)
                            except json.JSONDecodeError:
                                args = {}

                        arg_str = ", ".join(f"{k}={v!r}" for k, v in args.items())

                        # ── NEXUS typed tool_call event ──────────────────────
                        yield sse({
                            "type": "tool_call",
                            "name": name,
                            "args": args,
                            "label": f"{name}({arg_str})"
                        })

                        if name in BROWSER_TOOL_NAMES:
                            rid = uuid.uuid4().hex
                            action_id = uuid.uuid4().hex
                            needs_approval = name in STATE_CHANGING_TOOLS

                            # ── NEXUS browser_action event ───────────────────
                            yield sse({
                                "type":           "browser_action",
                                "id":             rid,
                                "action_id":      action_id,
                                "name":           name,
                                "args":           args,
                                "needs_approval": needs_approval,
                                "session_id":     session_id,
                                "label":          _action_label(name, args),
                            })

                            # Gate: wait for user approval if state-changing
                            if needs_approval:
                                approved = await _await_approval(action_id, timeout=30.0)
                                if not approved:
                                    result = f"Action '{name}' denied by user."
                                    yield sse({
                                        "type":    "tool_result",
                                        "name":    name,
                                        "content": result,
                                        "denied":  True,
                                    })
                                    messages.append({"role": "tool", "content": result, "name": name})
                                    continue

                            raw = await _await_remote_tool(rid)

                            if isinstance(raw, dict) and raw.get("screenshot_b64"):
                                result = await describe_image_local(raw["screenshot_b64"], c)
                            elif isinstance(raw, dict):
                                result = str(raw.get("text") or raw.get("snapshot") or raw)
                            else:
                                result = str(raw)
                        else:
                            result = await run_tool(name, args)

                        preview = result[:300] + ("…" if len(result) > 300 else "")

                        # ── NEXUS tool_result event ──────────────────────────
                        yield sse({
                            "type":    "tool_result",
                            "name":    name,
                            "content": preview,
                        })
                        messages.append({"role": "tool", "content": result[:4000], "name": name})
                else:
                    final_result = "Reached the maximum number of reasoning steps."
                    yield sse({"type": "token", "content": "\n[Reached tool-step limit.]"})

        except Exception as e:
            yield sse({"type": "error", "content": f"Agent error: {e}"})
            _upsert_goal(session_id, message, "error", str(e))
        else:
            # ── NEXUS done event ─────────────────────────────────────────────
            yield sse({"type": "done", "session_id": session_id, "result": final_result or ""})
            _upsert_goal(session_id, message, "completed", final_result)
        finally:
            _SESSIONS.pop(session_id, None)

        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"X-Session-Id": session_id})


def _action_label(name: str, args: dict) -> str:
    """Human-readable label for a browser action."""
    labels = {
        "browser_read_page":  "Read current page",
        "browser_navigate":   f"Navigate to {args.get('url', '?')}",
        "browser_click":      f"Click element [{args.get('ref', '?')}]",
        "browser_type":       f"Type \"{str(args.get('text',''))[:40]}\" into [{args.get('ref','?')}]",
        "browser_scroll":     f"Scroll {args.get('direction', '?')}",
        "browser_screenshot": "Take screenshot",
    }
    return labels.get(name, name)


async def describe_image_local(b64: str, client: "httpx.AsyncClient") -> str:
    """Describe a screenshot with the local Ollama vision model (inbuilt)."""
    try:
        r = await client.post(
            f"{OLLAMA}/api/generate",
            json={
                "model": VISION_MODEL,
                "prompt": ("Describe this web page screenshot for a browser agent: "
                           "overall layout, key headings and text, and the visible "
                           "buttons, links, and input fields."),
                "images": [b64],
                "stream": False,
            },
        )
        r.raise_for_status()
        desc = (r.json().get("response") or "").strip()
        return "[Screenshot] " + desc if desc else "[Screenshot captured, no description]"
    except Exception as e:
        return (f"Screenshot captured but local vision model '{VISION_MODEL}' is "
                f"unavailable ({e}). Use browser_read_page for page structure instead.")


def _chunk(text: str, size: int = 24):
    """Split a final answer into small pieces for smooth streaming."""
    for i in range(0, len(text), size):
        yield text[i:i + size]


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
