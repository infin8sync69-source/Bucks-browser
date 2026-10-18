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

# Plain sh on purpose, so it also stops cleanly when the script is fed to sh, dash or zsh.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "error: this installer needs bash. Run it as: curl -fsSL <installer URL> | bash" >&2
  exit 1
fi
set -euo pipefail

REPO_URL="https://github.com/infin8sync69-source/Bucks-browser.git"
BRANCH="${BUCKS_BRANCH:-electron-main}"
DEST="${BUCKS_DIR:-$HOME/Library/Application Support/BucksBrowser/source}"
# A relative or quoted-~ BUCKS_DIR would break once the script cd's into the checkout.
# shellcheck disable=SC2088 # a literal ~ is exactly what is being matched here.
case "$DEST" in
  "~") DEST="$HOME" ;;
  "~/"*) DEST="$HOME/${DEST#"~/"}" ;;
  /*) ;;
  *) DEST="$PWD/$DEST" ;;
esac
APPS_DIR="$HOME/Applications"
APP="$APPS_DIR/Bucks Browser.app"
BIN_DIR="$HOME/.local/bin"
# Electron's userData folder for "Bucks Browser" (package.json productName): profile, settings,
# paired devices and the downloaded IPFS node. The installer never writes there.
USER_DATA="$HOME/Library/Application Support/Bucks Browser"
BUNDLE_ID="com.mikado.bucksbrowser.source"
# Electron 44 does not start on older macOS: its own Info.plist sets LSMinimumSystemVersion 13.0.
MIN_MACOS_MAJOR=13
DOCS_URL="https://github.com/infin8sync69-source/Bucks-browser/blob/$BRANCH/docs"
# git must fail instead of waiting for a password typed into the Terminal (curl | bash).
export GIT_TERMINAL_PROMPT=0

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# Runs the git chosen by find_git (never Apple's /usr/bin/git stub without the Command Line Tools).
GIT_BIN=''
git() { "$GIT_BIN" "$@"; }

# The shell profile file a PATH line belongs in, for display (~ is meant literally here).
profile_file() {
  # shellcheck disable=SC2088 # shown to the user, who types the ~ in their own shell
  case "${SHELL:-}" in
    */bash) echo '~/.bash_profile' ;;
    *) echo '~/.zprofile' ;;
  esac
}

path_append() {
  case ":$PATH:" in
    *":$1:"*) ;;
    *) PATH="$PATH:$1" ;;
  esac
}

# Directory of nvm's default Node.js, loading nvm.sh the way a new Terminal window would. nvm is a
# shell function that only exists after nvm.sh is sourced, and nvm.sh is not written for set -eu,
# so it is loaded in a subshell with those options off.
nvm_node_dir() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}" node_path
  [ -s "$nvm_dir/nvm.sh" ] || return 1
  node_path=$(
    set +eu +o pipefail
    NVM_DIR="$nvm_dir"
    export NVM_DIR
    # shellcheck disable=SC1091 # nvm.sh is the user's own file.
    . "$nvm_dir/nvm.sh" --no-use >/dev/null 2>&1 </dev/null
    nvm which default 2>/dev/null </dev/null
  ) || true
  node_path=$(printf '%s\n' "$node_path" | tail -n 1)
  [ -n "$node_path" ] && [ -x "$node_path" ] || return 1
  dirname "$node_path"
}

# Homebrew and nvm put their tools on the PATH from shell startup files. When those lines are
# missing (Homebrew's "Next steps" skipped, the keg-only node@22, nvm installed in a Terminal
# window opened earlier), look in the usual places, without overriding anything already on PATH.
find_tools() {
  local d node_dir=''
  for d in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$d/brew" ]; then path_append "$d"; fi
  done
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    for d in /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@24/bin /opt/homebrew/opt/node@20/bin \
      /opt/homebrew/opt/node/bin /usr/local/opt/node@22/bin /usr/local/opt/node@24/bin \
      /usr/local/opt/node@20/bin /usr/local/opt/node/bin; do
      if [ -x "$d/node" ] && [ -x "$d/npm" ]; then
        node_dir="$d"
        break
      fi
    done
    if [ -z "$node_dir" ]; then node_dir=$(nvm_node_dir) || node_dir=''; fi
    if [ -n "$node_dir" ]; then
      PATH="$node_dir:$PATH"
      say "Node.js is not on this Terminal's PATH; using the one in $node_dir"
    fi
  fi
  export PATH
  hash -r
}

