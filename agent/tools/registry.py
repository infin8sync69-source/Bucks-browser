"""
Tool Registry — no crewai dependency.
Each tool is a plain async/sync callable with metadata.
"""
import re
import json
import time
import subprocess
import tempfile
import os
from pathlib import Path
from typing import Callable, Any
import httpx
from bs4 import BeautifulSoup

BUCKS_ROOT = Path(os.environ.get("BUCKS_PROJECT_ROOT",
                                  Path.home() / "Desktop" / "bucks core"))

# ── Tool descriptor ───────────────────────────────────────────────────────────

class Tool:
    def __init__(self, name: str, description: str, fn: Callable,
                 schema: dict = None, safe: bool = True):
        self.name        = name
        self.description = description
        self.fn          = fn
        self.schema      = schema or {}
        self.safe        = safe   # False = requires user confirmation

    async def run(self, **kwargs) -> str:
        import asyncio
        if asyncio.iscoroutinefunction(self.fn):
            return await self.fn(**kwargs)
        return self.fn(**kwargs)

    def to_dict(self):
        return {"name": self.name, "description": self.description, "safe": self.safe}


# ── Web tools ─────────────────────────────────────────────────────────────────

async def _ddg_html_search(query: str, max_results: int = 6) -> list[dict]:
    results = []
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            r = await client.post("https://html.duckduckgo.com/html/", data={"q": query}, headers=headers)
            if r.status_code == 200:
                soup = BeautifulSoup(r.text, "html.parser")
                for div in soup.find_all("div", class_="result"):
                    a_title = div.find("a", class_="result__a")
                    snippet_elem = div.find(class_="result__snippet")
                    if a_title:
                        title = a_title.get_text().strip()
                        href = a_title.get("href", "")
                        body = snippet_elem.get_text().strip() if snippet_elem else ""
                        if href.startswith("/l/?"):
                            from urllib.parse import parse_qs, urlparse
                            parsed = parse_qs(urlparse(href).query)
                            if "uddg" in parsed:
                                href = parsed["uddg"][0]
                        results.append({"title": title, "href": href, "body": body})
                        if len(results) >= max_results:
                            break
    except Exception:
        pass
    return results


async def web_search(query: str, max_results: int = 6):
    """Search the web with DuckDuckGo.

    Returns {"text", "_ui"}: `text` is the summary the model reads; `_ui` is a
    `list` component (clickable source cards) rendered for the user. See genui.py.
    """
    import asyncio
    results = []
    try:
        try:
            from ddgs import DDGS  # renamed successor of duckduckgo_search
        except ImportError:
            from duckduckgo_search import DDGS
        def _sync_ddgs():
            with DDGS() as ddgs:
                return list(ddgs.text(query, max_results=max_results))
        results = await asyncio.to_thread(_sync_ddgs)
    except Exception:
        results = []

    if not results:
        results = await _ddg_html_search(query, max_results=max_results)

    if not results:
        return "No results found."

    text = "\n---\n".join(
        f"**{r.get('title','')}**\n{r.get('href','')}\n{r.get('body','')}"
        for r in results
    )
    try:
        from genui import search_results_component
        return {"text": text, "_ui": search_results_component(query, results)}
    except Exception:
        return text


async def fetch_url(url: str, max_chars: int = 5000) -> str:
    """Fetch a URL and return clean readable text."""
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            headers = {"User-Agent": "Mozilla/5.0 (BucksBrowser/2.0)"}
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            soup = BeautifulSoup(r.text, "html.parser")
            for tag in soup(["script","style","nav","footer","header","aside"]):
                tag.decompose()
            text = soup.get_text(separator="\n", strip=True)
            text = re.sub(r"\n{3,}", "\n\n", text)
            return text[:max_chars]
    except Exception as e:
        return f"Fetch error: {e}"


async def extract_links(url: str, max_links: int = 15) -> str:
    """Extract hyperlinks from a page."""
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (BucksBrowser/2.0)"})
            soup = BeautifulSoup(r.text, "html.parser")
            links = [
                f"{a.get_text(strip=True)} → {a['href']}"
                for a in soup.find_all("a", href=True)
                if a["href"].startswith("http")
            ][:max_links]
            return "\n".join(links) or "No external links found."
    except Exception as e:
        return f"Extract error: {e}"


