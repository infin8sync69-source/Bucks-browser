#!/usr/bin/env bash
#
# Bucks — one-command installer (macOS / Linux)
#
#   ./install.sh          install, then launch
#   ./install.sh --no-run  install only
#
# Collapses the multi-step manual setup (electron npm install, Python
# venv + deps, first launch) into a single idempotent run.
# Safe to re-run: every step detects existing state and skips.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

RUN_APP=1
[ "${1:-}" = "--no-run" ] && RUN_APP=0

# ── output helpers ───────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  GRN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; VIO=$'\033[35m'
else
  B=""; DIM=""; R=""; GRN=""; YEL=""; RED=""; VIO=""
fi
step() { printf "\n${VIO}${B}▸ %s${R}\n" "$1"; }
ok()   { printf "  ${GRN}✓${R} %s\n" "$1"; }
warn() { printf "  ${YEL}!${R} %s\n" "$1"; }
die()  { printf "\n${RED}${B}✗ %s${R}\n" "$1" >&2; shift; for l in "$@"; do printf "    %s\n" "$l" >&2; done; exit 1; }

printf "\n${B}Bucks${R} ${DIM}— decentralised, AI-native browser${R}\n"
printf "${DIM}%s${R}\n" "$REPO_DIR"

# ── 1. Node ──────────────────────────────────────────────────────────────────
step "Checking Node.js"
command -v node >/dev/null 2>&1 || die "Node.js is not installed." \
  "Bucks needs Node 18 or newer." \
  "Install it from https://nodejs.org  (or: brew install node)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node $(node -v) is too old." \
  "Bucks needs Node 18 or newer. Upgrade from https://nodejs.org"
ok "Node $(node -v)"

# ── 2. Python ────────────────────────────────────────────────────────────────
# The agent stack (crewai, chromadb, llama-cpp-python) does not support 3.13+.
# A plain `python3` on a current macOS is often 3.14, which creates a venv fine
# and then fails deep inside pip with an unreadable build error — so the version
# is checked up front and reported plainly instead.
step "Checking Python"
PY=""
for c in python3.12 python3.11 python3.10 python3; do
  command -v "$c" >/dev/null 2>&1 || continue
  v="$("$c" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "")"
  case "$v" in
    3.10|3.11|3.12) PY="$c"; PYV="$v"; break ;;
  esac
done

if [ -z "$PY" ]; then
  found="$(python3 --version 2>&1 || echo 'none')"
  die "No compatible Python found (need 3.10–3.12; you have: $found)." \
    "The AI agent's dependencies do not support Python 3.13+ yet." \
    "" \
    "macOS:  brew install python@3.12" \
    "Linux:  sudo apt install python3.12 python3.12-venv" \
    "" \
    "Then re-run ./install.sh — it will pick up the new interpreter automatically."
fi
ok "Python $PYV ($PY)"

# ── 3. JS dependencies ───────────────────────────────────────────────────────
step "Installing browser dependencies"
if [ -d electron/node_modules ]; then
  ok "electron packages already present"
else
  printf "  ${DIM}npm install (electron) — this is the big one, a few minutes…${R}\n"
  (cd electron && npm install --no-audit --no-fund --loglevel=error)
  ok "electron packages installed"
fi

# ── 4. Python agent ──────────────────────────────────────────────────────────
step "Setting up the AI agent"
if [ -x agent/.venv/bin/python ]; then
  ok "virtualenv already present"
else
  printf "  ${DIM}creating virtualenv…${R}\n"
  "$PY" -m venv agent/.venv
  ok "virtualenv created"
fi

if agent/.venv/bin/python -c "import fastapi, llama_cpp" >/dev/null 2>&1; then
  ok "agent dependencies already installed"
else
  printf "  ${DIM}installing agent dependencies — several minutes (llama-cpp builds native code)…${R}\n"
  agent/.venv/bin/pip install --quiet --upgrade pip
  if ! agent/.venv/bin/pip install --quiet -r agent/requirements.txt; then
    die "Agent dependency install failed." \
      "Re-run with visible output to see why:" \
      "  agent/.venv/bin/pip install -r agent/requirements.txt"
  fi
  ok "agent dependencies installed"
fi

# ── 5. Done ──────────────────────────────────────────────────────────────────
step "Ready"
cat <<EOF
  ${DIM}The AI model (~2 GB) downloads on first use — you'll see live progress
  in the app. Nothing is sent to any cloud service; it runs on this machine.${R}

  ${B}Start Bucks:${R}   npm start
  ${B}Connect a peer:${R} open Messages, paste their Bucks ID, and share yours

EOF

if [ "$RUN_APP" = "1" ]; then
  step "Launching Bucks"
  exec npm start
fi
