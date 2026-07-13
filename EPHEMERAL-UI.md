# Bucks Browser — Ephemeral UI (Generative UI) Architecture

*Updated: 2026-07-07 — all trigger prompts below are verified against the live
Soul Engine (hermes3:latest via Ollama) with automated E2E SSE tests.*

The Ephemeral UI turns agent answers into **rendered, interactive components**
inside chat — product grids you can buy from, YouTube players you can watch,
image galleries with a lightbox, and multi-source research dossiers — instead
of walls of text.

---

## 1. Architecture (end to end)

```
User prompt (chat tab / nav chat / side panel)
   │
   ├─ renderer.js: isShoppingQuery / isMediaOrResearchQuery / classifyQuery
   │        → routes to POST :8765/agent  (Soul Engine, local FastAPI)
   │
   ▼
soul_engine.py  /agent  (SSE stream of typed events)
   │
   ├─ DETERMINISTIC INTENT PATHS (never depend on the LLM picking a tool)
   │     _is_shopping  → tools/shopping.py  product_lookup   → product_grid
   │     _is_video     → tools/media_tools  youtube_search   → video
   │     _is_images    → tools/media_tools  image_search     → image_gallery
   │     _is_research  → tools/research.py  deep_research    → research
   │                     (+ model-refined narrative streamed AFTER the dossier)
   │
   ├─ MODEL TOOL LOOP (hermes3 + tools/registry.py) for everything else
   │     web_search → list, fetch_url, calendar, IPFS, browser control…
   │     render_component tool → chart | table | stat_cards | cta_row
   │     empty-response guard → plain streamed completion (never "(no answer)")
   │
   ▼
SSE events: {type:"ui_component", component, title, data} + {type:"token"}…
   │
   ▼
renderer.js renderComponent(spec) → _GENUI_RENDERERS[component]
   (validated server-side by genui.validate_component; malformed specs
    fall back to plain text — a bad spec can never blank the UI)
```

**Component library** (`genui.py` builders ⇄ `renderer.js` renderers):

| Component | Purpose | Interactions |
|---|---|---|
| `answer` | rich markdown answer | links open tabs |
| `list` | clickable source cards | favicon, open in tab |
| `product_grid` | shopping results | filter/sort/view-more, View & Buy, 💬 Ask |
| `image_gallery` | image grid | tap → lightbox (full-size, open source, Esc) |
| `video` | **embedded YouTube player** + up-next rail | tap thumbnail → swaps player (autoplay) |
| `research` | dossier: hero image, summary, insight sections, image strip, source chips | tap section ↗ / source / image; follow-up CTAs |
| `stat_cards` | KPI figures | — |
| `table` | comparison matrix | — |
| `chart` | line/bar/pie (inline SVG) | — |
| `cta_row` | action buttons | navigate / search / agent / copy |

---

## 2. Use cases & user flows

### UC-1 · Shop for products (Amazon + e-commerce scraping)
**Flow:** type a buying query → deterministic `product_lookup` scrapes
Amazon (`amazon.in` → `amazon.com` fallback), then schema.org/OG extraction
from other retailer pages, then a live catalog fallback → `product_grid`
renders in ~1.5s with real prices, images, ratings, buy links → user filters
(price/rating), sorts, taps **View & Buy** (opens the retailer page in a real
tab), or **💬 Ask** to interrogate a product in chat → follow-up CTAs
(*Cheaper options / Top rated*) re-trigger the pipeline.

### UC-2 · Play YouTube videos in chat
**Flow:** "play …" / "watch …" → deterministic `youtube_search` scrapes
`ytInitialData` (DDG-videos fallback) → `video` component embeds the top
result in a `youtube-nocookie.com` player with an up-next rail of 8 →
tapping a rail thumbnail hot-swaps the player (autoplay) without leaving chat.

### UC-3 · In-depth research with images (dossier)
**Flow:** "research …" / "deep dive …" / "compare X vs Y" → `deep_research`
fans out: DDG text search → parallel fetch of ~4 distinct-domain sources →
readable-paragraph extraction → image search — all folded into a `research`
dossier (hero image, extract per source with ↗ links, image strip with
lightbox, source chips, *Go deeper / More images / Watch videos* CTAs) that
renders in seconds; **then** the model streams a refined, citation-linked
briefing synthesized ONLY from the gathered corpus, ending in `<followup>`
chips.

### UC-4 · Browse + search
**Flow:** "search the web for …" → model loop calls `web_search` → `list`
source cards render → refined narrative with markdown links → tap a card to
open the page in a tab; `/summarize <url>`, `/scrape <url>`, `/links <url>`
feed pages back into chat. `/agent` mode additionally drives the LIVE tab
(read page / click / type, approval-gated).

### UC-5 · Chat
Plain conversation bypasses the agent (router → `/chat`) and streams directly
from the model with RAG memory — no components, no tool latency.

