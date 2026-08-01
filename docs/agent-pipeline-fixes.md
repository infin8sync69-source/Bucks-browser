# Agentic Pipeline — Root-Cause Fixes

Written after the agent was reported as "not working, not intuitive, not advanced." That assessment was correct. The problems were **not** UI polish — they were five concrete defects in the agent pipeline, four of which made whole capability classes silently non-functional.

Every fix below was verified by running the real `/agent` endpoint end-to-end and inspecting the SSE stream, not by reading code.

---

## 1. The model was handed all 41 tool schemas on every request

`soul_engine.py` built its tool list as `list(TOOL_SCHEMAS) + [RENDER] + BROWSER_TOOL_SCHEMAS` — 26 general + 15 browser schemas, ≈4,100 tokens. The context window is **8,192 tokens**, so **half the window was consumed before** the system prompt, RAG snippets, conversation history, or the user's actual question. A 7B local model then had to pick correctly among 41 options.

**Fix:** `select_tool_schemas(message, agentic)` — a small always-on core (`web_search`, `render_component`) plus only the categories a query actually implicates, capped at 10. Browser/pane schemas load only in agentic mode *and* only when the request implies driving the UI.

**Measured:** 41 → 3–10 schemas.

| Query | Tools |
|---|---|
| "weather in Bangalore" | 3 |
| "upload this to IPFS" | 6 |
| "read bucks-node.js and explain" | 7 |
| "top 5 keyboards under ₹10,000" | 8 |

Two false positives were caught during tuning and fixed: the *filename* `bucks-node.js` pulled in the entire 8-tool cluster block (keyword `"node"` was too generic), and a budget-phrased shopping query matched no commerce keyword at all.

## 2. File and shell tools pointed at a directory that does not exist

`BUCKS_ROOT` defaulted to `~/Desktop/bucks core`. The actual tree is `~/Desktop/Bucks Core/bucks browser`. **Every** file/code/shell tool call returned `No such file or directory`, so the agent's entire local-codebase capability was dead. The model then retried the failing call until it exhausted its step budget — which is what "stuck in a loop" looked like from outside.

The bad default was duplicated in **three** files: `tools/file_tools.py`, `tools/registry.py`, `tools/shell_tools.py`. All three now derive the root from `__file__` (`parents[2]`), so it stays correct wherever the repo is checked out.

## 3. Duplicate tool implementations — fixes to one silently did nothing *(now fixed)*

`_safe_path`, `read_file`, `write_file`, `list_directory` and `git_status` existed **twice**: once in `tools/file_tools.py` (crewai-decorated, used by `agents/code_agent.py`) and again, separately re-implemented, in `tools/registry.py`. Only the `registry.py` copies were registered in `TOOLS` and dispatched by the agent.

This was discovered the hard way: a fix applied to `file_tools.py` verified correct in isolation, but agent behaviour did not change at all — because the agent never runs that code.

The two copies had already drifted:

| behaviour | registry.py | file_tools.py |
|---|---|---|
| `read_file` size | silent 8,000-char cut | unbounded |
| `list_directory` | 60 entries, no sizes | 100 entries, no sizes |
| error strings | `Read error: …` | `Error reading X: …` |
| `BUCKS_ROOT` | own definition | own definition |

**Fix:** new `tools/fs_impl.py` holds the single implementation and the single `BUCKS_ROOT`. `registry.py` and `shell_tools.py` import it directly; `file_tools.py` is now nothing but thin `@tool` wrappers delegating to it. Deliberately free of any crewai dependency so `registry.py` can import it with no cost or optional-package risk.

**Verified:** `registry.TOOLS['read_file'].fn is fs_impl.read_file` → `True` for every shared tool, so there is provably one implementation rather than two that merely look alike. All three modules report an identical `BUCKS_ROOT`. `agents/code_agent.py` still imports cleanly, and the end-to-end agent run produces the same correct answer.

**Latent bug fixed in passing:** `read_file` truncated at 8,000 characters *silently*, so the model reasoned about a partial file believing it had the whole thing. Truncation is now explicit — `[TRUNCATED: showing first 8000 of 157707 characters of index.html. This is NOT the complete file.]` — and `list_directory` likewise reports how many entries it omitted.

