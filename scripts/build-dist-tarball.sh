#!/bin/bash
# Build bucks-browser-dist.tar.gz — the source-only archive that
# `curl bucks.global/install | bash` downloads and extracts before running
# `npm install` itself. This does NOT exist to package node_modules/.venv/
# build output (the installer builds those on the target machine); it exists
# so nothing secret or stale ships in the one artifact every new user's first
# run depends on.
#
# Previously this tarball was built by hand with no script and no exclude
# list, which is how a real `agent/.env` (with live LITAI_API_KEY /
# NGC_API_KEY values) ended up inside a tarball pinned to IPFS and served to
# anyone who ran the installer. Always rebuild through this script.
#
# Usage: scripts/build-dist-tarball.sh [output-path]
# Then pin the result to IPFS and update BUCKS_CID in install.sh/install.ps1
# (and the synced copies in the bucks.global site repo) to the new CID.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$REPO_ROOT/bucks-browser-dist.tar.gz}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cd "$REPO_ROOT"

# --strip-components isn't the issue here (install.sh now strips the
# top-level dir unconditionally) — this name just needs to be *something*
# consistent, not "bucks-browser" specifically.
DEST="$STAGE/bucks-browser"
mkdir -p "$DEST"

tar -cf - \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.venv' \
  --exclude='venv' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='.pytest_cache' \
  --exclude='dist' \
  --exclude='out' \
  --exclude='build' \
  --exclude='.next' \
  --exclude='ipfs-data' \
  --exclude='*.wallet' \
  --exclude='chroma_db' \
  --exclude='*.db' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite3' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='Thumbs.db' \
  --exclude='.vscode' \
  --exclude='.idea' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='test-results' \
  --exclude='.claude' \
  . | tar -xf - -C "$DEST"

# Belt-and-suspenders: fail loudly instead of shipping secrets if anything
# named .env slipped past the excludes above (e.g. a name variant we missed).
if find "$DEST" -iname '.env*' ! -iname '*.example' | grep -q .; then
  echo "REFUSING TO BUILD: found .env-like file(s) in staged tree:" >&2
  find "$DEST" -iname '.env*' ! -iname '*.example' >&2
  exit 1
fi

tar -czf "$OUT" -C "$STAGE" bucks-browser
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
echo "Next: pin to IPFS, then update BUCKS_CID in install.sh/install.ps1 (and the bucks.global repo's synced copies) to the new CID."
