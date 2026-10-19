# Feature parity with Bucks Core

Bucks Core is the Electron app in buckscore `Bucks-App/` (v1.1.0). This list holds every
user-facing feature it has, taken from its IPC channels, its `renderer.js` and its views, and where
each one stands in Bucks Browser. [ALIGNMENT.md](ALIGNMENT.md) explains why the two code bases
exist and how they are being merged.

Status: **✅ done** (tested end to end where it says so) · **🟡 partial** · **⏳ planned** · **— not
carried over** (reason given).

## Browser

| Feature | Bucks Core | Bucks Browser |
|---|---|---|
| Tabs: open, close, switch, restore after restart | ✅ | ✅ |
| Find in page (Ctrl/Cmd+F, match count, next/previous, match case) | ✅ | ✅ e2e |
| Tab menu: duplicate, pin, rename, colour, mute, close others / to the right, new tab to the right | ✅ | ✅ e2e |
| Reopen closed tab (Ctrl/Cmd+Shift+T) | ✅ | ✅ e2e |
| Spaces (separate sets of tabs, move a tab to a space) | ✅ | ✅ e2e |
| Private browsing | ✅ private window | ✅ private tabs (Ctrl/Cmd+Shift+N): own in-memory session, not saved, not in history, wiped when the last one closes; e2e |
| Print, save page as PDF | ✅ | ✅ PDF e2e |
| Zoom with indicator | ✅ | ✅ e2e (pill in the address bar, click to reset) |
| Mute a site | ✅ | ✅ e2e |
| Clear browsing data (history, cookies, cache, site data) | ✅ | ✅ cookies e2e |
| Set as default browser, open links from other apps | ✅ | ✅ (also ipfs:// and ipns://); Linux launchers and packages declare the MIME types |
| Ads and trackers blocked counter in the address bar | ✅ | ✅ |
| Connection indicator (secure, not secure, IPFS, file) | ✅ | ✅ |
| Bookmark star in the address bar | ✅ | ✅ |
| Address suggestions from history, bookmarks and open tabs | ✅ | ✅ e2e |
| Unpacked Chrome extensions | ✅ (loaded into the chrome's session too) | ✅ web tabs only; e2e |
| Split view (several pages in one tab) | ✅ | ⏳ |
| Light theme | ✅ | ⏳ |
| History, bookmarks, downloads pages | ✅ | ✅ |

## New tab and profile

| Feature | Bucks Core | Bucks Browser |
|---|---|---|
| App grid on the new-tab page | ✅ | ✅ (shows only the rows in use; all of them while arranging) |
| Clock, greeting with your name, date | ✅ | ✅ e2e |
| Live status cards: wallet balance, IPFS peers, agent | ✅ | ✅ e2e (each opens its page; nothing shown is a placeholder number) |
| Model picker on the agent card (on-device models with size, memory fit, download progress; cloud backends) | ✅ | ✅ e2e; also switches between Soul Engine, Ollama (its installed models), remote and offline |
| "Start a task" | ✅ | ✅ (focuses the command bar) |
| Peer knowledge / skill updates waiting for approval | ✅ | ✅ e2e (approve or deny on the new tab) |
| Widget library and board | ✅ (board hidden in the current build) | ✅ e2e: add, remove, reorder (drag or arrows), saved locally |
| Widgets: clock, weather, calendar, music, notes, space, agent, IPFS, markets | ✅ (weather, calendar, music, markets and space show fixed sample data) | ✅ World clock (other time zones), Weather (Open-Meteo for a city you choose), Today (your own agenda), Notes, Now playing (tabs playing sound), Spaces (your Spaces); agent and IPFS are the status cards. — Markets: no data source |
| Profile panel (name, bio, avatar, peer id, contact card, storage) | ✅ (storage bar is a fixed sample) | ✅ e2e; storage and peer count from the node; UUID derived from the peer ID left out (it identifies nothing) |

## Agent

| Feature | Bucks Core | Bucks Browser |
|---|---|---|
| Soul Engine (local model, tools, web research) | ✅ | ✅ e2e |
| Generative cards (tables, charts, checklists, …) and follow-up questions | ✅ | ✅ e2e |
| Chat threads with history | ✅ (stored by the Soul Engine) | ✅ e2e: kept by the browser, so they work with every provider; the last turns go with each question |
| Model / provider picker in the composer | ✅ | ✅ (the same picker as the new tab) |
| Attach files or CIDs to a question | ✅ | ✅ e2e: read in the main process and sent as text with the question (drag and drop works too) |
| Slash commands (`/wallet`, `/ipfs`, …) | ✅ | ✅ e2e: suggestions in the chat and the command bar; `/pdf` and `/ipfs-upload` run locally |
| Stop a running answer | ✅ | ✅ e2e (every provider) |
| Agent acts in the open tab, with your approval | ✅ | ✅ e2e with the real engine: clicks, typing and navigation always ask, even when the engine does not flag them; the card names the element. Fixed in both code bases: "click the Buy now button" was taken for a shopping search |
| Create documents and PDFs from an answer | ✅ | ✅ e2e: the engine's create_document / create_pdf / page_to_pdf, and Save as document / PDF on every answer |
| Split panes for the agent (pane_open, workspace_sweep) | ✅ | ⏳ with split view |
| MCP server for other AI tools | ✅ (no auth) | 🟡 server in `agent/` with a token gate; not started by the browser yet |

## IPFS and peers

| Feature | Bucks Core | Bucks Browser |
|---|---|---|
| `ipfs://` / `ipns://` browsing, add, pin, node dashboard | ✅ (Helia) | ✅ (Kubo) |
| Devices: pair your computers, send files | ✅ | ✅ e2e |
| Feed: follow peers, publish posts, upvote | ✅ | ⏳ batch D |
| dWeb: publish a site, search the index | ✅ | 🟡 hosting a site (publish, `ipns://` updates, rollback, key backup, health, SPA deep links) is done in the main process, e2e; screens not built yet, publish with `scripts/site.mjs` or the agent ([HOSTING.md](HOSTING.md)). The dWeb search index is ⏳ batch D |
| Storage dashboard | ✅ | 🟡 node stats on `bucks://ipfs` |
| Cluster: members, invites, votes, shared pins | ✅ | ⏳ batch D |
| Messages: end-to-end encrypted chat with peers | ✅ | ⏳ batch D (engine code in `src/main/chat/`) |

## Apps and wallet

| Feature | Bucks Core | Bucks Browser |
|---|---|---|
| App store with a catalogue of open-source web apps (install, preview, launch) | ✅ | ⏳ batch D |
| Built-in mini apps (calculator, clock, converter, notes, QR) | ✅ | ⏳ batch D |
| dWeb studio (site builder from templates) | ✅ | ⏳ |
| Wallet: create, restore, send | ✅ (keys on the node) | ✅ keys stay in the browser, signing client-side |
| Mining controls | ✅ | ⏳ batch D (UI over the node's mining API) |
| Universe and earth maps | ✅ | ⏳ |
| Chain and miner binaries bundled | ✅ (macOS arm64 only) | — not bundled; the wallet talks to a node over HTTP |
