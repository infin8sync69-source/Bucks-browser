"""
IPFSKnowledgeStore — stores and retrieves knowledge fragments on IPFS.

Peer agents publish their KB fragments here. When a peer soul is registered,
we pull their KB CIDs and embed them into local floating memory.
"""
import json
import logging
from typing import List, Optional

import aiohttp

log = logging.getLogger("bucks.rag.ipfs_store")


class IPFSKnowledgeStore:
    def __init__(self, ipfs_api_url: str = "http://localhost:5001"):
        self._url = ipfs_api_url.rstrip("/")

    # ── Write ─────────────────────────────────────────────────────────────────

    async def publish_fragment(self, text: str, metadata: Optional[dict] = None) -> str:
        """
        Publish a knowledge fragment to IPFS.
        Returns the CID string, or "" on failure.
        """
        payload = json.dumps({"text": text, "metadata": metadata or {}})
        try:
            async with aiohttp.ClientSession() as session:
                data = aiohttp.FormData()
                data.add_field(
                    "file",
                    payload.encode(),
                    filename="fragment.json",
                    content_type="application/json",
                )
                async with session.post(
                    f"{self._url}/api/v0/add?pin=true",
                    data=data,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    result = await resp.json()
                    cid = result.get("Hash", "")
                    log.debug("Published fragment to IPFS: %s", cid)
                    return cid
        except Exception as e:
            log.warning("IPFS publish failed: %s", e)
            return ""

    # ── Read ──────────────────────────────────────────────────────────────────

    async def fetch_fragment(self, cid: str) -> Optional[dict]:
        """
        Fetch a knowledge fragment by CID.
        Returns {"text": ..., "metadata": ...} or None.
        """
        if not cid:
            return None
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self._url}/api/v0/cat?arg={cid}",
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    raw = await resp.read()
                    return json.loads(raw)
        except Exception as e:
            log.warning("IPFS fetch failed for %s: %s", cid, e)
            return None

    async def index_peer_fragments(self, peer_soul: dict) -> List[dict]:
        """
        Pull all knowledge fragments from a peer agent's KB CIDs
        (listed in peer_soul["kbCids"]) and return as list of dicts.
        """
        cids: List[str] = peer_soul.get("kbCids", [])
        fragments = []
        for cid in cids:
            frag = await self.fetch_fragment(cid)
            if frag and frag.get("text"):
                frag["_cid"] = cid
                frag["_peer"] = peer_soul.get("soulId", "unknown")[:16]
                fragments.append(frag)
        log.info("Indexed %d fragments from peer %s", len(fragments), peer_soul.get("soulId", "?")[:16])
        return fragments