## 4. Repeated identical tool calls burned the whole step budget

Small local models routinely re-issue a call they already made with identical arguments, ignoring the result already in the transcript.

**Fix:** a per-request `(name, args)` cache. A repeat serves the cached result plus an explicit instruction not to call it again; after 3 repeats the loop stops and the agent synthesises an answer from what it already gathered.

**Two bugs in the first version of this fix, both found by testing:**
- `break` sat inside `for call in tool_calls`, so it only escaped the *inner* loop — the outer step loop kept running (visible as "breaking tool loop" logging repeatedly). Now uses an explicit `_loop_broken` flag.
- Breaking out produced no answer at all. Now a stuck loop synthesises from collected tool results instead of emitting a bare `[Reached tool-step limit.]`.

`MAX_TOOL_STEPS` also raised 5 → 10: a genuine multi-step task (search → open → read → render) spends 4–5 steps on its own, so the old ceiling truncated real work mid-flight. Duplicate suppression is what bounds runaway loops now, so the step ceiling can afford to be generous.

## 5. Weather resolved to the wrong country

Open-Meteo's geocoder returns exactly **one** hit for "Bangalore": *Bangalore Town, Sindh, **Pakistan***. Asking for local weather in Bengaluru silently reported a different country's, with no indication anything was wrong. Ranking cannot fix a single wrong candidate — the name must be normalised first.

**Fix:** an alias table for renamed/colloquial cities (Bangalore→Bengaluru, Bombay→Mumbai, Madras→Chennai, Saigon→Ho Chi Minh City, …) plus `count=10` and population-ranking so ambiguous names resolve to the intended city.

| Input | Before | After |
|---|---|---|
| Bangalore | Sindh, **Pakistan** | Bengaluru, Karnataka, **India** |
| Bombay | — | Mumbai, Maharashtra, India |
| London | (unranked first hit) | London, England, UK (pop 8.9M) |

## 6. `list_directory` omitted file sizes

The agent could not answer "which files are largest?" without opening every file, so it guessed from filenames. Sizes are now included.

---

## Bonus: renderer could die silently

`renderer.js`'s `init()` accessed `window.bucksAPI.showWallet` on its first line with no guard. If the preload bridge were ever unavailable, that threw and aborted init at line one — killing the **entire** renderer (no dock, no tabs, no chat) with nothing shown to the user. Now fails loudly with a visible message.

---

## Verification

Same prompt, before and after — `"List the files in the electron directory and tell me which source files are largest"`:

**Before:** 10 tool calls, all `No such file or directory`, the same two calls repeated 5×, final output `[Reached tool-step limit.]`.

**After:** real directory listing, 3 successful file reads, duplicate call suppressed, a rendered table component, and an answer citing **verified-accurate** sizes:

| Agent claimed | Actual |
|---|---|
| index.html 154.4 KB | 154.4 KB ✅ |
| main.js 60.5 KB | 60.5 KB ✅ |
| package-lock.json 368.6 KB | 368.6 KB ✅ |

---

## Testing note that cost real time

Restarting the engine with `pkill` + relaunch **appeared** to work — `/health` responded — while an older process still held port 8765 and served stale code. Always confirm `Uvicorn running` in the new process's own log and check `pgrep -f "uvicorn soul_engine"` returns only the expected PID before trusting a behavioural test.

---

## Known remaining limits

- **The 7B local model is the ceiling.** These fixes remove the pipeline's self-inflicted damage; they do not make a 7B model reason like a frontier model. It still guesses filenames that don't exist (`electron.js`, `bundled-libs.js`) before finding real ones. If agentic quality is the priority, model capability is the next real lever — which collides with the inbuilt-only/no-cloud constraint and is a product decision, not an engineering one.
- Three separate systems still share the name "ephemeral" (inline generative-UI cards, the ⌘K popup window, `nt-ephemeral-zone`). Documented in `ui-flow-gap-checklist.md`; not addressed here.
- `agent/soul_engine.py` is ~2,000 lines and `electron/renderer.js` ~7,800. Neither is the cause of any bug above, but both make this class of duplication easy to reintroduce.
