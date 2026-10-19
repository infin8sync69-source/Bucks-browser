# src/main/chat: reference code, not loaded

The end-to-end encrypted chat engine of the Electron "Bucks Core" app (Bucks-App v1.1.0), kept
here as the starting point for chat in Bucks Browser. `src/main/index.js` does not load it, and it
cannot load as is: the files are CommonJS in an ES-module package, `chat-engine.js` needs the old
app's `./agent-integration`, and it talks to an in-process Helia/libp2p node that this browser
replaced with Kubo.

Source: `infin8sync69-source/buckscore`, `Bucks-App/electron/chat-engine.js` and
`signal-store.js` at commit `7fb4ad2`, copied verbatim. This replaced an older copy
(February 2026) that lacked the security fixes below.

What the newer version adds over the older copy:

- Signed pre-key bundles verified with Ed25519; tampered bundles are rejected.
- Trust on first use: once a peer's signing key is verified, a bundle with another key is refused.
- The sender of every direct message must be the Noise-authenticated peer of its stream, and
  key bundles are attributed to the gossipsub-verified publisher, never to a self-reported id.
- Post-quantum layer: ML-KEM-768 key encapsulation and ML-DSA-65 signatures
  (`@noble/post-quantum`, loaded with dynamic `import()`).
- Identity keys and ratchet state encrypted at rest with Electron `safeStorage`.

Known issues to fix in the port (see the unification audit, `buckscore`
`unification/docs/plan/01-current-state.md`):

- `safeStorage` falls back to plaintext files when the OS keychain is unavailable; the port
  should refuse instead.
- Without `BUCKS_CLUSTER_SECRET` every install derives the same public topic names from
  `"BUCKS_DEFAULT_CLUSTER"`.

The port is item 4 of [docs/ROADMAP.md](../../../docs/ROADMAP.md): move transport to Kubo's
pubsub RPC (as `src/main/ipfs/devices-service.js` does), convert to ES modules, and wire it into
`index.js` and `docs/IPC-CONTRACT.md`.