# ── Code execution (sandboxed) ────────────────────────────────────────────────

def execute_code(code: str, language: str = "python", timeout: int = 10) -> str:
    """
    Execute code in a sandboxed subprocess.
    Supports: python, javascript (node), bash (restricted).
    """
    if language not in ("python", "javascript", "bash"):
        return f"Unsupported language: {language}. Use python, javascript, or bash."

    # Safety: block dangerous patterns
    BLOCKED = [
        r"import\s+os.*system", r"subprocess\.Popen", r"__import__",
        r"open\s*\(.*['\"]w['\"]", r"shutil\.rmtree", r"rm\s+-rf",
        r"curl\s+.*\|.*sh", r"eval\s*\(",  r"exec\s*\(",
    ]
    for pattern in BLOCKED:
        if re.search(pattern, code, re.IGNORECASE):
            return f"⚠️ Blocked: potentially unsafe pattern detected ({pattern})."

    try:
        with tempfile.NamedTemporaryFile(
            suffix={"python": ".py", "javascript": ".js", "bash": ".sh"}[language],
            mode="w", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            tmp = f.name

        cmd = {
            "python":     ["python3", tmp],
            "javascript": ["node", tmp],
            "bash":       ["bash", "-r", tmp],   # -r = restricted shell
        }[language]

        result = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout, env={"PATH": os.environ.get("PATH", "")}
        )
        output = result.stdout + (f"\n[stderr]: {result.stderr}" if result.stderr else "")
        return output.strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return f"⏱️ Code execution timed out after {timeout}s."
    except FileNotFoundError as e:
        return f"Runtime not found: {e}"
    except Exception as e:
        return f"Execution error: {e}"
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass


# ── File tools (scoped to BUCKS_ROOT) ────────────────────────────────────────

def _safe_path(rel_or_abs: str) -> Path:
    # Containment via is_relative_to (real path components), not a string prefix:
    # a raw startswith lets sibling "/x/bucks core-evil" pass for root "/x/bucks core".
    # resolve() collapses symlinks so out-of-root links are rejected, not followed.
    p = Path(rel_or_abs)
    if not p.is_absolute():
        p = BUCKS_ROOT / p
    p = p.resolve()
    root = BUCKS_ROOT.resolve()
    if p != root and not p.is_relative_to(root):
        raise PermissionError(f"Path outside project root: {p}")
    return p


def read_file(path: str) -> str:
    try:
        return _safe_path(path).read_text(encoding="utf-8")[:8000]
    except Exception as e:
        return f"Read error: {e}"


def write_file(path: str, content: str) -> str:
    try:
        p = _safe_path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"✓ Written: {p.relative_to(BUCKS_ROOT)}"
    except Exception as e:
        return f"Write error: {e}"


def list_directory(path: str = ".") -> str:
    try:
        p = _safe_path(path)
        entries = sorted(p.iterdir(), key=lambda x: (x.is_file(), x.name))
        lines = [("📁 " if e.is_dir() else "📄 ") + e.name for e in entries[:60]]
        return "\n".join(lines) or "(empty)"
    except Exception as e:
        return f"List error: {e}"


def git_status() -> str:
    try:
        r = subprocess.run(["git","status","--short"], cwd=str(BUCKS_ROOT),
                           capture_output=True, text=True, timeout=8)
        return r.stdout or "Clean."
    except Exception as e:
        return f"git status error: {e}"


# ── Calendar (file-backed) ────────────────────────────────────────────────────

CALENDAR_FILE = Path.home() / ".bucks" / "calendar.json"

def _load_cal() -> list:
    if CALENDAR_FILE.exists():
        return json.loads(CALENDAR_FILE.read_text())
    return []

def _save_cal(events: list):
    CALENDAR_FILE.parent.mkdir(parents=True, exist_ok=True)
    CALENDAR_FILE.write_text(json.dumps(events, indent=2))

def calendar_add(title: str, date: str, time_str: str = "", note: str = "") -> str:
    events = _load_cal()
    event = {"id": int(time.time()), "title": title, "date": date,
             "time": time_str, "note": note}
    events.append(event)
    _save_cal(events)
    return f"✓ Added: {title} on {date} {time_str}".strip()

