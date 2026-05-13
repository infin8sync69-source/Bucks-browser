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

async def web_search(query: str, max_results: int = 6) -> str:
    """DuckDuckGo search — no API key, no tracking."""
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        if not results:
            return "No results found."
        return "\n---\n".join(
            f"**{r.get('title','')}**\n{r.get('href','')}\n{r.get('body','')}"
            for r in results
        )
    except Exception as e:
        return f"Search error: {e}"


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
    p = Path(rel_or_abs)
    if not p.is_absolute():
        p = BUCKS_ROOT / p
    p = p.resolve()
    if not str(p).startswith(str(BUCKS_ROOT.resolve())):
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


def product_search(query: str, max_results: int = 5) -> str:
    return json.dumps({
        "results": [
            {"name": f"{query} - Premium", "price": "₹299", "stock": "In Stock"},
            {"name": f"{query} - Standard", "price": "₹199", "stock": "Low Stock"},
        ],
        "note": "Set BUCKS_ECOMMERCE_API for live catalog."
    })


# ── Registry ──────────────────────────────────────────────────────────────────

TOOLS: dict[str, Tool] = {
    "web_search":       Tool("web_search",       "Search the web with DuckDuckGo",                       web_search),
    "fetch_url":        Tool("fetch_url",         "Fetch and read a URL's text content",                  fetch_url),
    "extract_links":    Tool("extract_links",     "Extract hyperlinks from a webpage",                    extract_links),
    "execute_code":     Tool("execute_code",      "Run Python/JS/bash code in a sandbox",                 execute_code, safe=False),
    "read_file":        Tool("read_file",         "Read a file in the Bucks project",                     read_file),
    "write_file":       Tool("write_file",        "Write a file in the Bucks project",                    write_file, safe=False),
    "list_directory":   Tool("list_directory",    "List files in a project directory",                    list_directory),
    "git_status":       Tool("git_status",        "Show git status of the Bucks project",                 git_status),
    "calendar_add":     Tool("calendar_add",      "Add an event to the user's calendar",                  calendar_add),
    "calendar_list":    Tool("calendar_list",     "List calendar events, optionally filtered by date",    calendar_list),
    "track_order":      Tool("track_order",       "Track a shipment order",                               track_order),
    "product_search":   Tool("product_search",    "Search the product catalog",                           product_search),
}


def get_tool(name: str) -> Tool | None:
    return TOOLS.get(name)

def list_tools() -> list[dict]:
    return [t.to_dict() for t in TOOLS.values()]

def tools_for_agent(agent_type: str) -> list[Tool]:
    """Return relevant tools for each agent type."""
    mapping = {
        "browser":  ["web_search", "fetch_url", "extract_links"],
        "code":     ["read_file", "write_file", "list_directory", "git_status", "execute_code"],
        "commerce": ["track_order", "product_search", "web_search"],
        "slm":      ["web_search", "calendar_list"],
        "calendar": ["calendar_add", "calendar_list"],
    }
    names = mapping.get(agent_type, ["web_search"])
    return [TOOLS[n] for n in names if n in TOOLS]