# Picks the git to use. /usr/bin/git is only a stub until Apple's Command Line Tools are
# installed, and running it opens their install dialog, so it is used only when they are there.
find_git() {
  local clt d
  GIT_BIN=$(command -v git 2>/dev/null || true)
  if [ "$GIT_BIN" = /usr/bin/git ]; then
    clt=$(xcode-select -p 2>/dev/null </dev/null || true)
    if [ -z "$clt" ] || [ ! -x "$clt/usr/bin/git" ]; then
      GIT_BIN=''
      for d in /opt/homebrew/bin /usr/local/bin; do
        if [ -x "$d/git" ]; then
          GIT_BIN="$d/git"
          break
        fi
      done
    fi
  fi
}

# How to install Node.js 22 on this Mac.
node_hint() {
  local prefix
  if command -v brew >/dev/null 2>&1; then
    prefix=$(brew --prefix 2>/dev/null </dev/null || echo /opt/homebrew)
    # shellcheck disable=SC2016 # printed for the user to paste; $PATH must stay literal.
    printf 'Install it with Homebrew: brew install node@22 ; node@22 is not linked into your PATH by default, so also run: echo '\''export PATH="%s/opt/node@22/bin:$PATH"'\'' >> %s ; then open a new Terminal window and run the install command again.' "$prefix" "$(profile_file)"
  else
    printf 'The simplest route is nvm: https://github.com/nvm-sh/nvm (install it, open a new Terminal window, then run: nvm install 22). The installer from https://nodejs.org works too. Then run the install command again.'
  fi
}

# True when BUCKS_DIR holds something other than a git checkout (an empty folder is fine).
dest_in_the_way() {
  [ ! -d "$DEST/.git" ] && [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]
}
DEST_IN_THE_WAY_MSG='already exists and is not a Bucks Browser checkout. Move it aside, or choose another folder with BUCKS_DIR, then run this again.'

# Prints the CFBundleIdentifier of the bundle $1 (fails when it has no Info.plist).
bundle_id_of() {
  local plist="$1/Contents/Info.plist"
  [ -f "$plist" ] || return 1
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null </dev/null
  elif grep -Fq "<string>$BUNDLE_ID</string>" "$plist" 2>/dev/null; then
    echo "$BUNDLE_ID"
  else
    echo unknown
  fi
}

# True when ~/Applications/Bucks Browser.app exists but was not made by this installer.
app_in_the_way() {
  local id
  [ -e "$APP" ] || [ -L "$APP" ] || return 1
  id=$(bundle_id_of "$APP") || id=''
  [ "$id" != "$BUNDLE_ID" ]
}
APP_IN_THE_WAY_MSG='already exists and was not made by this installer (for example a packaged build from a .dmg). Move it elsewhere (packaged builds belong in /Applications), then run this again.'

# Architecture of a Mach-O executable as Node names it (arm64 | x64), or nothing when unknown.
# Uses file(1), which is part of macOS, so nothing is executed (an Intel binary would ask to
# install Rosetta on a Mac without it).
binary_arch() {
  case "$(file -b "$1" 2>/dev/null </dev/null || true)" in
    *universal*) ;;
    *arm64*) echo arm64 ;;
    *x86_64*) echo x64 ;;
    *) ;;
  esac
}

