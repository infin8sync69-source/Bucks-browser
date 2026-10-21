# IPFS in the Bucks app (electron/): what came over from Bucks-browser

Date: 2026-10-21. Compared against Bucks-browser `electron-main` (`3556311`) and the newer, unmerged
`claude/great-tesla-5scve6` (`44a6d85`: hosting, the hosting CLI, apps).

The Bucks-browser IPFS code lives in `electron/hosting/` (an ES-module folder with its own
`package.json`). `electron/hosting-bridge.js` connects it to `main.js`. The Helia node in
`electron/ipfs-node.js` stays: the swarm, chat, feed, dWeb index and souls run on it.

## How the two nodes work together

| | Kubo (Bucks-browser's node) | Helia (this app's node) |
|---|---|---|
| Starts | At launch, unless `ipfs.autoStart` is `false` in `<userData>/hosting/settings.json` | At launch |
| Serves `ipfs://` | Every address while it runs, through the ported handler | Only while Kubo is not running |
| Serves `ipns://` | Every name; without Kubo the page offers to start it or (with consent) a public gateway | Never (it cannot resolve names) |
| Used for | Browsing, hosting sites, device pairing, the hosting CLI | Swarm, chat, feed, dWeb publish and search, souls |

Kubo is peered with the local Helia node (`linkLocalNode` in `hosting-bridge.js`), so a CID published
through Helia (dWeb studio, feed) loads through Kubo over bitswap, and the other way round.
`<userData>` is `~/.config/bucks-browser` on Linux, `~/Library/Application Support/bucks-browser` on
macOS and `%APPDATA%\bucks-browser` on Windows.

## Feature by feature

| Bucks-browser feature | Where it is here | Status | Checked by |
|---|---|---|---|
| Embedded Kubo: pinned v0.43.1 with its SHA-512 built in, dist.ipfs.tech then GitHub, init, config, restart after a crash, stop on quit | `hosting/src/main/ipfs/kubo.js`, `dist.js` (identical) | Done; starts at launch | `hosting` unit tests; `tests/ipfs.spec.js` |
| `ipfs://` and `ipns://`: per-CID origins, local gateway, DNSLink, range requests, `nosniff`, error pages, public gateway only after consent | `hosting/src/main/protocols/ipfs.js` via `hosting-bridge.js` | Done for every address (was: only sites hosted here) | `tests/ipfs.spec.js` |
| `stream` scheme privilege, no service workers on IPFS origins | `main.js` | Done | `tests/ipfs.spec.js` (published site in a tab) |
| `ipfs://` and `ipns://` in private tabs | `main.js` (handlers on the `bucks-private` session too) | Done (was: not served) | `tests/ipfs.spec.js` |
| Address bar: CIDv0 to CIDv1 base32, peer ids (`12D3Koo…`, `Qm…`) to `k51…` names, `ipfs://ipfs/<cid>` | `ipfs-url.js` (used by `renderer.js`) | Done (was: CIDv0 only, and `ipns://Qm…` became an invalid name) | `test/unit/ipfs-url.test.js` against `cid.js`; `tests/ipfs.spec.js` |
| RPC client, CID helpers | `hosting/src/main/ipfs/rpc.js`, `cid.js` (identical) | Done | `hosting` unit tests |
| Host a site: preflight (secrets, server code, size), SPA, `_redirects`, 404 page, an `ipns://` key per site, update, rollback, unpublish, CAR export, key backup and restore, health checks, remote pinning | `hosting/src/main/sites/*`, Sites panel (`sites-panel.js`) | Done | `hosting` unit and integration tests; `tests/ipfs.spec.js` |
| A Firebase web API key is a warning, not a block (Bucks-browser `af25c70`) | `hosting/src/main/sites/preflight.js` | Done (was: blocked publishing) | `preflight.test.js`, `folder.test.js` |
| Hosting from the command line | `hosting/scripts/site.mjs` | Done; default profile is now this app's `<userData>/hosting` (was: Bucks-browser's) | Published with the CLI, listed and served by the app |
| The Soul Engine proposes hosting, the browser performs it (Bucks-browser `f4eca94`) | `agent/soul_engine.py` (`site_*` remote tools), `agent-browser-control.js`, `hosting-bridge.js` | Done. Publishing and updating ask in a native dialog (Bucks-browser shows a card in its chat) | `agent/tests/test_site_tools.py`; `tests/ipfs.spec.js` (refused and approved publish) |
| No publishing without approval: `ipfs_upload_text` and `dweb_publish` removed from the engine | `agent/` | Done | `agent/tests/test_site_tools.py`, `test_ipfs_skills.py` |
| Pair your devices over Kubo peering and pubsub, send files, auto-pin | `hosting/src/main/ipfs/devices*.js`, Devices panel | Done; live from launch now that Kubo starts then | `hosting` integration test (two Kubo nodes); `tests/devices-panel.spec.js` |
| Kubo in installers; Kubo downloaded by the installer | `electron/package.json` (`extraResources`, `hosting:prepare`), `install.sh` | Done (was: installers had no `hosting/`, no `security/` and no Kubo) | `npm run pack`, then the packaged app: Kubo from `resources/kubo`, Helia online, `ipfs://` served |
| External node (`ipfs.mode: external`, `ipfs.externalApiUrl`), gateway choice (`ipfs.publicGateway`, `ipfs.preferredGateway`), `ipfs.storageMaxGB` | `hosting/src/main/ipfs/kubo.js` | Works, but only by editing `<userData>/hosting/settings.json`: there is no settings screen for it yet | `hosting` unit tests |
| `bucks://ipfs` dashboard: node status, peers and storage, start / stop / restart, add a file or text, browse a path, pin list | Sites panel shows the node and can start it; the Devices panel covers devices | Partly. Missing: add, browse and pin list for the Kubo node, stop and restart. (This app's own Helia features and the cluster file manager on :3939 are separate.) | |
| Apps installed from `ipfs://` / `ipns://` and run in containers (`great-tesla` `6e72098`, not merged into Bucks-browser `electron-main`) | | Not ported. About 1,400 lines in `src/main/apps`, its pages and the design system they use | |

## Running the checks

```bash
cd electron/hosting && npm install && npm run fetch:kubo && npm test   # 173 tests, real Kubo
cd electron && npm run test:unit                                        # includes ipfs-url and hosting-bridge
cd electron && npx playwright test tests/ipfs.spec.js tests/devices-panel.spec.js   # xvfb-run -a on headless Linux
cd agent && .venv/bin/python -m pip install pytest-asyncio \
  && IPFS_API_URL=http://127.0.0.1:5001 .venv/bin/python -m pytest tests/   # test_ipfs_skills needs a Kubo API
```
