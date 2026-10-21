"""
Apps from the agent: the engine may propose installing or using an app; the browser does it.

The app_* tools are executed by the browser's main process (src/main/apps/agent-tools.js), which
shows an approval card built from its own review of the app (every permission and its risk), and
asks before the first use of an app's tools in a session. Here: they are offered for app requests,
routed to the browser, never run by the engine and never gated by an engine-supplied label.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import soul_engine  # noqa: E402


def _names(schemas):
    return [s["function"]["name"] for s in schemas]


def test_app_tools_run_in_the_browser():
    assert soul_engine.APP_TOOL_NAMES == {"app_list", "app_install", "app_open", "app_call", "app_update", "app_uninstall"}
    assert soul_engine.APP_TOOL_NAMES <= soul_engine.REMOTE_TOOL_NAMES
    assert not (soul_engine.APP_TOOL_NAMES & soul_engine.EXPOSED_TOOLS)
    # the browser asks with its own card; the engine does not gate them with a label of its own
    assert not (soul_engine.APP_TOOL_NAMES & soul_engine.STATE_CHANGING_TOOLS)
    assert soul_engine.APP_TOOL_TIMEOUT >= 180


def test_app_requests_get_the_app_tools():
    chosen = _names(soul_engine.select_tool_schemas("install the notes app from ipns://k51abc", agentic=False))
    assert "app_install" in chosen and "app_list" in chosen
    using = _names(soul_engine.select_tool_schemas("ask my apps how many notes I have", agentic=False))
    assert "app_call" in using
    plain = _names(soul_engine.select_tool_schemas("what is the capital of France", agentic=False))
    assert not (set(plain) & soul_engine.APP_TOOL_NAMES)
    install = next(s for s in soul_engine.APP_TOOL_SCHEMAS if s["function"]["name"] == "app_install")
    assert install["function"]["parameters"]["required"] == ["address"]
    call = next(s for s in soul_engine.APP_TOOL_SCHEMAS if s["function"]["name"] == "app_call")
    assert call["function"]["parameters"]["required"] == ["id", "tool"]
    assert "untrusted" in call["function"]["description"]


@pytest.mark.asyncio
async def test_run_tool_refuses_app_tools():
    text, ui = await soul_engine.run_tool("app_install", {"address": "ipns://k51abc"})
    assert text == "Unknown tool: app_install" and ui is None