# Prints the macOS version and chip.
check_system() {
  MACOS_VERSION=$(sw_vers -productVersion 2>/dev/null </dev/null || echo unknown)
  local machine chip
  machine=$(uname -m)
  # hw.optional.arm64 is 1 on Apple Silicon, also inside Rosetta; Intel Macs do not have it.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null </dev/null || true)" = "1" ]; then
    chip="Apple Silicon"
    IS_APPLE_SILICON=1
    NATIVE_ARCH=arm64
  else
    chip="Intel"
    IS_APPLE_SILICON=0
    NATIVE_ARCH=x64
  fi
  say "macOS $MACOS_VERSION on $chip (this shell reports $machine)"
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null </dev/null || true)" = "1" ]; then
    warn "this Terminal runs under Rosetta (Intel emulation), which makes the installation slower. Bucks Browser itself still gets the native Apple Silicon build. To avoid this next time: quit Terminal, untick 'Open using Rosetta' in Terminal's Get Info window."
  fi
}

# Reports every missing prerequisite at once, so the user can fix them in one go.
check_prerequisites() {
  local missing=0 major
  major=${MACOS_VERSION%%.*}
  case "$major" in
    '' | *[!0-9]*) warn "could not read the macOS version ($MACOS_VERSION); continuing." ;;
    *)
      if [ "$major" -lt "$MIN_MACOS_MAJOR" ]; then
        err "macOS $MIN_MACOS_MAJOR (Ventura) or newer is required (found $MACOS_VERSION). Bucks Browser runs on Electron 44, which does not start on older versions. Update macOS in System Settings > General > Software Update, then run this again."
        missing=1
      fi
      ;;
  esac

  find_git
  if [ -z "$GIT_BIN" ]; then
    err "git is not installed: Apple's Command Line Tools are missing. Run: xcode-select --install (click Install in the dialog and wait until it finishes), then run this installer again. Homebrew's git works too: brew install git"
    missing=1
  elif ! git --version >/dev/null 2>&1 </dev/null; then
    err "git is installed but does not run (git --version failed). If you use Xcode, open it once to accept its license; otherwise reinstall the Command Line Tools with: xcode-select --install"
    missing=1
  fi

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    err "Node.js 20 or newer and npm are not installed. $(node_hint)"
    missing=1
  elif ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' </dev/null >/dev/null 2>&1; then
    err "Node.js 20 or newer is required (found $(node -v </dev/null 2>/dev/null || echo 'a version that does not run')). $(node_hint)"
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
    warn "this Node.js is the Intel ($NODE_ARCH) build and runs through Rosetta, so installing is slower and the in-app updater uses it too. Bucks Browser itself still gets the native Apple Silicon build. For a native Node.js, install it with Homebrew in /opt/homebrew or with nvm from a Terminal that does not use Rosetta."
  fi
}

# Warns when Bucks Browser is running from this checkout: its files are replaced underneath it.
warn_if_running() {
  local procs
  procs=$(ps -axww -o command= 2>/dev/null || true)
  case "$procs" in
    *"$DEST/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"*)
      warn "Bucks Browser is open. The update is installed anyway; quit it (Command-Q) and open it again when this finishes."
      ;;
    *) ;;
  esac
}

