"""
Unified model engine — one interface over every inference backend.

soul_engine.py (the LIVE agent path) talks ONLY to this module for
generation, so switching between the embedded edge model, a local Ollama
daemon, or an OpenAI-compatible endpoint (LitAI / NVIDIA NIM) is a single
runtime choice rather than the scattered `if _use_embedded()` branches it
replaces.

(Not to be confused with the legacy `engine.py`, which is the older
ollama-only "Agent Engine v2" wired to the dormant server_lite.py path.)

Design goals:
  • Edge stays the default (inbuilt-first, no external service). The others
    are explicit opt-in and only appear "configured" when their key/URL is set.
  • Two call shapes cover everything soul_engine needs:
        chat_stream(messages)            -> async token generator (plain text)
        chat_with_tools(messages, tools) -> one assistant message dict
    Both normalize to the Ollama/OpenAI-ish message shape soul_engine already
    parses ({"role","content","tool_calls":[{"function":{"name","arguments"}}]};
    its parser already handles arguments as either a dict or a JSON string).
  • The active provider is a runtime choice, persisted to
    ~/.bucks/selected_provider.txt so it survives restarts, falling back to
    config.MODEL_PROVIDER (which itself comes from the env).
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

import httpx

import config
import edge_llm

log = logging.getLogger("soul-engine.model_engine")

TIMEOUT = httpx.Timeout(120.0, connect=5.0)

_BUCKS_HOME = Path(os.getenv("BUCKS_HOME", os.getenv("BUCKS_DATA_DIR", Path.home() / ".bucks")))
_PROVIDER_FILE = _BUCKS_HOME / "selected_provider.txt"

# Human-facing provider descriptors. "openai_compatible" providers share one
# HTTP dispatch path (they all speak /chat/completions); only base_url/key/model
# differ. "slm" is a legacy alias that runs through the Ollama runtime.
_PROVIDER_META = {
    "edge":   {"label": "Embedded (on-device)",  "kind": "edge",              "inbuilt": True},
    "ollama": {"label": "Ollama (local daemon)",  "kind": "ollama",            "inbuilt": False},
    "slm":    {"label": "Ollama SLM",             "kind": "ollama",            "inbuilt": False},
    "litai":  {"label": "LitAI (cloud)",          "kind": "openai_compatible", "inbuilt": False},
    "nim":    {"label": "NVIDIA NIM",             "kind": "openai_compatible", "inbuilt": False},
}


# ── Provider selection ──────────────────────────────────────────────────────
def _read_saved_provider() -> Optional[str]:
    try:
        val = _PROVIDER_FILE.read_text().strip().lower()
        return val if val in config.PROVIDERS else None
    except Exception:
        return None


def current_provider() -> str:
    """Active provider: persisted UI choice > config/env default."""
    return _read_saved_provider() or config.get_provider()


def _provider_configured(name: str) -> bool:
    """Whether a provider could actually serve a request right now — used to
    grey out un-configured choices in the switcher rather than let a user pick
    a cloud provider with no key set."""
    kind = _PROVIDER_META.get(name, {}).get("kind")
    if kind == "edge":
        return True
    if kind == "ollama":
        return bool(config.OLLAMA_BASE_URL)
    if name == "litai":
        return bool(config.LITAI_API_KEY)
    if name == "nim":
        return bool(config.NIM_BASE_URL)
    return False


def available_providers() -> list[dict]:
    active = current_provider()
    out = []
    for name in config.PROVIDERS:
        meta = _PROVIDER_META.get(name, {})
        out.append({
            "id": name,
            "label": meta.get("label", name),
            "inbuilt": meta.get("inbuilt", False),
            "configured": _provider_configured(name),
            "current": name == active,
        })
    # inbuilt first, then configured, then the rest
    out.sort(key=lambda p: (not p["inbuilt"], not p["configured"]))
    return out


def switch_provider(name: str) -> dict:
    name = (name or "").lower()
    if name not in config.PROVIDERS:
        return {"ok": False, "error": f"unknown provider: {name}"}
    if not _provider_configured(name):
        return {"ok": False, "error": f"provider '{name}' is not configured (missing key or endpoint)"}
    try:
        _BUCKS_HOME.mkdir(parents=True, exist_ok=True)
        _PROVIDER_FILE.write_text(name)
    except Exception as e:
        log.warning("Could not persist provider selection: %s", e)
    config.set_provider(name)
    return {"ok": True, "provider": name}


def _kind() -> str:
    return _PROVIDER_META.get(current_provider(), {}).get("kind", "ollama")


def _openai_endpoint() -> tuple[str, str, str]:
    """(base_url, api_key, model) for the active OpenAI-compatible provider."""
    name = current_provider()
    if name == "litai":
        return config.LITAI_BASE_URL, config.LITAI_API_KEY, config.get_model_name("general")
    # nim (or any other openai_compatible)
    return config.NIM_BASE_URL, (config.NGC_API_KEY or "no-key-required"), config.NIM_MODEL


def _ollama_model() -> str:
    prov = current_provider()
    if prov == "slm":
        return config.SLM_MODEL
    return config.get_model_name("general")


# ── Generation: plain streaming ─────────────────────────────────────────────
async def chat_stream(messages: list[dict]) -> AsyncGenerator[str, None]:
    """Yield plain-text tokens from the active provider (no tools)."""
    kind = _kind()

    if kind == "edge":
        async for tok in edge_llm.chat_stream(messages):
            yield tok
        return

    if kind == "ollama":
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            async with c.stream(
                "POST", f"{config.OLLAMA_BASE_URL}/api/chat",
                json={"model": _ollama_model(), "messages": messages, "stream": True},
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
                        yield tok
                    if obj.get("done"):
                        break
        return

    # openai_compatible (litai / nim)
    base, key, model = _openai_endpoint()
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        async with c.stream(
            "POST", f"{base.rstrip('/')}/chat/completions",
            headers=headers,
            json={"model": model, "messages": messages, "stream": True},
        ) as r:
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[len("data:"):].strip()
                if payload == "[DONE]":
                    break
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                tok = (obj.get("choices") or [{}])[0].get("delta", {}).get("content", "")
                if tok:
                    yield tok


# ── Generation: tool-calling (non-streaming) ────────────────────────────────
async def chat_with_tools(messages: list[dict], tools: list[dict]) -> dict[str, Any]:
    """Return a single assistant message dict from the active provider. Shape is
    normalized so soul_engine's existing tool_calls parsing works unchanged."""
    kind = _kind()

    if kind == "edge":
        return await edge_llm.chat_with_tools(messages, tools)

    if kind == "ollama":
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.post(
                f"{config.OLLAMA_BASE_URL}/api/chat",
                json={"model": _ollama_model(), "messages": messages,
                      "tools": tools, "stream": False},
            )
            r.raise_for_status()
            return r.json().get("message", {}) or {}

    # openai_compatible (litai / nim)
    base, key, model = _openai_endpoint()
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(
            f"{base.rstrip('/')}/chat/completions",
            headers=headers,
            json={"model": model, "messages": messages, "tools": tools,
                  "tool_choice": "auto", "stream": False},
        )
        r.raise_for_status()
        choices = r.json().get("choices") or [{}]
        return choices[0].get("message", {}) or {}


# ── Status helpers for /agent/status and the UI ─────────────────────────────
def active_model_label() -> str:
    """Which concrete model the active provider will use — for status display."""
    kind = _kind()
    if kind == "edge":
        return edge_llm.current_model_id() or edge_llm.resolve_model_id()
    if kind == "ollama":
        return _ollama_model()
    _, _, model = _openai_endpoint()
    return model
