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
# Prints the command that installs a package with this system's package manager.
install_hint() {
  if command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y $1"
  elif command -v dnf >/dev/null 2>&1; then echo "sudo dnf install -y $1"
  elif command -v pacman >/dev/null 2>&1; then echo "sudo pacman -S --noconfirm $1"
  elif command -v zypper >/dev/null 2>&1; then echo "sudo zypper install -y $1"
  else echo "install $1 with your package manager"
  fi
}

# Report every missing prerequisite at once, so the user can fix them in one go.
missing=0
if ! command -v git >/dev/null 2>&1; then
  printf '\033[1;31merror:\033[0m git is not installed. Install it with: %s\n' "$(install_hint git)" >&2
  missing=1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '\033[1;31merror:\033[0m Node.js 20 or newer and npm are not installed. The simplest route is nvm: https://github.com/nvm-sh/nvm (then run: nvm install 22)\n' >&2
  missing=1
elif ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  printf '\033[1;31merror:\033[0m Node.js 20 or newer is required (found %s). The simplest route is nvm: https://github.com/nvm-sh/nvm (then run: nvm install 22)\n' "$(node -v)" >&2
  missing=1
fi
if [ ! -d "$DEST/.git" ] && [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  printf '\033[1;31merror:\033[0m %s already exists and is not a Bucks Browser checkout. Move it aside, or choose another folder with BUCKS_DIR.\n' "$DEST" >&2
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  echo "Fix the problems above, then run the install command again." >&2
  exit 1
fi

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
# npm can finish without the Electron binary when its download is blocked, so verify it explicitly.
ELECTRON_BIN="$DEST/node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  say "Electron binary not found, retrying its download"
  node node_modules/electron/install.js </dev/null || true
fi
[ -x "$ELECTRON_BIN" ] || die "Electron did not download. Check your network or proxy settings, then run this again."

# Download the IPFS node (Kubo) now so the first start does not have to. Not fatal: the app
# downloads it itself on first start. fetch-kubo.mjs tries dist.ipfs.tech, then GitHub releases.
say "Downloading the IPFS node (Kubo)"
if ! node scripts/fetch-kubo.mjs </dev/null; then
  KUBO_ARCH=amd64
  if [ "$(node -p process.arch </dev/null)" = "arm64" ]; then KUBO_ARCH=arm64; fi
  printf '\033[1;33mwarning:\033[0m could not download the IPFS node now. Bucks Browser will try again when it first starts.\n' >&2
  printf '  If your network blocks the download, get kubo_<version>_linux-%s.tar.gz from\n  https://github.com/ipfs/kubo/releases , unpack it and copy kubo/ipfs to:\n  "%s"\n' \
    "$KUBO_ARCH" "${XDG_CONFIG_HOME:-$HOME/.config}/Bucks Browser/kubo/bin/ipfs" >&2
fi

say "Building the browser interface"
npm run build:ui </dev/null

# Chromium's sandbox cannot start when running as root, so pass --no-sandbox in that case only.
SANDBOX_FLAG=""
[ "$(id -u)" = "0" ] && SANDBOX_FLAG="--no-sandbox"

# The application menu starts the launcher with the desktop session's PATH, which often lacks the
# Node.js this script used (nvm sets PATH only in interactive shells). The in-app updater runs
# npm, so put that Node.js first.
NODE_DIR="$(dirname "$(command -v node)")"

say "Adding the launcher and the application menu entry"
mkdir -p "$BIN_DIR" "$APPS_DIR"
cat > "$BIN_DIR/bucks-browser" <<LAUNCHER
#!/usr/bin/env bash
export PATH="$NODE_DIR:\$PATH"
cd "$DEST" && exec "$ELECTRON_BIN" . $SANDBOX_FLAG "\$@"
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
  *)
    echo "Note: $BIN_DIR is not on your PATH yet, so typing bucks-browser in a terminal does not work (the application menu entry does). To fix it, run:"
    # shellcheck disable=SC2016 # printed for the user to paste; $HOME and $PATH must stay literal.
    echo '  echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.bashrc'
    echo "and open a new terminal. On Ubuntu, logging out and back in also works: ~/.profile adds ~/.local/bin once it exists."
    ;;
esac
echo "To pair this computer with your other Bucks installs (for example a Mac), see:"
echo "  https://github.com/infin8sync69-source/Bucks-browser/blob/$BRANCH/docs/DEVICES.md"
