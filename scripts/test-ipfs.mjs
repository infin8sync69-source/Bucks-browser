// bucks browser/scripts/test-ipfs.mjs
//
// This file intentionally just points at the real test suite — see
// ../electron/scripts/test-ipfs.mjs and ../ipfs-experiment-report.md.
//
// Why: the root `bucks browser/package.json` carries its own separate
// (and currently stale/unfixed) copy of the helia/libp2p/gossipsub stack in
// `bucks browser/node_modules`, independent from the one the shipped app
// actually uses (`bucks browser/electron/node_modules`). Running this suite
// from here would resolve against that stale root tree and fail in ways
// that have nothing to do with the app. The real suite lives next to the
// dependency tree it needs to test against.
//
// Run: cd ../electron && node scripts/test-ipfs.mjs

import('../electron/scripts/test-ipfs.mjs');