### UC-6 · Generative visuals (model-initiated)
For comparisons/metrics the model itself calls `render_component`
(table/chart/stat_cards/cta_row). Specs are validated (`genui.validate_component`,
`data_json` string-decoding for local-model quirks); invalid specs degrade to text.

---

## 3. Trigger prompts — verified matrix

Every row below was executed against the live engine (automated SSE test,
8/8 PASS + supplementary cases):

| # | Prompt | Path | Component (verified) | Latency |
|---|--------|------|----------------------|---------|
| 1 | `buy wireless earbuds under 2000` | deterministic shopping | `product_grid` (12 items) | 1.6s |
| 2 | `find me the best deals on running shoes` | deterministic shopping | `product_grid` (12 items) | 1.4s |
| 3 | `play lofi hip hop radio` | deterministic video | `video` (8 videos, playable embed) | 1.1s |
| 4 | `watch the interstellar trailer` | deterministic video | `video` (8 videos) | 1.0s |
| 5 | `show me images of the taj mahal` | deterministic images | `image_gallery` (12 images) | 2–7s |
| 6 | `photos of northern lights` | deterministic images | `image_gallery` (12 images) | 2.0s |
| 7 | `research quantum computing breakthroughs 2026` | deterministic research | `research` (4 sections, hero, 6-img strip) + 2.1k-char refined briefing | ~20s |
| 8 | `deep dive into electric vehicle battery technology` | deterministic research | `research` + refined briefing | ~12s |
| 9 | `compare iphone 16 vs samsung galaxy s25` | deterministic research (compare/vs) | `research` + comparison narrative | ~15s |
| 10 | `search the web for the latest AI agent frameworks` | model loop → `web_search` | `list` + linked narrative + followups | ~24s |
| 11 | `what's the weather in mumbai today` | model loop → `web_search` | `list` + answer | ~8s |
| 12 | `hello! who are you?` | router → `/chat` | plain streamed tokens | <2s |

**Slash commands** (autocomplete in every chat input): `/product-lookup`,
`/images`, `/video` (alias `/play`), `/research`, `/search`, `/scrape`,
`/summarize`, `/links`, `/agent` … — each translates to the natural-language
trigger above, so they hit the same verified paths.

**Router keywords** (`/router/classify`): media/research/shopping phrasings
classify `domain:agent` (verified); greetings classify `domain:chat`.

---

## 4. Reliability rules (why prompts give expected output)

1. **Deterministic-first.** The four marquee intents are regex-detected
   (`_is_shopping/_is_video/_is_images/_is_research`, mirrored client-side in
   `isShoppingQuery/isMediaOrResearchQuery`) and run their pipeline directly —
   the 8B model is never trusted to pick the marquee tools.
2. **Layered scrape fallbacks.** Amazon → schema.org → catalog; DDG images →
   Bing top-up (thin-result guard); ytInitialData → DDG videos.
3. **Validated specs.** Every `ui_component` passes `genui.validate_component`
   allow-list; renderer-side, video ids are re-checked (`^[\w-]{6,20}$`) and
   media attributes are quote-escaped (`_gu_attr`) — no spec can inject markup.
4. **No dead ends.** Empty model responses fall back to a plain streamed
   completion; failed pipelines return an actionable text note instead of an
   empty component.
5. **Ordering for playback.** The video path streams its text *before* the
   component so chat-thread re-renders never reload the iframe mid-answer.

---

## 5. Model switching (inbuilt-only)

The agent runs exclusively on local open-source models. Active: **hermes3:latest**
(8B, tools-capable — best local tool-caller tested). To switch:

```bash
# agent/.env
MODEL_PROVIDER=ollama
BUCKS_MODEL=hermes3:latest     # ← swap to any tools-capable Ollama model
```

Installed alternatives: `qwen2.5:3b` (faster, weaker refinement),
`llama3:latest` (no native tool tags — deterministic paths still work),
`qwen3-vl:30b` (adds vision; heavy). `BUCKS_VISION_MODEL` controls screenshot
grounding (default `llava`). In `MODEL_PROVIDER=edge` mode the embedded
llama-cpp catalog is switchable live via `GET /models` + `POST /models/select`.
Because the marquee flows are deterministic, they behave identically on every
model; model choice only affects research-refinement prose quality and the
free-form tool loop.

---

## 6. Files

| Layer | File |
|---|---|
| Engine + intents + SSE | `agent/soul_engine.py` |
| Component builders + validation | `agent/genui.py` |
| Image/YouTube tools | `agent/tools/media_tools.py` |
| Research pipeline | `agent/tools/research.py` |
| Product scraping | `agent/tools/shopping.py` |
| Tool registry | `agent/tools/registry.py` |
| Renderers + lightbox + player + routing | `electron/renderer.js` |
| Component styles | `electron/styles.css` (`gu-*`) |

Runtime copy for the packaged app synced at `~/.bucks/agent/`.
