"""
Shell execution tools for the Code Agent.
Whitelisted commands only — no destructive operations.
"""
import os
import subprocess
from pathlib import Path
from crewai.tools import tool

BUCKS_ROOT = Path(os.environ.get("BUCKS_PROJECT_ROOT", Path.home() / "Desktop" / "bucks core"))

ALLOWED_PREFIXES = (
    "npm ", "npx ", "cargo ", "pnpm ", "yarn ",
    "git status", "git diff", "git log",
    "ls ", "cat ", "echo ", "which ", "ollama ",
    "uvicorn ", "python ", "pip ",
)


def _is_allowed(cmd: str) -> bool:
    stripped = cmd.strip()
    return any(stripped.startswith(p) for p in ALLOWED_PREFIXES)


@tool("run_shell")
def run_shell(command: str, cwd: str = "") -> str:
    """
    Run a shell command inside the Bucks project.
    Only whitelisted commands are permitted (npm, cargo, git read-only, etc.).
    Pass cwd as a relative path inside the project if needed (e.g. 'Bucks-browser/bucks-app').
    """
    if not _is_allowed(command):
        return f"Command not allowed for safety: '{command}'. Permitted prefixes: {ALLOWED_PREFIXES}"
    work_dir = BUCKS_ROOT / cwd if cwd else BUCKS_ROOT
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=str(work_dir),
            capture_output=True,
            text=True,
            timeout=120,
        )
        output = (result.stdout + result.stderr).strip()
        return output[:4000] or "(no output)"
    except subprocess.TimeoutExpired:
        return "Command timed out after 120s."
    except Exception as e:
        return f"Shell error: {e}"
