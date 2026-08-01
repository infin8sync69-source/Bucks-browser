#!/usr/bin/env node
/**
 * Build a Bucks Browser distributable, pin it (and a signed release
 * manifest) to IPFS through this machine's OWN already-running Bucks
 * instance, and ask it to gossip-announce the new version to the cluster.
 *
 * Requires: a Bucks Browser instance already running on this machine (its
 * IPFS bridge is how this script reaches IPFS — no separate node here).
 *
 * Usage:
 *   node scripts/build-and-pin-release.js [--notes "changelog text"]
 *
 * First run generates a maintainer release-signing keypair at
 * ~/.bucks/release_signing_key.pem (override dir via BUCKS_HOME) and prints
 * the public key — every member app must be launched with
 * BUCKS_RELEASE_PUBLISHER_PUBKEY set to that value to trust releases signed
 * by this machine.
 *
 * In addition to the per-platform installer artifacts, this also pins the
 * unpacked app directory as a content-addressed UnixFS tree ("appTree") —
 * unchanged files keep the same CID across releases, so members already
 * running Bucks only fetch what actually changed. The release is tagged
 * "routine" (hot-swappable, no reinstall) unless the Electron version or a
 * native dependency changed since the last release, in which case it's
 * tagged "runtime" (members fall back to downloading the full installer).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const { execSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const ELECTRON_DIR = path.join(REPO_ROOT, "electron");
const BUCKS_HOME = process.env.BUCKS_HOME || path.join(os.homedir(), ".bucks");
const RELEASE_KEY_FILE = path.join(BUCKS_HOME, "release_signing_key.pem");
const MANIFEST_FILE = path.join(BUCKS_HOME, "ipfs.json");
const LAST_RELEASE_FILE = path.join(BUCKS_HOME, "last-release-manifest.json");

// Native/prebuilt-binary deps — an Electron version bump or a change to this
// set means a hot-swapped resources/app tree would run against a mismatched
// Electron/Node ABI, so that release must fall back to a full reinstall
// (tier: "runtime") rather than the routine content-addressed swap.
const NATIVE_DEP_MARKERS = ["fsevents", "node-datachannel", "node-llama-cpp"];

function log(msg) { console.log(`[build-and-pin-release] ${msg}`); }

function loadOrCreateReleaseKey() {
  fs.mkdirSync(BUCKS_HOME, { recursive: true });
  if (fs.existsSync(RELEASE_KEY_FILE)) {
    const pem = fs.readFileSync(RELEASE_KEY_FILE, "utf8");
    return crypto.createPrivateKey(pem);
  }
  log("No release-signing key found — generating one (first run).");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  fs.writeFileSync(RELEASE_KEY_FILE, pem, { mode: 0o600 });
  log(`Release-signing key created at ${RELEASE_KEY_FILE} — back this up, it's the ONLY way to publish trusted updates.`);
  return privateKey;
}

function rawPubKeyHex(privateKey) {
  const pub = crypto.createPublicKey(privateKey);
  const der = pub.export({ type: "spki", format: "der" });
  return der.slice(-32).toString("hex"); // last 32 bytes = raw Ed25519 pubkey
}

function findEndpoints() {
  let ipfsUrl = "http://127.0.0.1:5001";
  let bridgeUrl = "http://127.0.0.1:3939";

  if (fs.existsSync(MANIFEST_FILE)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
      if (manifest.apiUrl) ipfsUrl = manifest.apiUrl;
      if (manifest.bridgeUrl) bridgeUrl = manifest.bridgeUrl;
    } catch (_) {}
  }
  return { ipfsUrl, bridgeUrl };
}

function addToIpfs(bridgeUrl, buf, filename) {
  return new Promise((resolve, reject) => {
    const boundary = `----buckspin${Date.now().toString(16)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, buf, tail]);
    const req = http.request(
      `${bridgeUrl}/api/v0/add?pin=true`,
      { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`add ${filename} -> HTTP ${res.statusCode}: ${out}`));
          try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`add ${filename} timed out`)));
    req.write(body);
    req.end();
  });
}

function postJson(bridgeUrl, urlPath, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request(
      `${bridgeUrl}${urlPath}`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () => {
          try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Platform/arch labels matching cluster-updater.js::pickArtifact()
const PLATFORM = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
const EXT_KIND = {
  ".dmg": "dmg", ".zip": "zip", ".exe": "nsis", ".AppImage": "appimage",
};

function discoverArtifacts(distDir) {
  const files = fs.readdirSync(distDir, { withFileTypes: true }).filter((d) => d.isFile());
  const artifacts = [];
  for (const f of files) {
    const ext = path.extname(f.name);
    if (!EXT_KIND[ext]) continue;
    // electron-builder's "portable" win target also produces a .exe — kind
    // can't be told apart from nsis by extension alone, so filename must say.
    let kind = EXT_KIND[ext];
    if (ext === ".exe" && /portable/i.test(f.name)) kind = "portable";
    artifacts.push({ filename: f.name, fullPath: path.join(distDir, f.name), kind });
  }
  return artifacts;
}

/**
 * Best-effort locate electron-builder's unpacked app directory (the same
 * files that get zipped/packaged into the installer artifacts, minus
 * dev-only dependencies). Layout varies by platform/arch and isn't part of
 * electron-builder's public API, so this degrades gracefully: if nothing
 * matches, callers should skip appTree pinning and fall back to
 * tier "runtime" for this release rather than fail the whole build.
 */
