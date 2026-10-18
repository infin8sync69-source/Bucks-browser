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
| App grid on the new-tab page | ✅ | ✅ |
| Widgets board (clocks, greeting, notes, status cards) and widget library | ✅ | ⏳ batch B |
| Profile panel (name, bio, avatar, peer id) | ✅ | ⏳ batch B |

## Agent

| Feature | Bucks Core | Bucks Browser |
|---|---|---|
| Soul Engine (local model, tools, web research) | ✅ | ✅ e2e |
| Generative cards (tables, charts, checklists, …) and follow-up questions | ✅ | ✅ e2e |
| Chat threads with history | ✅ | ⏳ batch C |
| Model / provider picker in the composer | ✅ | ⏳ batch C |
| Attach files or CIDs to a question | ✅ | ⏳ batch C |
| Slash commands (`/wallet`, `/ipfs`, …) | ✅ | ⏳ batch C |
| Agent acts in the open tab, with your approval | ✅ | ⏳ batch C |
| Create documents and PDFs from an answer | ✅ | ⏳ batch C |
| MCP server for other AI tools | ✅ (no auth) | 🟡 server in `agent/` with a token gate; not started by the browser yet |

## IPFS and peers

| Feature | Bucks Core | Bucks Browser |
|---|---|---|
| `ipfs://` / `ipns://` browsing, add, pin, node dashboard | ✅ (Helia) | ✅ (Kubo) |
| Devices: pair your computers, send files | ✅ | ✅ e2e |
| Feed: follow peers, publish posts, upvote | ✅ | ⏳ batch D |
| dWeb: publish a site, search the index | ✅ | ⏳ batch D |
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
