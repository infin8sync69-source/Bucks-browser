"""
SQLite-backed persistent memory layer.
Handles: conversation sessions, user preferences, interaction history (RAG), feedback.
No external deps — stdlib sqlite3 only.
"""
import sqlite3
import json
import time
import math
import re
from pathlib import Path
from typing import Optional

MEMORY_DIR = Path.home() / ".bucks" / "agent-memory"
MEMORY_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = MEMORY_DIR / "bucks.db"


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(DB_PATH))
    c.row_factory = sqlite3.Row
    return c


def _init_db():
    with _conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            messages   TEXT NOT NULL DEFAULT '[]',
            context    TEXT NOT NULL DEFAULT '{}',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS preferences (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS interactions (
            task_id    TEXT PRIMARY KEY,
            prompt     TEXT NOT NULL,
            response   TEXT NOT NULL,
            agent      TEXT NOT NULL DEFAULT 'unknown',
            score      INTEGER NOT NULL DEFAULT 0,
            ts         REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS plan_steps (
            plan_id    TEXT NOT NULL,
            step_idx   INTEGER NOT NULL,
            goal       TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'pending',
            result     TEXT,
            ts         REAL,
            PRIMARY KEY (plan_id, step_idx)
        );
        """)

_init_db()


# ── Session management ────────────────────────────────────────────────────────

class SessionStore:
    def get_or_create(self, session_id: str) -> dict:
        with _conn() as c:
            row = c.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
            if row:
                return {"session_id": row["session_id"],
                        "messages": json.loads(row["messages"]),
                        "context": json.loads(row["context"])}
            now = time.time()
            c.execute("INSERT INTO sessions VALUES (?,?,?,?,?)",
                      (session_id, "[]", "{}", now, now))
            return {"session_id": session_id, "messages": [], "context": {}}

    def append_message(self, session_id: str, role: str, content: str, meta: dict = None):
        session = self.get_or_create(session_id)
        msg = {"role": role, "content": content, "ts": time.time()}
        if meta:
            msg.update(meta)
        session["messages"].append(msg)
        # Keep last 40 messages in session (prune oldest first)
        if len(session["messages"]) > 40:
            session["messages"] = session["messages"][-40:]
        with _conn() as c:
            c.execute("UPDATE sessions SET messages=?, updated_at=? WHERE session_id=?",
                      (json.dumps(session["messages"]), time.time(), session_id))

    def get_recent(self, session_id: str, n: int = 8) -> list[dict]:
        """Return the last n turns for LLM context injection."""
        session = self.get_or_create(session_id)
        return session["messages"][-n:]

    def set_context(self, session_id: str, key: str, value):
        session = self.get_or_create(session_id)
        session["context"][key] = value
        with _conn() as c:
            c.execute("UPDATE sessions SET context=?, updated_at=? WHERE session_id=?",
                      (json.dumps(session["context"]), time.time(), session_id))

    def clear(self, session_id: str):
        with _conn() as c:
            c.execute("DELETE FROM sessions WHERE session_id=?", (session_id,))


# ── User preferences ──────────────────────────────────────────────────────────

class PreferenceStore:
    def get(self, key: str, default=None):
        with _conn() as c:
            row = c.execute("SELECT value FROM preferences WHERE key=?", (key,)).fetchone()
            if row:
                return json.loads(row["value"])
            return default

    def set(self, key: str, value):
        with _conn() as c:
            c.execute("INSERT OR REPLACE INTO preferences VALUES (?,?,?)",
                      (key, json.dumps(value), time.time()))

    def get_all(self) -> dict:
        with _conn() as c:
            rows = c.execute("SELECT key, value FROM preferences").fetchall()
            return {r["key"]: json.loads(r["value"]) for r in rows}

    def build_preference_prompt(self) -> str:
        prefs = self.get_all()
        if not prefs:
            return ""
        lines = []
        if "language" in prefs:
            lines.append(f"Respond in {prefs['language']}.")
        if "tone" in prefs:
            lines.append(f"Use a {prefs['tone']} tone.")
        if "expertise" in prefs:
            lines.append(f"The user's expertise level is {prefs['expertise']}.")
        if "domains" in prefs:
            lines.append(f"The user is interested in: {', '.join(prefs['domains'])}.")
        if "location" in prefs:
            lines.append(f"User location context: {prefs['location']}.")
        return "\n".join(lines)


# ── Interaction history + BM25 retrieval ──────────────────────────────────────

class InteractionStore:
    def store(self, task_id: str, prompt: str, response: str, agent: str):
        with _conn() as c:
            c.execute("INSERT OR REPLACE INTO interactions VALUES (?,?,?,?,?,?)",
                      (task_id, prompt, response, agent, 0, time.time()))

    def update_score(self, task_id: str, score: int, correction: str = None):
        with _conn() as c:
            if correction:
                c.execute("UPDATE interactions SET score=?, response=response||? WHERE task_id=?",
                          (score, f"\n[Correction: {correction}]", task_id))
            else:
                c.execute("UPDATE interactions SET score=? WHERE task_id=?", (score, task_id))

    def retrieve_similar(self, query: str, k: int = 4) -> list[dict]:
        """BM25-style keyword retrieval over stored interactions — no vector DB needed."""
        with _conn() as c:
            rows = c.execute(
                "SELECT prompt, response, agent, score FROM interactions ORDER BY ts DESC LIMIT 200"
            ).fetchall()

        if not rows:
            return []

        query_tokens = set(re.findall(r'\w+', query.lower()))
        scored = []
        for row in rows:
            doc = f"{row['prompt']} {row['response']}".lower()
            doc_tokens = re.findall(r'\w+', doc)
            doc_len = len(doc_tokens)
            tf_scores = {}
            for t in doc_tokens:
                tf_scores[t] = tf_scores.get(t, 0) + 1

            score = 0.0
            k1, b, avgdl = 1.5, 0.75, 100
            for token in query_tokens:
                if token in tf_scores:
                    tf = tf_scores[token]
                    idf = math.log((len(rows) + 1) / 1.5)  # simplified IDF
                    score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc_len / avgdl))

            # Boost highly-rated interactions
            score *= (1 + max(0, row["score"]) * 0.1)
            if score > 0:
                scored.append({"prompt": row["prompt"], "response": row["response"][:300],
                                "agent": row["agent"], "bm25": score})

        scored.sort(key=lambda x: x["bm25"], reverse=True)
        return scored[:k]

    def count(self) -> int:
        with _conn() as c:
            return c.execute("SELECT COUNT(*) FROM interactions").fetchone()[0]


# ── Plan step store ───────────────────────────────────────────────────────────

class PlanStore:
    def save_plan(self, plan_id: str, steps: list[str]):
        with _conn() as c:
            c.execute("DELETE FROM plan_steps WHERE plan_id=?", (plan_id,))
            for i, step in enumerate(steps):
                c.execute("INSERT INTO plan_steps VALUES (?,?,?,?,?,?)",
                          (plan_id, i, step, "pending", None, None))

    def update_step(self, plan_id: str, step_idx: int, status: str, result: str = None):
        with _conn() as c:
            c.execute("UPDATE plan_steps SET status=?, result=?, ts=? WHERE plan_id=? AND step_idx=?",
                      (status, result, time.time(), plan_id, step_idx))

    def get_plan(self, plan_id: str) -> list[dict]:
        with _conn() as c:
            rows = c.execute(
                "SELECT * FROM plan_steps WHERE plan_id=? ORDER BY step_idx", (plan_id,)
            ).fetchall()
            return [dict(r) for r in rows]


# ── Singleton accessors ───────────────────────────────────────────────────────

sessions      = SessionStore()
preferences   = PreferenceStore()
interactions  = InteractionStore()
plan_store    = PlanStore()
