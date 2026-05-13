"""
Model Configuration — Supports LitAI, Ollama, NIM, and SLM (Qwen2.5:3b on-device)
"""
import os
from typing import Literal

MODEL_PROVIDER = os.getenv("MODEL_PROVIDER", "ollama").lower()  # "ollama", "litai", "nim", "slm"
LITAI_API_KEY = os.getenv("LITAI_API_KEY", "")
LITAI_BASE_URL = os.getenv("LITAI_BASE_URL", "https://lightning.ai/api/v1")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

# NVIDIA NIM Configuration
NGC_API_KEY = os.getenv("NGC_API_KEY", "")
NIM_BASE_URL = os.getenv("NIM_BASE_URL", "http://localhost:8000/v1")
NIM_MODEL = os.getenv("NIM_MODEL", "deepseek-ai/deepseek-v4-pro")

# SLM — on-device small language model via Ollama
# Default: qwen2.5:3b when pulled; falls back to gpt-oss:120b-cloud if present
SLM_MODEL = os.getenv("SLM_MODEL", "qwen2.5:3b")
SLM_ENABLED = os.getenv("SLM_ENABLED", "true").lower() == "true"

# Model mappings
MODELS = {
    "code": {
        "ollama": "deepseek-coder-v2",
        "litai": "lightning-ai/deepseek-v4-pro",
        "nim": NIM_MODEL,
        "slm": SLM_MODEL,
    },
    "general": {
        "ollama": "llama3.1",
        "litai": "lightning-ai/deepseek-v4-pro",
        "nim": NIM_MODEL,
        "slm": SLM_MODEL,
    },
    "slm": {
        "ollama": SLM_MODEL,
        "litai": SLM_MODEL,
        "nim": SLM_MODEL,
        "slm": SLM_MODEL,
    },
}

PROVIDERS = ["ollama", "litai", "nim", "slm"]


def get_model_name(task_type: Literal["code", "general", "slm"]) -> str:
    """Get model name for the current provider"""
    provider = MODEL_PROVIDER
    if provider not in PROVIDERS:
        raise ValueError(f"Unknown provider: {provider}")
    return MODELS[task_type][provider]


def get_provider() -> str:
    return MODEL_PROVIDER


def set_provider(provider: str):
    global MODEL_PROVIDER
    if provider not in PROVIDERS:
        raise ValueError(f"Unknown provider: {provider}")
    MODEL_PROVIDER = provider


def is_slm_available() -> bool:
    return SLM_ENABLED
