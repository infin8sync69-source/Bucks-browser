# scripts

Small Node scripts used by `package.json` and CI. They are plain ES modules and need Node 20+.

| Script | npm command | Purpose |
|---|---|---|
| `dev.mjs` | `npm run dev` | Developer runner: starts the Vite dev server in `ui/` (port 1420, strict), waits for it, then launches Electron with `BUCKS_DEV_URL` and `BUCKS_DEBUG=1`. Extra arguments are passed to Electron. `--check` validates the setup and exits. |
| `fetch-kubo.mjs` | `npm run fetch:kubo` | Downloads the Kubo binary (SHA-512 verified) into `resources/kubo/<os>-<arch>/` for packaging. Options: `--platform`, `--arch`, `--all-arch`, `--version`, `--force`, `--skip-checksum`. |
| `check-main.mjs` | part of `npm run check` | Syntax-checks every file under `src/` and `scripts/` with `node --check`, without starting Electron. |

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
