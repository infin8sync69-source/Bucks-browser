#!/bin/bash
# Bucks Browser installer for macOS (Apple Silicon and Intel). Clones the repository, builds it and
# adds "Bucks Browser" to the Applications folder inside your home folder.
#
#   curl -fsSL https://raw.githubusercontent.com/infin8sync69-source/Bucks-browser/electron-main/scripts/install-macos.sh | bash
#
# Run the same command again at any time to update to the latest commit on the branch.
# Environment overrides:
#   BUCKS_BRANCH   branch to install            (default: electron-main)
#   BUCKS_DIR      where to keep the checkout   (default: ~/Library/Application Support/BucksBrowser/source)
#
# Written for the /bin/bash 3.2 and the BSD tools that ship with macOS: no bash 4 features, no
# GNU-only flags, every path quoted (the app lives in folders with spaces). It never uses sudo,
# only writes inside your home folder and leaves Gatekeeper alone.
set -euo pipefail

REPO_URL="https://github.com/infin8sync69-source/Bucks-browser.git"
BRANCH="${BUCKS_BRANCH:-electron-main}"
DEST="${BUCKS_DIR:-$HOME/Library/Application Support/BucksBrowser/source}"
APPS_DIR="$HOME/Applications"
APP="$APPS_DIR/Bucks Browser.app"
BIN_DIR="$HOME/.local/bin"
# Electron's userData folder for "Bucks Browser": profile, settings and the downloaded IPFS node.
USER_DATA="$HOME/Library/Application Support/Bucks Browser"
BUNDLE_ID="com.mikado.bucksbrowser.source"
# Electron 44 does not start on older macOS: its own Info.plist sets LSMinimumSystemVersion 13.0.
MIN_MACOS_MAJOR=13

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# The shell profile file a PATH line belongs in, for display (~ is meant literally here).
profile_file() {
  # shellcheck disable=SC2088 # shown to the user, who types the ~ in their own shell
  case "${SHELL:-}" in
    */bash) echo '~/.bash_profile' ;;
    *) echo '~/.zprofile' ;;
  esac
}

# How to install Node.js 22 on this Mac.
node_hint() {
  if command -v brew >/dev/null 2>&1; then
    local prefix
    prefix=$(brew --prefix 2>/dev/null </dev/null || echo /opt/homebrew)
    # shellcheck disable=SC2016 # printed for the user to paste; $PATH must stay literal.
    printf 'Install it with Homebrew: brew install node@22 ; node@22 is not linked into your PATH by default, so also run: echo '\''export PATH="%s/opt/node@22/bin:$PATH"'\'' >> %s ; then open a new Terminal window.' "$prefix" "$(profile_file)"
  else
    printf 'The simplest route is nvm: https://github.com/nvm-sh/nvm (install it, open a new Terminal window, then run: nvm install 22). The installer from https://nodejs.org works too.'
  fi
}

# True when BUCKS_DIR holds something other than a git checkout (an empty folder is fine).
dest_in_the_way() {
  [ ! -d "$DEST/.git" ] && [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]
}
DEST_IN_THE_WAY_MSG='already exists and is not a Bucks Browser checkout. Move it aside, or choose another folder with BUCKS_DIR, then run this again.'

# True when ~/Applications/Bucks Browser.app exists but was not made by this installer.
app_in_the_way() {
  [ -f "$APP/Contents/Info.plist" ] && ! grep -Fq "$BUNDLE_ID" "$APP/Contents/Info.plist"
}
APP_IN_THE_WAY_MSG='already exists and was not made by this installer (for example a packaged build from a .dmg). Move it elsewhere (packaged builds belong in /Applications), then run this again.'