# Clones the branch, or fast-forwards an existing checkout.
fetch_source() {
  local keep="Your settings, IPFS node and paired devices are stored separately in \"$USER_DATA\" and are kept either way."
  if [ -d "$DEST/.git" ]; then
    say "Updating $DEST to the latest $BRANCH"
    git -C "$DEST" fetch --quiet origin "$BRANCH" </dev/null \
      || die "could not download $BRANCH from GitHub. Check your network connection, then run this again."
    if ! git -C "$DEST" checkout --quiet "$BRANCH" </dev/null; then
      die "could not switch \"$DEST\" to $BRANCH because of local edits. To throw them away run: git -C \"$DEST\" stash   (or delete that folder), then run this again. $keep"
    fi
    if ! git -C "$DEST" merge --ff-only --quiet "origin/$BRANCH" </dev/null; then
      if [ -n "$(git -C "$DEST" status --porcelain --untracked-files=no </dev/null 2>/dev/null)" ]; then
        die "\"$DEST\" has local edits that block the update. To throw them away run: git -C \"$DEST\" stash   (or delete that folder), then run this again. $keep"
      fi
      die "\"$DEST\" has commits that are not on GitHub's $BRANCH (or the branch was rewritten there), so it cannot be updated automatically. To reset it to GitHub's version run: git -C \"$DEST\" reset --hard origin/$BRANCH   (or delete that folder), then run this again. $keep"
    fi
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
# the download is blocked) and matches this Mac's chip.
install_dependencies() {
  local stamp="$DEST/node_modules/.bucks-installer-node-arch" old_arch='' want
  cd "$DEST"
  # Native build tools in node_modules (the interface build uses some) follow Node's architecture;
  # npm does not swap them when a different Node.js is used later, so start over in that case.
  if [ -f "$stamp" ]; then old_arch=$(cat "$stamp" 2>/dev/null || true); fi
  if [ -n "$old_arch" ] && [ "$old_arch" != "$NODE_ARCH" ]; then
    say "The installed dependencies were made for a $old_arch Node.js and this one is $NODE_ARCH: installing them again"
    rm -rf "$DEST/node_modules" "$DEST/ui/node_modules"
  fi

  say "Installing dependencies (downloads Electron, about 110 MB, on the first run)"
  # include=dev: Electron and the interface build tools are devDependencies, which an npm config
  # with omit=dev or NODE_ENV=production would skip (the env form also reaches ui/'s install).
  npm_config_include=dev npm install --no-audit --no-fund </dev/null \
    || die "npm install failed. Check the messages above (usually a network or proxy problem), then run this again."
  printf '%s\n' "$NODE_ARCH" > "$stamp"
  [ -f "$DEST/node_modules/electron/install.js" ] \
    || die "npm did not install Electron (node_modules/electron is missing). Check the messages above, then run this again."

  ELECTRON_BIN="$DEST/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  if [ ! -x "$ELECTRON_BIN" ]; then
    say "Electron not found, retrying its download"
    node node_modules/electron/install.js </dev/null || true
  fi
  [ -x "$ELECTRON_BIN" ] || die "Electron did not download (expected $ELECTRON_BIN). Check your network or proxy settings, then run this again."

  # An Electron of the wrong architecture can be left over from a Migration Assistant copy or an
  # earlier install. Electron's own installer already picks arm64 under Rosetta.
  want="$NATIVE_ARCH"
  if [ -n "${ELECTRON_INSTALL_ARCH:-}${npm_config_arch:-}" ]; then want="${ELECTRON_INSTALL_ARCH:-$npm_config_arch}"; fi
  ELECTRON_ARCH=$(binary_arch "$ELECTRON_BIN")
  if [ -n "$ELECTRON_ARCH" ] && [ "$ELECTRON_ARCH" != "$want" ]; then
    say "The installed Electron is the $ELECTRON_ARCH build; downloading the $want build for this Mac"
    rm -rf "$DEST/node_modules/electron/dist"
    rm -f "$DEST/node_modules/electron/path.txt"
    ELECTRON_INSTALL_ARCH="$want" node node_modules/electron/install.js </dev/null \
      || die "could not download the $want build of Electron. Check your network or proxy settings, then run this again."
    [ -x "$ELECTRON_BIN" ] || die "Electron did not download (expected $ELECTRON_BIN). Check your network or proxy settings, then run this again."
    ELECTRON_ARCH=$(binary_arch "$ELECTRON_BIN")
  fi
  if [ -z "$ELECTRON_ARCH" ]; then ELECTRON_ARCH="$want"; fi
}

# Downloads Kubo into the checkout (resources/kubo/mac-<arch>/ipfs) now, so the first start does
# not have to. It must match Electron's architecture, which is what the app looks for. Not fatal:
# the app downloads it itself on first start. fetch-kubo.mjs tries dist.ipfs.tech, then GitHub.
prefetch_kubo() {
  local kubo_arch=amd64
  if [ "$ELECTRON_ARCH" = "arm64" ]; then kubo_arch=arm64; fi
  say "Downloading the IPFS node (Kubo)"
  if ! node scripts/fetch-kubo.mjs --platform darwin --arch "$ELECTRON_ARCH" </dev/null; then
    warn "could not download the IPFS node now. Bucks Browser will try again when it first starts."
    printf '  If your network blocks the download, install it by hand: the file is\n  kubo_<version>_darwin-%s.tar.gz from https://github.com/ipfs/kubo/releases , and the\n  steps are under "Installing the IPFS node by hand" in %s/DEVICES.md\n  (download it with curl in Terminal; macOS blocks a copy downloaded with a web browser).\n  The ipfs file goes to: "%s"\n' \
      "$kubo_arch" "$DOCS_URL" "$USER_DATA/kubo/bin/ipfs" >&2
  fi
}

build_ui() {
  say "Building the browser interface"
  npm run build:ui </dev/null || die "building the interface failed. Check the messages above, then run this again."
}

# Writes the app's Info.plist. $1 = version, $2 = output file.
write_info_plist() {
  local arch_priority=''
  # The bundle's executable is a script, which has no architecture of its own; ask Launch Services
  # to start it natively on Apple Silicon (Electron, which it starts, is arm64 there).
  if [ "$ELECTRON_ARCH" = "arm64" ]; then
    arch_priority='	<key>LSArchitecturePriority</key>
	<array>
		<string>arm64</string>
		<string>x86_64</string>
	</array>
'
  fi
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
${arch_priority}	<key>LSMinimumSystemVersion</key>
	<string>$MIN_MACOS_MAJOR.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST
}

# Writes a launcher script that starts Electron with the checkout as the app. $1 = output file.
# Paths are embedded with printf %q, so spaces and quotes in them are safe. Written to a temporary
# file and renamed, so a symlink at $1 is replaced rather than written through.
write_launcher() {
  # Apps opened from Finder get a minimal PATH (/usr/bin:/bin:...). The in-app updater runs git
  # and npm, so put the ones this installer used first.
  local launch_path tmp="$1.tmp.$$"
  launch_path="$(dirname "$(command -v node)"):$(dirname "$GIT_BIN"):/opt/homebrew/bin:/usr/local/bin"
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
  } > "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$1"
}