def calendar_list(date: str = "") -> str:
    events = _load_cal()
    if date:
        events = [e for e in events if e.get("date","").startswith(date)]
    if not events:
        return "No events found."
    lines = []
    for e in sorted(events, key=lambda x: (x.get("date",""), x.get("time",""))):
        lines.append(f"• {e['date']} {e.get('time','')} — {e['title']}" +
                     (f" ({e['note']})" if e.get("note") else ""))
    return "\n".join(lines)


# ── Commerce stubs ────────────────────────────────────────────────────────────

def track_order(order_id: str, carrier: str = "") -> str:
    import os
    api = os.environ.get("BUCKS_LOGISTICS_API","")
    if api:
        try:
            r = httpx.get(f"{api}/track/{order_id}", timeout=10)
            return json.dumps(r.json()) if r.is_success else f"API error: {r.status_code}"
        except Exception as e:
            return f"Tracking error: {e}"
    return json.dumps({
        "order_id": order_id, "status": "In Transit",
        "carrier": carrier or "DHL", "location": "Mumbai Sorting Facility",
        "eta": "Tomorrow by 8 PM", "note": "Set BUCKS_LOGISTICS_API for live data."
    })


def product_search(query: str, max_results: int = 5):
    """Returns {"text", "_ui"} — text for the model, a product_grid for the user.
    Demo/sample catalog (mock). Each item still gets a real search URL (so
    clicking opens results for it) and a placeholder image (so the card looks
    complete). For genuinely real products, prefer product_lookup."""
    from urllib.parse import quote_plus
    def _demo(tier: str, price: str, stock: str, rating: float):
        name = f"{query} — {tier}"
        return {
            "name": name, "price": price, "stock": stock, "rating": rating,
            "url": f"https://duckduckgo.com/?q={quote_plus('buy ' + query + ' ' + tier)}",
            "imageUrl": f"https://placehold.co/400x300/1e1e2e/a978ff?text={quote_plus(query)}",
        }
    products = [
        _demo("Premium", "₹299", "In Stock", 4.6),
        _demo("Standard", "₹199", "Low Stock", 4.1),
        _demo("Essentials", "₹149", "In Stock", 3.9),
    ][:max_results]
    text = json.dumps({"results": products, "note": "Set BUCKS_ECOMMERCE_API for live catalog."})
    try:
        from genui import product_grid_component
        return {"text": text, "_ui": product_grid_component(query, products)}
    except Exception:
        return text


# ── Registry ──────────────────────────────────────────────────────────────────

async def _wrap_product_lookup(query: str, max_results: int = 12):
    from tools.shopping import product_lookup
    return await product_lookup(query, max_results)

async def wrap_ipfs_upload_text(text: str) -> str:
    from tools.ipfs_tools import ipfs_upload_text as _upload
    return await _upload(text)

async def wrap_ipfs_cat_text(cid: str) -> str:
    from tools.ipfs_tools import ipfs_cat_text as _cat
    return await _cat(cid)

async def wrap_ipfs_dynamic_load_tool(cid: str) -> str:
    from tools.ipfs_tools import ipfs_dynamic_load_tool as _load
    return await _load(cid)

async def wrap_dweb_publish(name: str, content: str, title: str = "", desc: str = "") -> str:
    from tools.ipfs_tools import dweb_publish as _pub
    return await _pub(name, content, title, desc)

async def wrap_dweb_search(query: str) -> str:
    from tools.ipfs_tools import dweb_search as _search
    return await _search(query)

async def _wrap_image_search(query: str, max_results: int = 12):
    from tools.media_tools import image_search
    return await image_search(query, max_results)

async def _wrap_youtube_search(query: str, max_results: int = 8):
    from tools.media_tools import youtube_search
    return await youtube_search(query, max_results)

async def _wrap_deep_research(topic: str, max_sources: int = 4):
    from tools.research import deep_research
    return await deep_research(topic, max_sources)

async def _wrap_weather_lookup(place: str, days: int = 5):
    from tools.weather_tools import weather_lookup
    return await weather_lookup(place, days)

