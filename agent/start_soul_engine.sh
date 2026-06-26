#!/usr/bin/env bash
#
# start_soul_engine.sh — launch the Bucks Soul Engine on :8765, backed by
# a local Ollama model (default hermes3:latest).
#
# Usage:
#   ./start_soul_engine.sh                 # uses hermes3:latest
#   BUCKS_MODEL=llama3:latest ./start_soul_engine.sh
#
set -euo pipefail
cd "$(dirname "$0")"

MODEL="${BUCKS_MODEL:-hermes3:latest}"
PORT="${BUCKS_PORT:-8765}"

# 1. Ensure a venv with deps exists
if [ ! -x ".venv/bin/python" ]; then
  echo "→ Creating venv and installing deps…"
  PYTHON_EXE="python3"
  if command -v python3.11 &>/dev/null; then
    PYTHON_EXE="python3.11"
  elif command -v python3.12 &>/dev/null; then
    PYTHON_EXE="python3.12"
  fi
  echo "→ Using Python executable: $PYTHON_EXE"
  $PYTHON_EXE -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet fastapi "uvicorn[standard]" httpx beautifulsoup4 ddgs
fi

# 2. Ensure Ollama is reachable and the model is present
if ! curl -s --max-time 3 http://localhost:11434/api/tags >/dev/null; then
  echo "⚠️  Ollama isn't running. Start it first:  ollama serve"
  exit 1
fi
if ! curl -s http://localhost:11434/api/tags | grep -q "${MODEL%%:*}"; then
  echo "→ Pulling model ${MODEL} (one-time)…"
  ollama pull "${MODEL}"
fi

echo "→ Soul Engine starting on http://localhost:${PORT} (model: ${MODEL})"
BUCKS_MODEL="${MODEL}" exec .venv/bin/python -m uvicorn soul_engine:app \
  --host 127.0.0.1 --port "${PORT}"
