import logging
from typing import Callable, Optional
from rag.ipfs_store import IPFSKnowledgeStore
from config import IPFS_API_URL

log = logging.getLogger("bucks.tools.ipfs")


async def ipfs_upload_text(text: str) -> str:
    """
    Upload text content (documents, pages, scripts) to IPFS.
    Returns: CID of the uploaded content.
    """
    try:
        store = IPFSKnowledgeStore(IPFS_API_URL)
        cid = await store.publish_fragment(text)
        if cid:
            log.info(f"Successfully uploaded text to IPFS. CID: {cid}")
            return f"✓ Successfully uploaded to IPFS. CID: {cid}"
        return "Error: IPFS upload failed."
    except Exception as e:
        log.error(f"IPFS upload failed: {e}")
        return f"Error: {e}"


async def ipfs_cat_text(cid: str) -> str:
    """
    Fetch and read text content from an IPFS CID.
    """
    try:
        store = IPFSKnowledgeStore(IPFS_API_URL)
        # Try fetching as a structured JSON fragment first
        frag = await store.fetch_fragment(cid)
        if frag and isinstance(frag, dict) and "text" in frag:
            return frag["text"]
        elif frag:
            # Fallback to entire JSON if not formatted as a standard fragment
            import json
            return json.dumps(frag)
        
        # Fallback to raw text fetch (for normal documents/files)
        raw_text = await store.fetch_raw(cid)
        if raw_text is not None:
            return raw_text

        return f"Error: Failed to fetch CID {cid} from IPFS."
    except Exception as e:
        log.error(f"IPFS fetch failed for {cid}: {e}")
        return f"Error: {e}"


async def ipfs_dynamic_load_tool(cid: str) -> str:
    """
    Fetch a Python script from IPFS and dynamically load/register it as an agent tool.
    The script must define a function 'get_tool_definition() -> dict' which returns:
    {
        'name': str,
        'description': str,
        'fn': Callable,
        'safe': bool (optional, defaults to True),
        'agent_mapping': str (optional, defaults to 'code')
    }
    """
    from tools.registry import register_dynamic_tool
    
    code = await ipfs_cat_text(cid)
    if code.startswith("Error:"):
        return f"Failed to retrieve tool code from IPFS: {code}"
    
    # Compile and execute the retrieved code in a localized dictionary
    local_scope = {}
    try:
        # We pass globals() to allow importing modules inside the script
        exec(code, globals(), local_scope)
    except Exception as e:
        log.error(f"Error compiling script from IPFS CID {cid}: {e}")
        return f"Error compiling script from IPFS: {e}"
    
    if "get_tool_definition" not in local_scope:
        return "Error: The IPFS script does not define the required 'get_tool_definition()' function."
    
    try:
        defn = local_scope["get_tool_definition"]()
        name = defn.get("name")
        desc = defn.get("description")
        fn = defn.get("fn")
        safe = defn.get("safe", True)
        agent_mapping = defn.get("agent_mapping", "code")
        
        if not name or not desc or not fn:
            return "Error: Invalid tool definition returned (missing name, description, or fn)."
            
        register_dynamic_tool(name, desc, fn, safe, agent_mapping)
        log.info(f"Successfully registered dynamic tool '{name}' from IPFS CID {cid}")
        return f"✓ Successfully loaded custom tool '{name}' from IPFS CID {cid}."
    except Exception as e:
        log.error(f"Error registering dynamic tool from IPFS CID {cid}: {e}")
        return f"Error registering dynamic tool: {e}"