# Builds ~/Applications/Bucks Browser.app in a staging folder, then swaps it in.
create_app_bundle() {
  local version stage attrs lsregister
  version=$(node -p 'require(process.argv[1]).version' "$DEST/package.json" </dev/null 2>/dev/null || true)
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

  # Files made here are never quarantined, and this script does not remove the flag if something
  # else added it: it only says what macOS will do.
  attrs=$(xattr "$APP" 2>/dev/null </dev/null || true)
  case "$attrs" in
    *com.apple.quarantine*)
      warn "macOS marked \"$APP\" as downloaded from the internet. The first time you open it, macOS asks you to confirm; if it refuses, open System Settings > Privacy & Security and click Open Anyway."
      ;;
    *) ;;
  esac
  # Register with Launch Services so Finder and Spotlight pick up the new bundle right away.
  lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  if [ -x "$lsregister" ]; then
    "$lsregister" -f "$APP" >/dev/null 2>&1 </dev/null || true
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
  $DOCS_URL/DEVICES.md

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
  case "$BRANCH" in
    '' | -* | *..* | *[!A-Za-z0-9._/-]*) die "BUCKS_BRANCH=\"$BRANCH\" is not a valid branch name." ;;
    *) ;;
  esac
  check_system
  find_tools
  check_prerequisites
  warn_if_running
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
