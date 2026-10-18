# Bucks Browser

Bucks Browser is a desktop web browser built on Electron where `ipfs://` and `ipns://` addresses
are first-class. It ships with a local [Kubo](https://github.com/ipfs/kubo) (IPFS) node that it
starts, supervises and stops for you, so content-addressed pages load from your own node instead
of a third-party gateway. Ordinary `https://` browsing works as in any Chromium-based browser,
with privacy-protective defaults turned on.

> Screenshot placeholder: add `docs/images/bucks-browser.png` and embed it here.

## What it does

- **IPFS and IPNS in the address bar.** Type `ipfs://<cid>/path` or `ipns://<name>`. Every CID gets
  its own web origin, so one IPFS site cannot read another's storage or cookies.
- **Embedded Kubo node.** Downloaded (or bundled), initialised, configured and supervised by the
  app. It restarts after a crash and shuts down when you quit. You can point the browser at an
  existing node instead.
- **Your devices, connected.** Pair your own computers (Linux and macOS) and send files between them
  over IPFS peering and pubsub, see [docs/DEVICES.md](docs/DEVICES.md).
- **Local-first.** Your settings, bookmarks, history, pins and node repository live on your machine.
  The public gateway is only a fallback when the local node is not running.
- **Privacy defaults.** HTTPS-only mode, ad and tracker blocking, third-party cookie blocking,
  and a deny-by-default permission policy (camera, microphone, location, notifications and
  device access are refused). Every tab is a sandboxed Chromium renderer, with Chromium's
  per-site process isolation.
- **Built-in assistant.** An address-bar agent that can run on offline rules, a Bucks agent server
  or a local Ollama model.
- **Wallet.** A wallet page that signs in the interface and talks to a Bucks node over HTTP.

## Install on Linux (test build)

Run this in a terminal. It needs `git`, `curl` and Node.js 20 or newer. It downloads the code, builds it and adds a launcher and an application menu entry:

```bash
curl -fsSL https://raw.githubusercontent.com/infin8sync69-source/Bucks-browser/electron-main/scripts/install-linux.sh | bash
```

Run the same command again to update to the latest commit. Start the browser with `bucks-browser` or from your application menu. The installer also downloads the IPFS node (Kubo), from `dist.ipfs.tech` or, if that is blocked, from GitHub; if both fail, the first start tries again. The `raw.githubusercontent.com` copy of the script can lag a few minutes behind a new commit.

## Install on macOS (test build)

For Apple Silicon and Intel Macs with macOS 13 (Ventura) or newer. Run this in Terminal as your normal user (no `sudo`):

```bash
curl -fsSL https://raw.githubusercontent.com/infin8sync69-source/Bucks-browser/electron-main/scripts/install-macos.sh | bash
```

It needs:

- `git`: Apple's Command Line Tools (the installer tells you to run `xcode-select --install` if they are missing), or Homebrew's `git`.
- Node.js 20 or newer with npm: `brew install node@22` with Homebrew, or `nvm install 22` with [nvm](https://github.com/nvm-sh/nvm).

The installer checks all of this first and lists everything that is missing in one go. It keeps the code in `~/Library/Application Support/BucksBrowser/source`, builds it, downloads the IPFS node, and creates **Bucks Browser** in the Applications folder inside your home folder (`~/Applications/Bucks Browser.app`): open it from Finder, from Spotlight, or with `open ~/Applications/"Bucks Browser.app"`. It also adds a `bucks-browser` command in `~/.local/bin`. Nothing is installed outside your home folder, and Gatekeeper is left alone. Run the same command again to update.

When Bucks starts, macOS may ask whether it may accept incoming network connections and (macOS 15 and later) find devices on your local network. Allow both if you want to connect the Mac to your other computers; see [docs/DEVICES.md](docs/DEVICES.md). This is a source install: it has the Bucks icon, but the menu bar and the Dock label call it "Electron". Packaged, unsigned `.dmg` builds are described in [docs/BUILDING.md](docs/BUILDING.md).

## Quick start

You need Node.js 22 (`package.json` requires 20 or newer) and a Git checkout of this repository.

```sh
npm install        # installs the app, and ui/ through the postinstall hook
npm run dev        # starts the Vite dev server for the chrome and launches Electron against it
```

On first start the app looks for a Kubo binary; if it finds none it downloads one into your user
data directory. To bundle one in the checkout instead (needed for packaging, useful offline):

```sh
npm run fetch:kubo
```

`npm run dev` adds `--no-sandbox` automatically when you run as root on Linux (containers, CI).
Changes in `ui/src` hot-reload; changes in `src/main` need a restart of `npm run dev`.
`node scripts/dev.mjs --check` verifies the setup without starting anything.

Other useful commands:

| Command | What it does |
|---|---|
| `npm start` | Build the chrome once, then run Electron against the build (no Vite) |
| `npm run check` | Type-check the chrome (svelte-check) and syntax-check the main process |
| `npm test` | Unit tests (`node --test`, no Electron needed) |
| `npm run test:e2e` | End-to-end smoke test with Playwright; needs `npm run build:ui` and a Kubo binary |

## Building installers

```sh
npm run dist:linux   # AppImage + deb
npm run dist:win     # NSIS installer + portable exe   (run on Windows)
npm run dist:mac     # dmg + zip                        (run on macOS)
```

Installers land in `release/`. Prerequisites per operating system, how Kubo is bundled, the
unsigned-build caveats and the CI pipeline are in [docs/BUILDING.md](docs/BUILDING.md).

## Using the IPFS features

- **Open content.** Type `ipfs://<cid>`, `ipfs://<cid>/some/file.html` or `ipns://<name>` in the
  address bar. `ipns://` accepts peer IDs (`k51…`, `12D3Koo…`) and DNSLink domains such as
  `ipns://en.wikipedia-on-ipfs.org`. CIDv0 identifiers (`Qm…`) are converted to CIDv1 for you,
  see [the architecture notes](docs/ARCHITECTURE.md#cidv0-and-cidv1).
- **Node dashboard.** Open `bucks://ipfs` for node status, peers and storage numbers, adding
  files or text to your node, browsing a path, and your pin list.
- **Publish.** Adding a file returns its CID, an `ipfs://` address and a gateway URL.
- **Pin.** Pinning keeps content on your node so it stays available and survives garbage collection.
- **Devices.** Pair your Bucks installs (for example an Ubuntu laptop and a MacBook) in the
  Devices section of `bucks://ipfs`, then use **Send to my devices** to offer a file to all of
  them. Devices on the same network find each other automatically; otherwise you paste a pairing
  address. It works over IPFS peering and pubsub, with no server in between. Setup, firewalls,
  security notes and troubleshooting: [docs/DEVICES.md](docs/DEVICES.md).
- **External node.** In Settings, switch the IPFS mode from `embedded` to `external` and enter the
  API address of a Kubo node you already run (for example `http://127.0.0.1:5001`). Bucks then
  uses that node and leaves its lifecycle alone. You can also prefer the public gateway
  (`ipfs.preferredGateway = public`) or change which one is used as the fallback.

## Agent providers

The assistant in the address bar can use one of three providers, chosen in Settings:

| Provider | What it is | Needs |
|---|---|---|
| `offline` (default) | Deterministic rules: open a URL, search the web, open the wallet, IPFS, settings or downloads pages | Nothing |
| `remote` | A Bucks agent server, called over HTTP (`POST <url>/api/v1/swarm/task`) | A running server; default URL `http://localhost:3000` |
| `ollama` | A local language model through [Ollama](https://ollama.com) | Ollama running; default `http://127.0.0.1:11434`, model `llama3.2` |

If the chosen provider cannot be reached, the assistant says so and falls back to the offline rules.

## Wallet

The wallet page generates keys and signs in the interface; the main process never sees them. It
just forwards already-signed requests to the Bucks node set in Settings (default
`http://127.0.0.1:8080`), and only accepts those calls from the app's own interface. The node
itself is not part of this repository; without one, the wallet page shows a connection error.
Keys are currently stored unencrypted in the browser profile; moving them into the operating
system's keychain is the first roadmap item, so treat this wallet as experimental.

## Project layout

```
src/main/        Electron main process (ES modules): window, tabs, protocols, Kubo, security, agent, wallet
src/preload/     The sandboxed preload script that exposes window.bucks to the interface
ui/              The browser interface (SvelteKit single-page app), served to the window as bucks://app/
scripts/         install-linux.sh and install-macos.sh (source installers), dev.mjs (developer runner),
                 fetch-kubo.mjs (download Kubo), check-main.mjs (syntax check)
test/            unit tests (node --test) and the Playwright smoke test
build/           icons used by the packagers
docs/            architecture, IPC contract, building, device pairing, roadmap
electron-builder.yml    packaging configuration
.github/workflows/      CI: checks, installers for Linux, Windows and macOS, tagged releases
```

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the processes, the `ipfs://` pipeline, the
  Kubo lifecycle and the security model.
- [docs/IPC-CONTRACT.md](docs/IPC-CONTRACT.md) is the exact list of channels between the interface
  and the main process.
- [docs/BUILDING.md](docs/BUILDING.md) covers building and releasing.
- [docs/DEVICES.md](docs/DEVICES.md) explains pairing computers and sending files between them.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for what is done and what is planned.

## Where the old code lives

This is a rewrite. The earlier implementations are kept in Git under the tag
`archive/pre-electron-rewrite`:

- `bucks-app/`: the Tauri (Rust) app, with the first Svelte interface.
- `legacy_v1/`: the first Electron version, with a Next.js shell.
- `legacy_v1/bucks-native-browser/`: a native C++ prototype using Qt WebEngine.

To look at it: `git checkout archive/pre-electron-rewrite`, or `git show archive/pre-electron-rewrite:<path>`.

## License

MIT, see [LICENSE](LICENSE).
