"""
File system tools for the Code Agent.
Scoped to the Bucks project root for safety.
"""
import os
import subprocess
from pathlib import Path
from crewai.tools import tool

BUCKS_ROOT = Path(os.environ.get("BUCKS_PROJECT_ROOT", Path.home() / "Desktop" / "bucks core"))


def _safe_path(rel_or_abs: str) -> Path:
    """Resolve path, keeping it inside BUCKS_ROOT."""
    p = Path(rel_or_abs)
    if not p.is_absolute():
        p = BUCKS_ROOT / p
    p = p.resolve()
    if not str(p).startswith(str(BUCKS_ROOT.resolve())):
        raise PermissionError(f"Path outside project root: {p}")
    return p


@tool("read_file")
def read_file(path: str) -> str:
    """Read the contents of a file in the Bucks project. Pass a relative or absolute path."""
    try:
        p = _safe_path(path)
        return p.read_text(encoding="utf-8")
    except Exception as e:
        return f"Error reading {path}: {e}"


@tool("write_file")
def write_file(path: str, content: str) -> str:
    """Write (overwrite) a file in the Bucks project. Pass relative path and full new content."""
    try:
        p = _safe_path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"Written {p.relative_to(BUCKS_ROOT)}"
    except Exception as e:
        return f"Error writing {path}: {e}"


@tool("list_directory")
def list_directory(path: str = ".") -> str:
    """List files and directories at the given path inside the Bucks project."""
    try:
        p = _safe_path(path)
        entries = sorted(p.iterdir(), key=lambda x: (x.is_file(), x.name))
        lines = []
        for e in entries[:100]:
            tag = "📁" if e.is_dir() else "📄"
            lines.append(f"{tag} {e.name}")
        return "\n".join(lines) or "(empty)"
    except Exception as e:
        return f"Error listing {path}: {e}"


@tool("git_status")
def git_status() -> str:
    """Get the current git status of the Bucks project."""
    try:
        result = subprocess.run(
            ["git", "status", "--short"],
            cwd=str(BUCKS_ROOT),
            capture_output=True, text=True, timeout=10
        )
        return result.stdout or "Nothing to report."
    except Exception as e:
        return f"git status error: {e}"


@tool("git_diff")
def git_diff() -> str:
    """Show unstaged changes in the Bucks project."""
    try:
        result = subprocess.run(
            ["git", "diff", "--stat"],
            cwd=str(BUCKS_ROOT),
            capture_output=True, text=True, timeout=10
        )
        return result.stdout or "No changes."
    except Exception as e:
        return f"git diff error: {e}"
