"""
Deep research pipeline — the "gather in-depth insight" tool.

One call fans out to: web search (top sources) → parallel page fetch + clean
text extraction → image search — and folds everything into a single `research`
dossier component (hero image, per-source insight sections, image strip,
source cards, follow-up actions). See genui.research_component.

Returns {"text", "_ui"}:
  text — the gathered corpus, trimmed for the model. The Soul Engine streams a
         model-refined narrative AFTER the component renders, so the user gets
         the visual dossier instantly and the refined prose seconds later.
  _ui  — the research component spec.
"""
from __future__ import annotations

import asyncio
import logging
import re
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

log = logging.getLogger("bucks.tools.research")

_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
_HEADERS = {"User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9"}

# Domains whose pages are apps/paywalls, not readable articles.
_SKIP_HOSTS = ("youtube.com", "facebook.com", "instagram.com", "x.com",
               "twitter.com", "tiktok.com", "pinterest.")


def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.replace("www.", "")
    except Exception:
        return ""


def _favicon(url: str) -> str:
    d = _domain(url)
    return f"https://www.google.com/s2/favicons?domain={d}&sz=64" if d else ""


def _text_search_sync(query: str, max_results: int) -> list[dict]:
    try:
        try:
            from ddgs import DDGS
        except ImportError:
            from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            return [
                {"title": r.get("title", ""), "url": r.get("href") or r.get("url", ""),
                 "snippet": r.get("body", "")}
                for r in ddgs.text(query, max_results=max_results)
            ]
    except Exception as e:
        log.debug("ddgs text failed: %s", e)
        return []


async def _text_search(query: str, max_results: int = 8) -> list[dict]:
    results = await asyncio.to_thread(_text_search_sync, query, max_results)
    if results:
        return results
    # Fallback: DDG html endpoint (same one tools/registry.py uses).
    try:
        from tools.registry import _ddg_html_search
        raw = await _ddg_html_search(query, max_results)
        return [{"title": r["title"], "url": r["href"], "snippet": r["body"]} for r in raw]
    except Exception as e:
        log.debug("ddg html fallback failed: %s", e)
        return []


def _extract_readable(html: str, max_paras: int = 6) -> list[str]:
    """Pull the meaty paragraphs out of an article page."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "form"]):
        tag.decompose()
    paras = []
    for p in soup.find_all(["p", "li"]):
        t = re.sub(r"\s+", " ", p.get_text(" ", strip=True))
        # Real sentences only — skips menus, cookie banners, button labels.
        if len(t) >= 80 and t.count(" ") >= 10:
            paras.append(t)
        if len(paras) >= max_paras:
            break
    return paras


async def _fetch_source(client: httpx.AsyncClient, res: dict) -> dict | None:
    url = res.get("url", "")
    if not url or any(h in url for h in _SKIP_HOSTS):
        return None
    try:
        r = await client.get(url, headers=_HEADERS)
        if r.status_code != 200 or "text/html" not in r.headers.get("content-type", ""):
            return None
        paras = _extract_readable(r.text)
    except Exception:
        return None
    if not paras and not res.get("snippet"):
        return None
    return {
        "title": res.get("title") or _domain(url),
        "url": str(r.url),
        "domain": _domain(str(r.url)),
        "favicon": _favicon(str(r.url)),
        "snippet": res.get("snippet", ""),
        "paras": paras,
    }


async def deep_research(topic: str, max_sources: int = 4, max_images: int = 8):
    """Gather multi-source research + images + videos for `topic` and build the dossier."""
    from tools.media_tools import image_search, youtube_search

    # Search text, images, and videos in parallel with fast timeouts
    results_task = _text_search(topic, max_results=max_sources * 3)
    images_task = image_search(topic, max_results=max_images)
    videos_task = youtube_search(topic, max_results=4)
    results, images_raw, videos_raw = await asyncio.gather(results_task, images_task, videos_task, return_exceptions=True)

    images = []
    if isinstance(images_raw, dict):
        images = (images_raw.get("_ui") or {}).get("data", {}).get("items", [])

    videos = []
    if isinstance(videos_raw, dict):
        videos = (videos_raw.get("_ui") or {}).get("data", {}).get("items", [])

    if not isinstance(results, list):
        results = []

    sources: list[dict] = []
    if results:
        seen_hosts: set[str] = set()
        picked = []
        for res in results:
            host = _domain(res.get("url", ""))
            if not host or host in seen_hosts:
                continue
            seen_hosts.add(host)
            picked.append(res)
            if len(picked) >= max_sources * 2:
                break
        try:
            async with httpx.AsyncClient(timeout=2.0, follow_redirects=True) as c:
                fetched = await asyncio.gather(*(_fetch_source(c, r) for r in picked), return_exceptions=True)
            sources = [s for s in fetched if isinstance(s, dict) and s][:max_sources]
        except Exception:
            sources = []

        # Instant fallback to DDG search snippets if page scraping timed out
        if not sources and picked:
            sources = [{
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "domain": _domain(r.get("url", "")),
                "favicon": _favicon(r.get("url", "")),
                "snippet": r.get("snippet", ""),
                "paras": [r.get("snippet", "")]
            } for r in picked[:max_sources]]

    if not sources and not images and not videos:
        return (f"Couldn't gather research on “{topic}” right now — search "
                f"providers may be throttling. Try again in a moment.")

    # ── Build the dossier component ────────────────────────────────────────────
    sections = []
    for s in sources:
        body = " ".join(s["paras"][:2]) if s.get("paras") else s.get("snippet", "")
        sections.append({
            "heading": s["title"][:110],
            "text": body[:600],
            "url": s["url"],
            "domain": s["domain"],
        })

    summary = (sources[0]["paras"][0][:400] if sources and sources[0].get("paras") else \
        (sources[0]["snippet"][:400] if sources else ""))

    actions = [
        {"label": "🔎 Go deeper", "kind": "agent", "value": f"research {topic} in more depth"},
        {"label": "🖼️ More images", "kind": "agent", "value": f"show me images of {topic}"},
        {"label": "▶️ Watch videos", "kind": "agent", "value": f"play videos about {topic}"},
    ]

    try:
        from genui import research_component
        ui = research_component(
            topic,
            hero=images[0]["image"] if images else "",
            summary=summary,
            sections=sections,
            images=images[1:7],
            videos=videos,
            sources=[{"title": s["title"], "url": s["url"], "domain": s["domain"],
                      "favicon": s["favicon"]} for s in sources],
            actions=actions,
        )
    except Exception:
        ui = None

    # ── Corpus for the model to refine ─────────────────────────────────────────
    corpus_parts = []
    for s in sources:
        body = "\n".join(s["paras"][:4]) or s["snippet"]
        corpus_parts.append(f"SOURCE: {s['title']} ({s['url']})\n{body}")
    corpus = f"Research corpus on “{topic}” ({len(sources)} sources, "\
             f"{len(images)} images gathered):\n\n" + "\n\n".join(corpus_parts)
    corpus = corpus[:6000]

    if ui:
        return {"text": corpus, "_ui": ui}
    return corpus
