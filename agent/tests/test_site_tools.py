"""
Hosting from the agent: the engine may propose publishing a site; the browser does it.

The engine's own upload/publish tools ran without the user's approval and are gone. The site_*
tools are executed by the browser's main process (src/main/sites/agent-tools.js), which shows an
approval card built from its own inspection of the folder. Here: they are offered for hosting
requests, routed to the browser, and never gated by an engine-supplied label.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import soul_engine  # noqa: E402
from tools.registry import TOOLS, AGENT_TOOL_MAPPINGS  # noqa: E402


def _names(schemas):
    return [s["function"]["name"] for s in schemas]


def test_unsafe_publish_tools_are_gone():
    for name in ("ipfs_upload_text", "dweb_publish"):
        assert name not in soul_engine.EXPOSED_TOOLS
        assert name not in TOOLS
        assert all(name not in names for names, _ in soul_engine._TOOL_CATEGORIES.values())
        assert all(name not in tools for tools in AGENT_TOOL_MAPPINGS.values())


def test_site_tools_run_in_the_browser():
    assert soul_engine.SITE_TOOL_NAMES == {"site_inspect", "site_publish", "site_update", "site_status"}
    assert soul_engine.SITE_TOOL_NAMES <= soul_engine.REMOTE_TOOL_NAMES
    # not engine tools: run_tool() refuses them, so only the browser can execute them
    assert not (soul_engine.SITE_TOOL_NAMES & soul_engine.EXPOSED_TOOLS)
    # the browser asks with its own card; the engine does not gate them with a label of its own
    assert not (soul_engine.SITE_TOOL_NAMES & soul_engine.STATE_CHANGING_TOOLS)
    assert soul_engine.SITE_TOOL_TIMEOUT >= 300


def test_hosting_requests_get_the_site_tools():
    chosen = _names(soul_engine.select_tool_schemas("publish my website from my laptop", agentic=False))
    assert "site_inspect" in chosen and "site_publish" in chosen
    assert "ipfs_upload_text" not in chosen and "dweb_publish" not in chosen
    plain = _names(soul_engine.select_tool_schemas("what is the capital of France", agentic=False))
    assert not (set(plain) & soul_engine.SITE_TOOL_NAMES)
    publish = next(s for s in soul_engine.SITE_TOOL_SCHEMAS if s["function"]["name"] == "site_publish")
    assert publish["function"]["parameters"]["required"] == ["token"]
    assert "path" not in str(publish["function"]["parameters"]).lower(), "folders come from the dialog, never as paths"


@pytest.mark.asyncio
async def test_run_tool_refuses_site_tools():
    text, ui = await soul_engine.run_tool("site_publish", {"token": "x"})
    assert text == "Unknown tool: site_publish" and ui is None
