"""
Model Configuration — Edge-first SLM selection + cloud fallback.

Edge SLMs (via Ollama, fully local, no API key):
  qwen2.5:3b    — 1.9 GB  — strong Arabic/multilingual, default
  phi3:mini     — 2.3 GB  — best reasoning/param ratio (Microsoft, Apache 2.0)
  llama3.2:1b   — 0.6 GB  — ultra-light, Raspberry Pi class
  llama3.2:3b   — 1.9 GB  — balanced quality/size
  gemma2:2b     — 1.6 GB  — Google, multilingual
  smollm2:1.7b  — 1.0 GB  — HuggingFace, Apache 2.0, very efficient
  qwen2.5:1.5b  — 1.0 GB  — smaller Qwen, good Arabic

Selection priority: RAM-based auto-select or explicit SLM_MODEL env var.
"""
import os
import platform
from typing import Literal

# ── Provider ──────────────────────────────────────────────────────────────────
MODEL_PROVIDER  = os.getenv("MODEL_PROVIDER", "ollama").lower()
LITAI_API_KEY   = os.getenv("LITAI_API_KEY", "")
LITAI_BASE_URL  = os.getenv("LITAI_BASE_URL", "https://lightning.ai/api/v1")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

NGC_API_KEY  = os.getenv("NGC_API_KEY", "")
NIM_BASE_URL = os.getenv("NIM_BASE_URL", "http://localhost:8000/v1")
NIM_MODEL    = os.getenv("NIM_MODEL", "deepseek-ai/deepseek-v4-pro")

# ── Edge SLM catalogue ────────────────────────────────────────────────────────
# Ordered from lightest to heaviest. All run via Ollama locally.
EDGE_SLMS = [
    {"id": "llama3.2:1b",   "size_gb": 0.6,  "license": "llama",   "arabic": False},
    {"id": "smollm2:1.7b",  "size_gb": 1.0,  "license": "apache2", "arabic": False},
    {"id": "qwen2.5:1.5b",  "size_gb": 1.0,  "license": "apache2", "arabic": True},
    {"id": "gemma2:2b",     "size_gb": 1.6,  "license": "gemma",   "arabic": False},
    {"id": "llama3.2:3b",   "size_gb": 1.9,  "license": "llama",   "arabic": False},
    {"id": "qwen2.5:3b",    "size_gb": 1.9,  "license": "apache2", "arabic": True},
    {"id": "phi3:mini",     "size_gb": 2.3,  "license": "apache2", "arabic": False},
]

# Default: qwen2.5:3b — best Arabic support for Quran-grounded reasoning
SLM_MODEL   = os.getenv("SLM_MODEL", "qwen2.5:3b")
SLM_ENABLED = os.getenv("SLM_ENABLED", "true").lower() == "true"


def auto_select_slm(available_ram_gb: float = 4.0, require_arabic: bool = True) -> str:
    """
    Pick the best edge SLM that fits in available RAM.
    Prefers Arabic-capable models when require_arabic=True (needed for Quran soul).
    Returns model id string for Ollama.
    """
    candidates = [m for m in EDGE_SLMS if m["size_gb"] * 1.5 <= available_ram_gb]
    if not candidates:
        return "llama3.2:1b"  # always fits on any device
    if require_arabic:
        arabic_candidates = [m for m in candidates if m["arabic"]]
        if arabic_candidates:
            return arabic_candidates[-1]["id"]  # largest that fits + arabic
    return candidates[-1]["id"]  # largest that fits


def get_available_ram_gb() -> float:
    """Estimate available RAM on this device."""
    try:
        import psutil
        return psutil.virtual_memory().available / (1024 ** 3)
    except ImportError:
        return 4.0  # assume 4 GB if psutil not available


# ── Model mappings ────────────────────────────────────────────────────────────
MODELS = {
    "code": {
        "ollama": "deepseek-coder-v2",
        "litai":  "lightning-ai/deepseek-v4-pro",
        "nim":    NIM_MODEL,
        "slm":    SLM_MODEL,
        "edge":   SLM_MODEL,
    },
    "general": {
        "ollama": "llama3.1",
        "litai":  "lightning-ai/deepseek-v4-pro",
        "nim":    NIM_MODEL,
        "slm":    SLM_MODEL,
        "edge":   SLM_MODEL,
    },
    "quran": {
        "ollama": "qwen2.5:3b",    # Arabic support preferred
        "litai":  SLM_MODEL,
        "nim":    NIM_MODEL,
        "slm":    "qwen2.5:3b",
        "edge":   "qwen2.5:3b",
    },
    "slm": {
        "ollama": SLM_MODEL,
        "litai":  SLM_MODEL,
        "nim":    SLM_MODEL,
        "slm":    SLM_MODEL,
        "edge":   SLM_MODEL,
    },
}

PROVIDERS = ["ollama", "litai", "nim", "slm", "edge"]


def get_model_name(task_type: Literal["code", "general", "slm", "quran"]) -> str:
    provider = MODEL_PROVIDER if MODEL_PROVIDER in PROVIDERS else "ollama"
    return MODELS[task_type][provider]


def get_provider() -> str:
    return MODEL_PROVIDER


def set_provider(provider: str) -> None:
    global MODEL_PROVIDER
    if provider not in PROVIDERS:
        raise ValueError(f"Unknown provider: {provider}")
    MODEL_PROVIDER = provider


def is_slm_available() -> bool:
    return SLM_ENABLED


# ── Soul / Frozen Memory ───────────────────────────────────────────────────────
SOUL_LOCALITY      = os.getenv("SOUL_LOCALITY",      "global")
SOUL_CIDN          = os.getenv("SOUL_CIDN",          "mainnet")
FROZEN_MEMORY_PATH = os.getenv("FROZEN_MEMORY_PATH", "")

# ── WorldSoul (Quran) ──────────────────────────────────────────────────────────
WORLD_SOUL_ENABLED      = os.getenv("WORLD_SOUL_ENABLED", "true").lower() == "true"
QURAN_RAG_EMBED_BATCH   = int(os.getenv("QURAN_RAG_EMBED_BATCH", "50"))

# ── RAG / Floating Memory ──────────────────────────────────────────────────────
RAG_EMBED_MODEL = os.getenv("RAG_EMBED_MODEL", "nomic-embed-text")
RAG_TOP_K       = int(os.getenv("RAG_TOP_K",   "5"))
IPFS_API_URL    = os.getenv("IPFS_API_URL",    "http://localhost:5001")

# ── Reinforcement Learning ─────────────────────────────────────────────────────
RL_ALPHA   = float(os.getenv("RL_ALPHA",   "0.1"))
RL_EPSILON = float(os.getenv("RL_EPSILON", "0.1"))

# ── Swarm ──────────────────────────────────────────────────────────────────────
SWARM_ENABLED        = os.getenv("SWARM_ENABLED", "true").lower() == "true"
SWARM_AGENT_PORT     = int(os.getenv("SWARM_AGENT_PORT", "3000"))
SWARM_MAX_DELEGATION = int(os.getenv("SWARM_MAX_DELEGATION", "3"))