function findUnpackedAppDir(distDir) {
  if (!fs.existsSync(distDir)) return null;
  const entries = fs.readdirSync(distDir, { withFileTypes: true });

  if (PLATFORM === "mac") {
    for (const e of entries) {
      if (e.isDirectory()) {
        const appMatch = fs.readdirSync(path.join(distDir, e.name)).find((n) => n.endsWith(".app"));
        if (appMatch) {
          const candidate = path.join(distDir, e.name, appMatch, "Contents", "Resources", "app");
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
    return null;
  }

  // win/linux: electron-builder names these "<platform>[-<arch>]-unpacked"
  const suffix = PLATFORM === "win" ? "win" : "linux";
  const match = entries.find((e) => e.isDirectory() && e.name.startsWith(suffix) && e.name.endsWith("-unpacked"));
  if (!match) return null;
  const candidate = path.join(distDir, match.name, "resources", "app");
  return fs.existsSync(candidate) ? candidate : null;
}

/** Load the previous release's manifest (if any) to diff native/Electron deps. */
function loadLastRelease() {
  if (!fs.existsSync(LAST_RELEASE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LAST_RELEASE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveLastRelease(manifest) {
  fs.writeFileSync(LAST_RELEASE_FILE, JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * "routine" (JS/HTML/CSS/asset-only changes) can be hot-swapped into a
 * running app without reinstalling; "runtime" (Electron version bump, or a
 * native/prebuilt-binary dependency changed) needs a real reinstall since a
 * swapped resources/app tree would run against a mismatched Electron/Node
 * ABI. No previous release to diff against means no safe baseline — default
 * to "runtime" (a first release is a fresh install either way).
 */
function computeTier(pkg, lastRelease) {
  if (!lastRelease || !lastRelease.electronVersion || !lastRelease.nativeDeps) return "runtime";
  if (pkg.devDependencies.electron !== lastRelease.electronVersion) return "runtime";
  const nativeDeps = NATIVE_DEP_MARKERS.filter((m) => pkg.dependencies?.[m] || pkg.devDependencies?.[m])
    .map((m) => `${m}@${pkg.dependencies?.[m] || pkg.devDependencies?.[m]}`)
    .sort();
  if (JSON.stringify(nativeDeps) !== JSON.stringify(lastRelease.nativeDeps)) return "runtime";
  return "routine";
}

async function main() {
  const notesArgIdx = process.argv.indexOf("--notes");
  const notes = notesArgIdx !== -1 ? process.argv[notesArgIdx + 1] || "" : "";

  const pkg = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, "package.json"), "utf8"));
  const version = pkg.version;
  log(`Building Bucks Browser v${version} for ${PLATFORM}/${process.arch}...`);

  execSync("npm run dist", { cwd: ELECTRON_DIR, stdio: "inherit" });

  const distDir = path.join(ELECTRON_DIR, "dist");
  const found = discoverArtifacts(distDir);

  // Source-tarball artifact generation
  const tarballPath = path.join(distDir, `bucks-browser-src-${version}.tar.gz`);
  log(`Generating source-tarball at ${tarballPath}...`);
  try {
    execSync(`bash "${path.join(REPO_ROOT, "scripts", "build-dist-tarball.sh")}" "${tarballPath}"`, { stdio: "inherit" });
    found.push({
      filename: path.basename(tarballPath),
      fullPath: tarballPath,
      kind: "source-tarball",
      isSource: true
    });
  } catch (e) {
    log(`Warning: failed to build source-tarball (${e.message})`);
  }

  if (found.length === 0) throw new Error(`No recognizable build artifacts in ${distDir}`);
  log(`Found ${found.length} artifact(s): ${found.map((a) => a.filename).join(", ")}`);

  const { ipfsUrl, bridgeUrl } = findEndpoints();
  log(`Pinning through IPFS: ${ipfsUrl} (Bridge: ${bridgeUrl})`);

  const privateKey = loadOrCreateReleaseKey();
  const publisherSoulId = rawPubKeyHex(privateKey);

  const artifacts = [];
  for (const a of found) {
    const buf = fs.readFileSync(a.fullPath);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const added = await addToIpfs(ipfsUrl, buf, a.filename);
    log(`Pinned ${a.filename} -> ${added.Hash} (${buf.length} bytes)`);
    artifacts.push({
      platform: a.isSource ? "any" : PLATFORM,
      arch: a.isSource ? "any" : process.arch,
      kind: a.kind,
      filename: a.filename, cid: added.Hash, size: buf.length, sha256,
    });
  }

  const lastRelease = loadLastRelease();
  const tier = computeTier(pkg, lastRelease);
  log(`Release tier: ${tier}${tier === "runtime" ? " (Electron/native deps changed, or first release — full reinstall required)" : " (JS/HTML/CSS/assets only — hot-swappable)"}`);

  let appTree = null;
  const unpackedDir = findUnpackedAppDir(distDir);
  if (unpackedDir) {
    try {
      const dirResult = await postJson(bridgeUrl, "/api/v0/add-dir", { dirPath: unpackedDir });
      if (dirResult.Hash) {
        appTree = { rootCid: dirResult.Hash, fileCount: dirResult.FileCount, totalSize: dirResult.TotalSize };
        log(`Pinned appTree -> ${appTree.rootCid} (${appTree.fileCount} files, ${appTree.totalSize} bytes)`);
      } else {
        log(`add-dir did not return a CID (${JSON.stringify(dirResult)}) — skipping appTree, this release stays runtime-tier for clients.`);
      }
    } catch (e) {
      log(`Failed to pin appTree (${e.message}) — skipping, this release stays runtime-tier for clients.`);
    }
  } else {
    log(`Could not locate electron-builder's unpacked app directory under ${distDir} — skipping appTree, this release stays runtime-tier for clients.`);
  }
  const effectiveTier = appTree ? tier : "runtime";

  const nativeDeps = NATIVE_DEP_MARKERS.filter((m) => pkg.dependencies?.[m] || pkg.devDependencies?.[m])
    .map((m) => `${m}@${pkg.dependencies?.[m] || pkg.devDependencies?.[m]}`)
    .sort();

  const manifest = {
    version,
    releasedAt: new Date().toISOString(),
    notes,
    tier: effectiveTier,
    appTree,
    artifacts,
    publisherSoulId,
  };
  const payload = [
    version, manifest.releasedAt, artifacts.map((a) => a.cid).sort().join(","),
    publisherSoulId, effectiveTier, appTree ? appTree.rootCid : "",
  ].join("|");
  manifest.signature = crypto.sign(null, Buffer.from(payload), privateKey).toString("hex");

  saveLastRelease({ electronVersion: pkg.devDependencies.electron, nativeDeps });

  const manifestBuf = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestAdded = await addToIpfs(ipfsUrl, manifestBuf, `bucks-release-${version}.json`);
  log(`Pinned manifest -> ${manifestAdded.Hash}`);

  const announceResult = await postJson(bridgeUrl, "/api/v0/bucks/release/announce", {
    manifestCid: manifestAdded.Hash,
    manifest,
  });
  if (!announceResult.ok) throw new Error(`Announce failed: ${JSON.stringify(announceResult)}`);

  log("");
  log(`✅ Release v${version} pinned and announced to the cluster.`);
  log(`   Manifest CID: ${manifestAdded.Hash}`);
  log(`   Publisher soulId (BUCKS_RELEASE_PUBLISHER_PUBKEY for every member app): ${publisherSoulId}`);
}

main().catch((err) => {
  console.error(`[build-and-pin-release] FAILED: ${err.message}`);
  process.exit(1);
});