# Prints the macOS version and chip, and warns about setups that would install the slower Intel build.
check_system() {
  MACOS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo unknown)
  local machine translated chip
  machine=$(uname -m)
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
    chip="Apple Silicon"
    IS_APPLE_SILICON=1
  else
    chip="Intel"
    IS_APPLE_SILICON=0
  fi
  say "macOS $MACOS_VERSION on $chip (this shell reports $machine)"
  translated=$(sysctl -n sysctl.proc_translated 2>/dev/null || true)
  if [ "$translated" = "1" ]; then
    warn "this Terminal runs under Rosetta (Intel emulation). Tools it starts may use their Intel builds, which are slower. For the native build: quit Terminal, untick 'Open using Rosetta' in Terminal's Get Info window, and run this again."
  fi
}

# Reports every missing prerequisite at once, so the user can fix them in one go.
check_prerequisites() {
  local missing=0 major git_bin
  major=${MACOS_VERSION%%.*}
  case "$major" in
    '' | *[!0-9]*) warn "could not read the macOS version ($MACOS_VERSION); continuing." ;;
    *)
      if [ "$major" -lt "$MIN_MACOS_MAJOR" ]; then
        err "macOS $MIN_MACOS_MAJOR (Ventura) or newer is required (found $MACOS_VERSION). Bucks Browser runs on Electron 44, which does not start on older versions."
        missing=1
      fi
      ;;
  esac

  # /usr/bin/git is only a stub until Apple's Command Line Tools are installed; running it would
  # open the install dialog, so only run git once we know a real one is there.
  git_bin=$(command -v git 2>/dev/null || true)
  if ! xcode-select -p >/dev/null 2>&1 && { [ -z "$git_bin" ] || [ "$git_bin" = /usr/bin/git ]; }; then
    err "git is not installed: Apple's Command Line Tools are missing. Run: xcode-select --install (confirm the dialog, wait until it finishes), then run this installer again. Homebrew's git works too: brew install git"
    missing=1
  elif [ -z "$git_bin" ] || ! git --version >/dev/null 2>&1 </dev/null; then
    err "git is installed but does not run (git --version failed). If you use Xcode, open it once to accept its license; otherwise reinstall the Command Line Tools with: xcode-select --install"
    missing=1
  fi

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    err "Node.js 20 or newer and npm are not installed. $(node_hint)"
    missing=1
  elif ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' </dev/null; then
    err "Node.js 20 or newer is required (found $(node -v </dev/null)). $(node_hint)"
    missing=1
  fi

  if dest_in_the_way; then
    err "$DEST $DEST_IN_THE_WAY_MSG"
    missing=1
  fi
  if app_in_the_way; then
    err "\"$APP\" $APP_IN_THE_WAY_MSG"
    missing=1
  fi

  if [ "$missing" -ne 0 ]; then
    echo "Fix the problems above, then run the install command again." >&2
    exit 1
  fi

  NODE_ARCH=$(node -p process.arch </dev/null)
  say "Using git $(git --version </dev/null | sed 's/^git version //') and Node.js $(node -v </dev/null) ($NODE_ARCH)"
  if [ "$IS_APPLE_SILICON" = "1" ] && [ "$NODE_ARCH" != "arm64" ]; then
    warn "this Node.js is the Intel ($NODE_ARCH) build, so the Intel builds of Electron and the IPFS node will be installed and run through Rosetta. For the native Apple Silicon build, install an arm64 Node.js (Homebrew in /opt/homebrew, or nvm from a Terminal that does not use Rosetta), then run this again."
  fi
}

# Clones the branch, or fast-forwards an existing checkout.
fetch_source() {
  if [ -d "$DEST/.git" ]; then
    say "Updating $DEST to the latest $BRANCH"
    git -C "$DEST" fetch --quiet origin "$BRANCH" </dev/null \
      || die "could not download $BRANCH from GitHub. Check your network connection, then run this again."
    git -C "$DEST" checkout --quiet "$BRANCH" </dev/null \
      || die "could not switch $DEST to $BRANCH (local changes?). Move them aside, or delete that folder, then run this again."
    git -C "$DEST" merge --ff-only --quiet "origin/$BRANCH" </dev/null \
      || die "$DEST has local changes that block the update. Move them aside, or delete that folder, then run this again."
  elif dest_in_the_way; then
    die "$DEST $DEST_IN_THE_WAY_MSG"
  else
    say "Cloning $BRANCH into $DEST"
    mkdir -p "$(dirname "$DEST")"
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DEST" </dev/null \
      || die "could not clone $REPO_URL (branch $BRANCH). Check your network connection and the branch name, then run this again."
  fi
}

