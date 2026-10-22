"""
Session store — no built-in cloud database

The store keeps conversations in local SQLite unless DATABASE_URL is set. An earlier
version fell back to a hardcoded Postgres URL with its password; that credential is
compromised, and these tests keep it from coming back.
"""
import importlib
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

AGENT = Path(__file__).resolve().parent.parent


def test_session_store_has_no_built_in_cloud_database(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    store = importlib.reload(importlib.import_module("memory.session_store"))
    assert store.POSTGRES_URL == ""
    assert store._get_pg_conn() is None
    assert "supabase.co" not in (AGENT / "memory" / "session_store.py").read_text()


def test_no_postgres_url_with_a_password_anywhere_in_the_agent():
    for path in AGENT.rglob("*.py"):
        if {".venv", "venv", "site-packages"} & set(path.parts):
            continue
        text = path.read_text(errors="ignore")
        assert "postgresql://postgres:" not in text or path.name == Path(__file__).name, path
