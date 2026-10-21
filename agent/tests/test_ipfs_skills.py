import pytest
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from tools.ipfs_tools import ipfs_cat_text, ipfs_dynamic_load_tool
from tools.registry import get_tool, tools_for_agent, AGENT_TOOL_MAPPINGS, TOOLS
from rag.ipfs_store import IPFSKnowledgeStore
from config import IPFS_API_URL


async def _put(text: str) -> str:
    """Store text on the local IPFS node the way the removed upload tool did (test setup only)."""
    cid = await IPFSKnowledgeStore(IPFS_API_URL).publish_fragment(text)
    assert cid
    return cid


def test_publishing_is_not_an_engine_tool():
    # Uploading and publishing ran without approval; the browser does them now (site_* tools).
    assert "ipfs_upload_text" not in TOOLS
    assert "dweb_publish" not in TOOLS
    assert "ipfs_upload_text" not in AGENT_TOOL_MAPPINGS["ipfs"]


@pytest.mark.asyncio
async def test_ipfs_cat():
    # 1. Store
    test_text = "Hello, this is a test text from the Bucks IPFS Skill test."
    cid = await _put(test_text)
    
    # 2. Test cat
    res_cat = await ipfs_cat_text(cid)
    assert res_cat == test_text


@pytest.mark.asyncio
async def test_ipfs_dynamic_load_tool():
    # Write a custom tool code block
    custom_tool_code = """
def get_tool_definition():
    def custom_sum(a: int, b: int) -> str:
        return f"Sum: {a + b}"
    return {
        "name": "custom_sum",
        "description": "Calculates the sum of two numbers dynamically",
        "fn": custom_sum,
        "safe": True,
        "agent_mapping": "code"
    }
"""
    # 1. Upload the tool code to IPFS to get a CID
    cid = await _put(custom_tool_code)
    
    # 2. Dynamically load the tool from IPFS using the CID
    res_load = await ipfs_dynamic_load_tool(cid)
    assert res_load.startswith("✓ Successfully loaded custom tool 'custom_sum'")
    
    # 3. Verify it is registered in the TOOLS registry
    tool = get_tool("custom_sum")
    assert tool is not None
    assert tool.description == "Calculates the sum of two numbers dynamically"
    
    # 4. Verify it can be run
    res_run = await tool.run(a=5, b=10)
    assert res_run == "Sum: 15"
    
    # 5. Verify it is mapped to the 'code' agent
    assert "custom_sum" in AGENT_TOOL_MAPPINGS["code"]
    code_tools = tools_for_agent("code")
    assert any(t.name == "custom_sum" for t in code_tools)