# npm install, then makes sure the Electron app really arrived (npm can finish without it when
# the download is blocked).
install_dependencies() {
  cd "$DEST"
  say "Installing dependencies (downloads Electron, about 100 MB, on the first run)"
  npm install --no-audit --no-fund </dev/null \
    || die "npm install failed. Check the messages above (usually a network or proxy problem), then run this again."
  ELECTRON_BIN="$DEST/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  if [ ! -x "$ELECTRON_BIN" ]; then
    say "Electron not found, retrying its download"
    node node_modules/electron/install.js </dev/null || true
  fi
  [ -x "$ELECTRON_BIN" ] || die "Electron did not download (expected $ELECTRON_BIN). Check your network or proxy settings, then run this again."
}

# Downloads Kubo into the checkout now, so the first start does not have to. Not fatal: the app
# downloads it itself on first start.
prefetch_kubo() {
  local kubo_arch=amd64
  if [ "$NODE_ARCH" = "arm64" ]; then kubo_arch=arm64; fi
  say "Downloading the IPFS node (Kubo)"
  if ! node scripts/fetch-kubo.mjs </dev/null; then
    warn "could not download the IPFS node now. Bucks Browser will try again when it first starts."
    printf '  If your network blocks the download, get kubo_<version>_darwin-%s.tar.gz from\n  https://github.com/ipfs/kubo/releases , unpack it and copy kubo/ipfs to:\n  "%s"\n' \
      "$kubo_arch" "$USER_DATA/kubo/bin/ipfs" >&2
  fi
}

build_ui() {
  say "Building the browser interface"
  npm run build:ui </dev/null || die "building the interface failed. Check the messages above, then run this again."
}

# Writes the app's Info.plist. $1 = version, $2 = output file.
write_info_plist() {
  cat > "$2" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>Bucks Browser</string>
	<key>CFBundleExecutable</key>
	<string>bucks-browser</string>
	<key>CFBundleIconFile</key>
	<string>icon</string>
	<key>CFBundleIdentifier</key>
	<string>$BUNDLE_ID</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Bucks Browser</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$1</string>
	<key>CFBundleVersion</key>
	<string>$1</string>
	<key>LSMinimumSystemVersion</key>
	<string>$MIN_MACOS_MAJOR.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST
}

# Writes a launcher script that starts Electron with the checkout as the app. $1 = output file.
# Paths are embedded with printf %q, so spaces and quotes in them are safe.
write_launcher() {
  # Apps opened from Finder get a minimal PATH (/usr/bin:/bin:...). The in-app updater runs git
  # and npm, so put the ones this installer used first.
  local launch_path
  launch_path="$(dirname "$(command -v node)"):$(dirname "$(command -v git)"):/opt/homebrew/bin:/usr/local/bin"
  {
    echo '#!/bin/bash'
    echo '# Bucks Browser launcher, written by scripts/install-macos.sh. Run the installer again to update it.'
    printf 'APP_DIR=%q\n' "$DEST"
    printf 'ELECTRON=%q\n' "$ELECTRON_BIN"
    # shellcheck disable=SC2016 # $PATH must stay literal: it is expanded when the launcher runs.
    printf 'export PATH=%q:"$PATH"\n' "$launch_path"
    cat <<'LAUNCHER'
if [ ! -x "$ELECTRON" ]; then
  msg="Bucks Browser is not installed correctly: $ELECTRON is missing. Run the install command again to repair it."
  echo "$msg" >&2
  /usr/bin/osascript -e 'on run argv' -e 'display alert "Bucks Browser cannot start" message (item 1 of argv) as critical' -e 'end run' "$msg" >/dev/null 2>&1 || true
  exit 1
fi
cd "$APP_DIR" || exit 1
exec "$ELECTRON" "$APP_DIR" "$@"
LAUNCHER
  } > "$1"
  chmod 755 "$1"
}