TOOLS: dict[str, Tool] = {
    "web_search":            Tool("web_search",            "Search the web with DuckDuckGo",                       web_search),
    "fetch_url":             Tool("fetch_url",             "Fetch and read a URL's text content",                  fetch_url),
    "extract_links":         Tool("extract_links",         "Extract hyperlinks from a webpage",                    extract_links),
    "execute_code":          Tool("execute_code",          "Run Python/JS/bash code in a sandbox",                 execute_code, safe=False),
    "read_file":             Tool("read_file",             "Read a file in the Bucks project",                     read_file),
    "write_file":            Tool("write_file",            "Write a file in the Bucks project",                    write_file, safe=False),
    "list_directory":        Tool("list_directory",        "List files in a project directory",                    list_directory),
    "git_status":            Tool("git_status",            "Show git status of the Bucks project",                 git_status),
    "calendar_add":          Tool("calendar_add",          "Add an event to the user's calendar",                  calendar_add),
    "calendar_list":         Tool("calendar_list",         "List calendar events, optionally filtered by date",    calendar_list),
    "track_order":           Tool("track_order",           "Track a shipment order",                               track_order),
    "product_search":        Tool("product_search",        "Search the product catalog",                           product_search),
    "product_lookup":        Tool("product_lookup",        "Fetch REAL products from trusted retailer pages",      _wrap_product_lookup),
    "ipfs_upload_text":      Tool("ipfs_upload_text",      "Upload text content to IPFS, returning the CID",       wrap_ipfs_upload_text, safe=False),
    "ipfs_cat_text":         Tool("ipfs_cat_text",         "Retrieve and read text content from an IPFS CID",      wrap_ipfs_cat_text),
    "ipfs_dynamic_load_tool": Tool("ipfs_dynamic_load_tool", "Fetch and dynamically load a new agent tool from IPFS", wrap_ipfs_dynamic_load_tool, safe=False),
    "dweb_publish":          Tool("dweb_publish",          "Publish a page to the Bucks dWeb (IPFS + swarm index)", wrap_dweb_publish, safe=False),
    "dweb_search":           Tool("dweb_search",           "Search pages on the Bucks dWeb discovery index",       wrap_dweb_search),
    "image_search":          Tool("image_search",          "Search the web for images (renders an image gallery)", _wrap_image_search),
    "youtube_search":        Tool("youtube_search",        "Search YouTube videos (renders an embedded player)",   _wrap_youtube_search),
    "deep_research":         Tool("deep_research",         "Multi-source research with images (renders a dossier)", _wrap_deep_research),
    "weather_lookup":        Tool("weather_lookup",        "Current weather + forecast (renders a weather card)",  _wrap_weather_lookup),
}


def get_tool(name: str) -> Tool | None:
    return TOOLS.get(name)

def list_tools() -> list[dict]:
    return [t.to_dict() for t in TOOLS.values()]

AGENT_TOOL_MAPPINGS = {
    "browser":  ["web_search", "fetch_url", "extract_links", "image_search",
                 "youtube_search", "deep_research", "weather_lookup"],
    "code":     ["read_file", "write_file", "list_directory", "git_status", "execute_code"],
    "commerce": ["track_order", "product_search", "web_search"],
    "slm":      ["web_search", "calendar_list"],
    "calendar": ["calendar_add", "calendar_list"],
    "ipfs":     ["ipfs_upload_text", "ipfs_cat_text", "ipfs_dynamic_load_tool",
                 "dweb_publish", "dweb_search"],
}

def tools_for_agent(agent_type: str) -> list[Tool]:
    """Return relevant tools for each agent type."""
    names = AGENT_TOOL_MAPPINGS.get(agent_type, ["web_search"])
    return [TOOLS[n] for n in names if n in TOOLS]

def register_dynamic_tool(name: str, description: str, fn: Callable, safe: bool = True, agent_mapping: str = "code"):
    """Register a custom dynamic tool fetched from IPFS into the agent registry."""
    TOOLS[name] = Tool(name, description, fn, safe=safe)
    if agent_mapping not in AGENT_TOOL_MAPPINGS:
        AGENT_TOOL_MAPPINGS[agent_mapping] = []
    if name not in AGENT_TOOL_MAPPINGS[agent_mapping]:
        AGENT_TOOL_MAPPINGS[agent_mapping].append(name)

