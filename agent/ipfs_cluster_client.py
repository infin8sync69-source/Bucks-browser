"""
IPFSClusterClient — publish/pin content via a local IPFS Cluster REST API
when one is running (replicates across every peer in that cluster), falling
back to a single Kubo/go-ipfs node otherwise.

Why both: literal IPFS Cluster (`ipfs-cluster-service`) needs a pre-shared
secret distributed to every member out-of-band — a good fit for a user's own
multi-device redundancy (or a small set of trusted pinning nodes), but not
for "any stranger's Bucks install can join," which is what the soul-verified
gossipsub layer (agent/p2p/discovery.py) already handles without a shared
secret. So: peers that run a cluster get extra durability for free: peers
that don't fall back to plain single-node pinning, which still works and is
still content-addressed the same way — Cluster only orchestrates *pinning*
across nodes, it doesn't change how content is stored or fetched, so reads
(GET /api/v0/cat) are unaffected by which write path was used.

Verified against a real running local cluster:
  POST {cluster}/add            -> {"name","cid","size","allocations"}
  POST {cluster}/pins/{cid}     -> pin metadata (200 on success)
  GET  {cluster}/id             -> liveness probe
"""
import logging

import aiohttp

log = logging.getLogger("bucks.ipfs_cluster_client")


class IPFSClusterClient:
    def __init__(
        self,
        ipfs_api_url: str = "http://localhost:5001",
        cluster_api_url: str = "http://127.0.0.1:9094",
    ):
        self._ipfs_url = ipfs_api_url.rstrip("/")
        self._cluster_url = cluster_api_url.rstrip("/") if cluster_api_url else ""

    async def _cluster_up(self) -> bool:
        if not self._cluster_url:
            return False
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self._cluster_url}/id", timeout=aiohttp.ClientTimeout(total=3),
                ) as resp:
                    return resp.status == 200
        except Exception:
            return False

    async def add(self, payload: bytes, filename: str = "file") -> str:
        """Add + pin content. Returns the CID, or '' on total failure."""
        if await self._cluster_up():
            cid = await self._cluster_add(payload, filename)
            if cid:
                return cid
            log.warning("Cluster add failed, falling back to single-node Kubo")
        return await self._kubo_add(payload, filename)

    async def pin_existing(self, cid: str) -> bool:
        """Pin a CID this node already has the content for (e.g. fetched from
        a peer) so it also gets cluster-wide replication going forward."""
        if await self._cluster_up():
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        f"{self._cluster_url}/pins/{cid}",
                        timeout=aiohttp.ClientTimeout(total=15),
                    ) as resp:
                        if resp.status == 200:
                            return True
            except Exception as e:
                log.warning("Cluster pin_existing failed for %s: %s", cid[:16], e)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self._ipfs_url}/api/v0/pin/add?arg={cid}",
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    return resp.status == 200
        except Exception as e:
            log.warning("Kubo pin_existing failed for %s: %s", cid[:16], e)
            return False

    async def _cluster_add(self, payload: bytes, filename: str) -> str:
        try:
            async with aiohttp.ClientSession() as session:
                data = aiohttp.FormData()
                data.add_field("file", payload, filename=filename, content_type="application/json")
                async with session.post(
                    f"{self._cluster_url}/add", data=data,
                    timeout=aiohttp.ClientTimeout(total=20),
                ) as resp:
                    if resp.status != 200:
                        return ""
                    result = await resp.json()
                    cid = result.get("cid", "")
                    log.info("Published via IPFS Cluster: %s", cid)
                    return cid
        except Exception as e:
            log.warning("Cluster add failed: %s", e)
            return ""

    async def _kubo_add(self, payload: bytes, filename: str) -> str:
        try:
            async with aiohttp.ClientSession() as session:
                data = aiohttp.FormData()
                data.add_field("file", payload, filename=filename, content_type="application/json")
                async with session.post(
                    f"{self._ipfs_url}/api/v0/add?pin=true", data=data,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    result = await resp.json()
                    cid = result.get("Hash", "")
                    log.debug("Published to single-node IPFS: %s", cid)
                    return cid
        except Exception as e:
            log.warning("IPFS publish failed: %s", e)
            return ""