# Builds ~/Applications/Bucks Browser.app in a staging folder, then swaps it in.
create_app_bundle() {
  local version stage attrs lsregister
  version=$(node -p 'require("./package.json").version' </dev/null)
  case "$version" in
    '' | *[!0-9A-Za-z.+-]*)
      warn "unexpected version in package.json ($version); labelling the app 0.0.0"
      version=0.0.0
      ;;
  esac

  say "Creating $APP"
  mkdir -p "$APPS_DIR"
  # Checked up front too; checked again in case something appeared there during the build.
  if app_in_the_way; then die "\"$APP\" $APP_IN_THE_WAY_MSG"; fi

  stage="$APPS_DIR/.Bucks Browser.installing"
  rm -rf "$stage"
  mkdir -p "$stage/Contents/MacOS" "$stage/Contents/Resources"
  write_info_plist "$version" "$stage/Contents/Info.plist"
  printf 'APPL????' > "$stage/Contents/PkgInfo"
  write_launcher "$stage/Contents/MacOS/bucks-browser"
  if [ -f "$DEST/build/icons/icon.icns" ]; then
    cp "$DEST/build/icons/icon.icns" "$stage/Contents/Resources/icon.icns"
  else
    warn "build/icons/icon.icns is missing from the checkout; the app will show a generic icon."
  fi
  rm -rf "$APP"
  mv "$stage" "$APP"

  # A bundle created locally is never quarantined, but if something marked it, Gatekeeper would
  # block the launcher. Only this bundle is touched.
  attrs=$(xattr "$APP" 2>/dev/null || true)
  case "$attrs" in
    *com.apple.quarantine*) xattr -dr com.apple.quarantine "$APP" ;;
    *) ;;
  esac
  # Register with Launch Services so Finder and Spotlight pick up the new bundle right away.
  lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  if [ -x "$lsregister" ]; then
    "$lsregister" -f "$APP" >/dev/null 2>&1 || true
  fi
  touch "$APP"
}

write_cli_launcher() {
  mkdir -p "$BIN_DIR"
  write_launcher "$BIN_DIR/bucks-browser"
}

finish() {
  say "Bucks Browser is installed."
  cat <<EOF

Open it in any of these ways:
  - Finder: open your home folder, then Applications, then Bucks Browser
  - Spotlight: press Command-Space and type Bucks Browser
  - Terminal: open "$APP"

When Bucks starts, macOS may ask whether "Electron" or "ipfs" may accept incoming network
connections, and (macOS 15 and later) whether it may find devices on your local network.
Choose Allow: that is what lets your Linux laptop connect to this Mac. Pairing the two is
described in docs/DEVICES.md:
  https://github.com/infin8sync69-source/Bucks-browser/blob/$BRANCH/docs/DEVICES.md

Run the same install command again at any time to update.
EOF
  case ":$PATH:" in
    *":$BIN_DIR:"*) echo "From a terminal you can also run: bucks-browser" ;;
    *)
      echo "To run bucks-browser from a terminal, add $BIN_DIR to your PATH:"
      # shellcheck disable=SC2016 # printed for the user to paste; $HOME and $PATH must stay literal.
      printf '  echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> %s\n' "$(profile_file)"
      echo "  then open a new Terminal window."
      ;;
  esac
}

main() {
  [ "$(uname -s)" = "Darwin" ] || die "this script is for macOS. On Linux use scripts/install-linux.sh; docs/BUILDING.md covers other systems."
  [ "$(id -u)" != "0" ] || die "do not run this installer with sudo or as root. Run it as your normal user: it only writes inside your home folder."
  check_system
  check_prerequisites
  fetch_source
  install_dependencies
  prefetch_kubo
  build_ui
  create_app_bundle
  write_cli_launcher
  finish
}

# Everything runs from main, called on the last line, so a download cut off half-way runs nothing
# (curl ... | bash reads the script as it arrives).
main
