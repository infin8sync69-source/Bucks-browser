# scripts

Small scripts used by `package.json`, CI and the source installers. The Node scripts are plain ES
modules and need Node 20+.

| Script | How it runs | Purpose |
|---|---|---|
| `install-linux.sh` | `curl -fsSL https://raw.githubusercontent.com/infin8sync69-source/Bucks-browser/electron-main/scripts/install-linux.sh \| bash` | Source installer for Linux: clone or update, build, add `bucks-browser` and an application menu entry. |
| `install-macos.sh` | `curl -fsSL https://raw.githubusercontent.com/infin8sync69-source/Bucks-browser/electron-main/scripts/install-macos.sh \| bash` | Source installer for macOS (Apple Silicon and Intel): clone or update, build, create `~/Applications/Bucks Browser.app`. |
| `dev.mjs` | `npm run dev` | Developer runner: starts the Vite dev server in `ui/` (port 1420, strict), waits for it, then launches Electron with `BUCKS_DEV_URL` and `BUCKS_DEBUG=1`. Extra arguments are passed to Electron. `--check` validates the setup and exits. |
| `fetch-kubo.mjs` | `npm run fetch:kubo` | Downloads the Kubo binary (SHA-512 verified) into `resources/kubo/<os>-<arch>/`, trying several mirrors. Used for packaging and by both installers. |
| `check-main.mjs` | part of `npm run check` | Syntax-checks every file under `src/` and `scripts/` with `node --check`, without starting Electron. |

## Source installers

Both installers do the same steps, and running one again updates the install:

1. Refuse to run on the wrong operating system.
2. Check every prerequisite and print all problems at once, each with the command that fixes it:
   `git`, Node.js 20 or newer with npm, and (both) a `BUCKS_DIR` that is empty, missing or already a
   Bucks checkout. macOS also checks the version (13 or newer, Electron 44's minimum), refuses
   `sudo`/root, and refuses to replace a `~/Applications/Bucks Browser.app` it did not create.
3. Clone `BUCKS_BRANCH` (default `electron-main`) into `BUCKS_DIR`, or fetch and fast-forward an
   existing checkout. Local changes that block the fast-forward stop the script with a message.
4. `npm install`, then check that the Electron binary exists and is executable; if not, retry
   `node node_modules/electron/install.js` once, and fail with a clear message if it is still missing.
5. `node scripts/fetch-kubo.mjs` to pre-download Kubo into `resources/kubo/<os>-<arch>/`, where the
   app looks first. Failure is not fatal: the script prints that the app will download Kubo at
   first start, and where to put the binary by hand.
6. `npm run build:ui`.
7. Add the launchers (below) and print how to start the app.

Every command that could read standard input gets `</dev/null`, because `curl … | bash` feeds the
script itself on standard input.

| | Linux | macOS |
|---|---|---|
| Shell | bash (any recent version) | `/bin/bash` 3.2 and BSD tools: no bash 4 features, no GNU-only flags. Everything runs from a `main` function called on the last line, so a truncated download runs nothing. |
| Prerequisite hints | `apt-get` / `dnf` / `pacman` / `zypper` command for git; nvm for Node.js | `xcode-select --install` (or `brew install git`) for git; `brew install node@22` when Homebrew is present, otherwise nvm (`nvm install 22`) |
| `BUCKS_DIR` default | `~/.local/share/bucks-browser` | `~/Library/Application Support/BucksBrowser/source` |
| Electron binary checked | `node_modules/electron/dist/electron` | `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` |
| Kubo by hand, if both downloads fail | `~/.config/Bucks Browser/kubo/bin/ipfs` (or under `$XDG_CONFIG_HOME`) | `~/Library/Application Support/Bucks Browser/kubo/bin/ipfs` |
| Launchers | `~/.local/bin/bucks-browser` (adds `--no-sandbox` only when installed as root) and `~/.local/share/applications/bucks-browser.desktop` | `~/Applications/Bucks Browser.app` (Info.plist with bundle id `com.mikado.bucksbrowser.source`, `Contents/MacOS/bucks-browser`, `Contents/Resources/icon.icns` from `build/icons/`) and `~/.local/bin/bucks-browser`; the bundle is built in a staging folder and swapped in |
| PATH note | Prints `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc` when `~/.local/bin` is not on `PATH` (on Ubuntu, logging out and in also works) | Prints the same line for `~/.zprofile` (or `~/.bash_profile` for bash users) |
| Never does | `sudo` (it only prints the package-manager commands for you to run) | `sudo`, anything outside your home folder, Gatekeeper changes; `xattr` is only used to clear a quarantine flag on the bundle it just made, if one is present |

Both launchers put the directory of the `node` the installer used at the front of `PATH`. Apps
started from the application menu or Finder do not get your shell's `PATH` (nvm and Homebrew set
it in shell startup files), and the in-app updater runs `npm`.

