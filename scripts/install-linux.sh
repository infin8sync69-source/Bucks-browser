#!/usr/bin/env bash
# Bucks Browser installer for Linux. Clones the repository, builds it and adds a launcher.
#
#   curl -fsSL https://raw.githubusercontent.com/infin8sync69-source/Bucks-browser/electron-main/scripts/install-linux.sh | bash
#
# Run the same command again at any time to update to the latest commit on the branch.
# Environment overrides:
#   BUCKS_BRANCH   branch to install            (default: electron-main)
#   BUCKS_DIR      where to keep the checkout   (default: ~/.local/share/bucks-browser)
set -euo pipefail

REPO_URL="https://github.com/infin8sync69-source/Bucks-browser.git"
BRANCH="${BUCKS_BRANCH:-electron-main}"
DEST="${BUCKS_DIR:-$HOME/.local/share/bucks-browser}"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this script is for Linux. See docs/BUILDING.md for other systems."
for tool in git node npm; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required. Install it with your package manager, then run this again."
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || die "Node.js 20 or newer is required (found $(node -v))."

if [ -d "$DEST/.git" ]; then
  say "Updating $DEST to the latest $BRANCH"
  git -C "$DEST" fetch --quiet origin "$BRANCH" </dev/null
  git -C "$DEST" checkout --quiet "$BRANCH" </dev/null
  git -C "$DEST" merge --ff-only --quiet "origin/$BRANCH" </dev/null \
    || die "$DEST has local changes that block the update. Move them aside, or delete $DEST, then run this again."
else
  say "Cloning $BRANCH into $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DEST" </dev/null
fi

cd "$DEST"
say "Installing dependencies (downloads Electron, roughly 250 MB on first run)"
npm install --no-audit --no-fund </dev/null
say "Building the browser interface"
npm run build:ui </dev/null

# Chromium's sandbox cannot start when running as root, so pass --no-sandbox in that case only.
SANDBOX_FLAG=""
[ "$(id -u)" = "0" ] && SANDBOX_FLAG="--no-sandbox"

say "Adding the launcher and the application menu entry"
mkdir -p "$BIN_DIR" "$APPS_DIR"
cat > "$BIN_DIR/bucks-browser" <<LAUNCHER
#!/usr/bin/env bash
cd "$DEST" && exec "$DEST/node_modules/electron/dist/electron" . $SANDBOX_FLAG "\$@"
LAUNCHER
chmod +x "$BIN_DIR/bucks-browser"

cat > "$APPS_DIR/bucks-browser.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Bucks Browser
Comment=Decentralised, IPFS-native web browser
Exec=$BIN_DIR/bucks-browser %U
Terminal=false
Categories=Network;WebBrowser;
ENTRY
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

say "Bucks Browser is installed. Start it from your application menu, or run: bucks-browser"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on your PATH. Add it to run bucks-browser from a terminal." ;;
esac
