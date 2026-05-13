"""
Web tools for the Browser and Research agents.
Uses DuckDuckGo search + BeautifulSoup page fetching.
"""
import re
import requests
from crewai.tools import tool
from bs4 import BeautifulSoup
from duckduckgo_search import DDGS


@tool("web_search")
def web_search(query: str, max_results: int = 6) -> str:
    """
    Search the web with DuckDuckGo. Returns titles, URLs, and snippets.
    No API key required — fully local.
    """
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        if not results:
            return "No results found."
        lines = []
        for r in results:
            lines.append(f"**{r.get('title', '')}**\n{r.get('href', '')}\n{r.get('body', '')}\n")
        return "\n---\n".join(lines)
    except Exception as e:
        return f"Search error: {e}"


@tool("fetch_url")
def fetch_url(url: str, max_chars: int = 6000) -> str:
    """
    Fetch a URL and return readable text content (HTML stripped).
    """
    try:
        headers = {"User-Agent": "Mozilla/5.0 (BucksBrowser/1.0)"}
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header"]):
            tag.decompose()
        text = soup.get_text(separator="\n", strip=True)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text[:max_chars]
    except Exception as e:
        return f"Fetch error: {e}"


@tool("extract_links")
def extract_links(url: str, max_links: int = 20) -> str:
    """Extract all hyperlinks from a page."""
    try:
        headers = {"User-Agent": "Mozilla/5.0 (BucksBrowser/1.0)"}
        resp = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(resp.text, "html.parser")
        links = []
        for a in soup.find_all("a", href=True)[:max_links]:
            href = a["href"]
            if href.startswith("http"):
                links.append(f"{a.get_text(strip=True)} → {href}")
        return "\n".join(links) or "No links found."
    except Exception as e:
        return f"Extract links error: {e}"