Testing the scripts: `bash -n` and `shellcheck -s bash scripts/install-*.sh` should be clean
(`pip install --user shellcheck-py` provides `shellcheck`). Run the Linux one with
`BUCKS_DIR=/tmp/somewhere bash scripts/install-linux.sh`; note that it clones the branch from
GitHub, not your working tree.

## fetch-kubo.mjs details

```
node scripts/fetch-kubo.mjs [--platform linux|win32|darwin] [--arch x64|arm64] [--version vX.Y.Z]
                            [--all-arch] [--force] [--skip-checksum] [--out-dir <dir>]
```

- Output: `resources/kubo/<os>-<arch>/ipfs` (`ipfs.exe` on Windows), `<os>` being `linux`, `win`
  or `mac`. `--out-dir` replaces `resources/kubo`. An existing binary is kept unless `--force`.
- Mirrors, in order: `KUBO_DIST_URL` when set (any server with the `dist.ipfs.tech` layout),
  `https://dist.ipfs.tech/kubo`, then GitHub releases
  (`https://github.com/ipfs/kubo/releases/download/<version>/kubo_<version>_<os>-<arch>.tar.gz`,
  `.zip` on Windows). A failure on one mirror (network, HTTP error, bad or missing checksum) moves
  on to the next; when all fail, the error lists each mirror and its reason.
- Each archive is verified against the `.sha512` from the same mirror. `--skip-checksum` lets a
  mirror without checksums through, with a warning.
- Version: `--version`, otherwise the latest stable one from the mirrors, otherwise v0.43.1.
- `HTTPS_PROXY` is honoured: the script re-runs itself with `NODE_USE_ENV_PROXY=1` (Node 22.21+).
- `--help` prints the mirror list as it will be used.

## dev.mjs details

- Starts `npm run dev` in `ui/` unless a Vite server already answers on `http://localhost:1420`, in
  which case it reuses that server and leaves it running on exit.
- Polls `http://localhost:1420/@vite/client` for up to 60 s, so another program holding the port is
  never mistaken for Vite.
- On Linux as root it appends `--no-sandbox` to the Electron arguments.
- Ctrl+C, SIGTERM, closing the Electron window or the dev server exiting stops both children (and
  everything they started). Exit code is 0 for a requested stop, otherwise the code of whichever
  child failed.
- Works on Windows: `npm` is started through the shell there, and process trees are ended with `taskkill /T`.

## electron-compat.mjs

Makes `node_modules/electron` a version this machine can run. Electron 44 and later need macOS 13,
so on macOS 12 it runs `npm install --no-save electron@43` (package.json and package-lock.json are
not changed). It does nothing on Linux, Windows and macOS 13 or newer, and refuses macOS 11 and
older. `scripts/install-macos.sh` runs it after `npm install`; the in-app updater applies the same
rule (`src/main/electron-compat.js`). `--check` prints what it would do without changing anything.
