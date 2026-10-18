# Building Bucks Browser

This page covers running from source, building installers for Linux, Windows and macOS, how the
IPFS node (Kubo) is bundled, what to expect from unsigned builds, and how CI works.

## Prerequisites

All platforms:

- Node.js 22 (`package.json` requires 20 or newer) with npm 10, and Git.
- Internet access during `npm install` (Electron, about 100 MB), `npm run fetch:kubo` (the Kubo
  archive, from `dist.ipfs.tech` or GitHub releases, see [Kubo bundling](#kubo-bundling)) and the
  first `electron-builder` run (packaging helpers, downloaded from GitHub releases and cached).

Per operating system:

| OS | Needed to run from source | Needed to build installers |
|---|---|---|
| Linux | The libraries Chromium needs: GTK 3, NSS, `libxss1`, `libxtst6`, `libasound2`, `libgbm1` and an X11 or Wayland session. On a headless machine add `xvfb` and run through `xvfb-run -a`. | Nothing more. `electron-builder` downloads its AppImage and `fpm` helpers. To run an AppImage the target machine needs FUSE 2 (`libfuse2`). |
| Windows | Windows 10 or newer. | Nothing more (no native modules, so no Visual Studio build tools). Build on Windows: cross-building from Linux or macOS would need Wine and is not supported here. |
| macOS | macOS 13 (Ventura) or newer, Apple Silicon or Intel: Electron 44 does not start on older versions. Git from Apple's Command Line Tools (`xcode-select --install`) or Homebrew. | Build on macOS: the `.dmg` is made with the system's `hdiutil`. Xcode is not needed. |

The app has no native Node modules, so `npmRebuild` and `nodeGypRebuild` are off in
`electron-builder.yml`.

## Running from source

```sh
npm install        # root dependencies; the postinstall hook also installs ui/
npm run dev        # Vite dev server on http://localhost:1420 + Electron pointed at it
```

`scripts/dev.mjs` starts `npm run dev` inside `ui/`, waits up to 60 s for Vite to answer, then starts
Electron with `BUCKS_DEV_URL=http://localhost:1420` and `BUCKS_DEBUG=1`. Extra arguments go to
Electron (`npm run dev -- --user-data-dir=/tmp/bucks-profile`). It adds `--no-sandbox` when you
are root on Linux. Ctrl+C, closing the window, or the dev server dying stops everything.
`node scripts/dev.mjs --check` verifies the Electron binary and `ui/` and exits without starting anything.

Without Vite: `npm start` builds the chrome (`npm run build:ui`) and runs Electron against `ui/build`.
Use `BUCKS_USER_DATA=/path` to keep a throw-away profile apart from your real one.

## Source installs (install-linux.sh, install-macos.sh)

For testers who want the app without packaging it, `scripts/install-linux.sh` and
`scripts/install-macos.sh` turn a Git checkout into a launchable app. Both are meant to be piped
from GitHub (`curl -fsSL https://raw.githubusercontent.com/infin8sync69-source/Bucks-browser/electron-main/scripts/install-<os>.sh | bash`),
check every prerequisite first and report all problems at once, clone or fast-forward the branch
(`BUCKS_BRANCH`, default `electron-main`) into `BUCKS_DIR`, run `npm install`, make sure the
Electron binary really arrived (retrying `node node_modules/electron/install.js` once), pre-download
Kubo with `node scripts/fetch-kubo.mjs` (not fatal: the app downloads it at first start otherwise),
run `npm run build:ui` and add a launcher. Running the command again updates the checkout. See
[scripts/README.md](../scripts/README.md) for the exact behaviour of each.

### macOS notes

- **What it creates.** The checkout goes to `~/Library/Application Support/BucksBrowser/source`.
  `~/Applications/Bucks Browser.app` is a small launcher bundle made by the script: an `Info.plist`
  (bundle id `com.mikado.bucksbrowser.source`, version from `package.json`,
  `LSMinimumSystemVersion` 13.0), the icon from `build/icons/icon.icns`, and
  `Contents/MacOS/bucks-browser`, a bash script that runs
  `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` with the checkout as the app.
  `~/.local/bin/bucks-browser` is the same script for terminal use. The profile, settings and
  the IPFS repository live in `~/Library/Application Support/Bucks Browser/`, the same folder a
  packaged build uses.
- **Unsigned, but not quarantined.** The launcher is not code-signed. It is created on the Mac
  itself, so it carries no quarantine flag and Gatekeeper does not block it; the script never uses
  `sudo`, never writes outside your home folder and does not change Gatekeeper settings. Electron
  is downloaded by npm and Kubo by `fetch-kubo.mjs`, neither of which quarantines files.
- **Apple Silicon and Intel.** Electron and Kubo are installed for the architecture of the Node.js
  that runs the installer (`node -p process.arch`). On Apple Silicon with an Intel Node.js, or from
  a Terminal opened with Rosetta, the installer warns that the slower Intel builds would be used.
- **How it looks.** The Dock icon is the Bucks icon, but because the running process is Electron's
  own app, the menu bar and the Dock label say "Electron". Packaged builds do not have this quirk.
- **PATH.** Apps opened from Finder get a minimal `PATH`. The launcher puts the directories of the
  `node` and `git` the installer used first, so the in-app updater (`git pull`, `npm install`,
  `npm run build:ui`) finds them. If you later remove that Node.js version, run the installer again.
- **Network prompts.** On first start macOS may ask whether `ipfs` or `Electron` may accept incoming
  connections and, on macOS 15 and later, whether the app may find devices on the local network.
  Both are needed to connect to other computers, see [DEVICES.md](DEVICES.md).
- **Uninstall.** Quit Bucks, then delete `~/Applications/Bucks Browser.app`,
  `~/.local/bin/bucks-browser` and `~/Library/Application Support/BucksBrowser/`. Also delete
  `~/Library/Application Support/Bucks Browser/` to remove your profile and IPFS repository.
- **Packaged builds are separate.** `npm run dist:mac` builds an unsigned `.dmg` and `.zip` with
  electron-builder (next sections). Install those in `/Applications`; the source installer refuses
  to overwrite a `~/Applications/Bucks Browser.app` it did not create.

## Building installers

Run these on the operating system you are building for.

```sh
npm install
npm run dist           # chrome + Kubo for this machine + installers for this OS
npm run dist:linux     # AppImage and deb
npm run dist:win       # NSIS installer and portable exe
npm run dist:mac       # dmg and zip
```

Each script does three things: build the interface (`npm run build:ui`, output in `ui/build`),
fetch the Kubo binary for the target platform (see below), then run `electron-builder`.
Output goes to `release/` (git-ignored):

| Platform | Files |
|---|---|
| Linux | `Bucks Browser-<version>-linux-x86_64.AppImage`, `Bucks Browser-<version>-linux-amd64.deb` |
| Windows | `Bucks Browser-Setup-<version>-win-x64.exe`, `Bucks Browser-Portable-<version>-win-x64.exe` |
| macOS | `Bucks Browser-<version>-mac-<arch>.dmg`, `Bucks Browser-<version>-mac-<arch>.zip` |

(`<arch>` is spelled the way each package format expects: `x86_64` for AppImage, `amd64` for deb.)
`release/<os>-unpacked/` (or `release/mac*/`) holds the unpacked application, useful for a quick test.

### One architecture at a time

The `dist:*` scripts build for the machine's own architecture. For a specific one, run the steps by hand:

```sh
npm run build:ui
node scripts/fetch-kubo.mjs --platform darwin --arch x64      # or arm64, linux, win32
npx electron-builder --mac --x64 --publish never              # or --arm64
```

On an Apple Silicon Mac, `--x64` produces an Intel build and vice versa; this is how CI makes both.

### Packaging without installers

`npx electron-builder --linux dir --publish never` (or `--win dir`, `--mac dir`) only produces the
unpacked app. It is a fast way to check what gets packaged. The packaged app contains `src/`,
`ui/build/`, `package.json`, the production dependencies in `app.asar`, and Kubo in
`resources/kubo/` next to it (outside the archive, so it can be executed).

If `electron-builder` cannot reach GitHub, you can reuse the Electron you already installed:
`npx electron-builder --linux dir -c.electronDist=node_modules/electron/dist`. Only do that for the
machine's own architecture. Helper tools for AppImage/deb/NSIS are still downloaded.

## Kubo bundling

The embedded IPFS node is the official Kubo binary. It is not committed; it is fetched into
`resources/kubo/<os>-<arch>/` where `<os>` is `linux`, `win` or `mac` (electron-builder's `${os}`
macro) and `<arch>` is `x64` or `arm64`:

```sh
npm run fetch:kubo                                   # this machine
node scripts/fetch-kubo.mjs --platform win32 --arch x64
node scripts/fetch-kubo.mjs --all-arch --platform darwin   # x64 and arm64
node scripts/fetch-kubo.mjs --version v0.43.1        # pin a version (default: latest stable)
node scripts/fetch-kubo.mjs --force                  # re-download
```

- Mirrors are tried in order: `KUBO_DIST_URL` when set (any mirror with the `dist.ipfs.tech`
  layout), `https://dist.ipfs.tech/kubo`, then GitHub releases
  (`https://github.com/ipfs/kubo/releases/download/<version>/kubo_<version>_<os>-<arch>.tar.gz`).
  So a network that blocks `dist.ipfs.tech` still gets Kubo from GitHub. The latest stable version
  is read from the same mirrors; if none answers, v0.43.1 is used. The app's own first-start
  download uses the same list, through Electron's network stack (so it follows the system proxy).
- Every archive is checked against the SHA-512 published by the same mirror. `--skip-checksum`
  continues with only a warning, for mirrors that do not host checksums.
- `HTTPS_PROXY` is honoured (the script re-runs itself with `NODE_USE_ENV_PROXY=1`, which needs
  Node 22.21 or newer).
- `electron-builder.yml` copies `resources/kubo/${os}-${arch}` to `resources/kubo/` in the package:
  `<install dir>/resources/kubo/ipfs` (`ipfs.exe` on Windows, `Contents/Resources/kubo/ipfs` on macOS).
  At runtime `src/main/ipfs/kubo.js` looks for exactly that path first.
- **If the directory is missing, `electron-builder` only prints "file source doesn't exist" and carries
  on.** The installer then has no bundled node and downloads one at first start (needs internet). CI
  always fetches Kubo first, so release installers include it.

## Installing on Linux

Debian and Ubuntu (recommended; it also registers the `ipfs://` and `ipns://` link handlers and an
AppArmor profile on Ubuntu 24.04 and later):

```sh
sudo apt install ./"release/Bucks Browser-2.0.0-linux-amd64.deb"
bucks-browser
```

It installs to `/opt/Bucks Browser/` and adds `bucks-browser` to `/usr/bin` and the application menu.
Remove it with `sudo apt remove bucks-browser`.

AppImage (any distribution):

```sh
chmod +x "Bucks Browser-2.0.0-linux-x86_64.AppImage"
./"Bucks Browser-2.0.0-linux-x86_64.AppImage"
```

If it does not start: install `libfuse2` (Ubuntu 22.04 and later do not ship it), or run with
`--appimage-extract-and-run`. On Ubuntu 24.04 and later, unprivileged user namespaces are
restricted by AppArmor, so Chromium's sandbox cannot start from an AppImage and the app exits with a
sandbox error; use the deb package, or accept the weaker setup by launching with `--no-sandbox`.
Do not use `--no-sandbox` for everyday browsing if you can avoid it.

## Unsigned builds: what users will see

Installers are not code-signed yet.

- **macOS.** Gatekeeper refuses to open a downloaded, unsigned app. Control-click (right-click) the app
  and choose *Open*, then confirm; or allow it in *System Settings > Privacy & Security > Open Anyway*.
  On Apple Silicon a downloaded unsigned app may be reported as "damaged"; clear the quarantine flag
  with `xattr -dr com.apple.quarantine "/Applications/Bucks Browser.app"`.
- **Windows.** SmartScreen shows "Windows protected your PC" for the installer and portable exe. Choose
  *More info* then *Run anyway*.
- **Linux.** No signing step. Compare the SHA-256 of the download with the one you publish.

Follow-ups, none of which need code changes beyond the configuration noted in
`electron-builder.yml`:

1. Windows: buy or obtain a code-signing certificate and set `CSC_LINK` and `CSC_KEY_PASSWORD`
   (repository secrets, passed to the "Build installer" step).
2. macOS: Apple Developer ID certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`) and notarisation
   (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); remove `identity: null` and set
   `hardenedRuntime: true` in the `mac` section.
3. Auto-update (`electron-updater`) once builds are signed and published to a feed.

## Continuous integration

`.github/workflows/build.yml` runs on pushes to `master` and `electron-main`, on pull requests, and on
tags that start with `v`. A new push to the same ref cancels the previous run (tag builds are never
cancelled).

| Job | Runs on | What it does |
|---|---|---|
| `check` | ubuntu | `npm ci`, `npm run check`, `npm test` |
| `build` (4 legs) | ubuntu: linux x64; windows: win x64; macOS: arm64 and x64 | `npm ci`, `npm run build:ui`, `fetch-kubo.mjs` for that platform and architecture, `electron-builder --<os> --<arch> --publish never`, uploads `release/*.{AppImage,deb,exe,dmg,zip}` as the artifact `bucks-<os>-<arch>`. The Linux leg also boots the unpacked app under Xvfb and waits for the bundled Kubo to become ready. Electron and electron-builder downloads are cached. |
| `release` | ubuntu | Only on a `v*` tag: downloads every artifact and creates a GitHub release with generated notes. Tags with a hyphen (`v2.1.0-rc.1`) are marked as pre-releases. |

To cut a release: set `version` in `package.json` (and keep `ui/package.json` in step), commit, then
`git tag v2.1.0 && git push origin v2.1.0`. The build fails early when the tag and `package.json`
disagree. The workflow contains no secrets and does no signing; see the follow-ups above.

The unit tests that need a real Kubo binary skip themselves in CI because none is present when
`npm test` runs; run `npm run fetch:kubo && npm test` locally to include them. The Playwright smoke
test (`npm run test:e2e`) is not part of CI.

## Troubleshooting

- **`The SUID sandbox helper binary was not found` or a sandbox error on Linux.** Running as root or in a
  container: add `--no-sandbox` (`npm run dev` does this for root). Packaged apps must not hard-code
  it.
- **Blank window in dev.** Check that Vite runs on port 1420 (`strictPort` makes it fail rather than
  pick another port) and that nothing else uses the port.
- **"The Bucks Browser chrome has not been built."** The packaged or `npm start` build has no `ui/build`;
  run `npm run build:ui`.
- **`electron-builder` times out downloading helpers.** Set `ELECTRON_MIRROR`/`ELECTRON_BUILDER_BINARIES_MIRROR`,
  or build on a machine with direct access to GitHub.
- **Kubo download fails.** Run `node scripts/fetch-kubo.mjs` and read which mirror failed and why.
  Then place a binary at `resources/kubo/<os>-<arch>/ipfs` in the checkout, or in the profile at
  `kubo/bin/ipfs` (`~/.config/Bucks Browser/` on Linux, `~/Library/Application Support/Bucks Browser/`
  on macOS, `%APPDATA%\Bucks Browser\` on Windows, as `ipfs.exe`); point `BUCKS_KUBO_BIN` at one; or
  set `KUBO_DIST_URL`. [DEVICES.md](DEVICES.md#installing-the-ipfs-node-by-hand) has the commands.
