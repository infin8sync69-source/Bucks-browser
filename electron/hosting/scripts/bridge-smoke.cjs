// Smoke test for ../hosting-bridge.js inside real Electron (needs `npm run fetch:kubo` first).
//   npx electron hosting/scripts/bridge-smoke.cjs <site-folder> <temp-user-data>
// Publishes the folder with an isolated profile, then requests it back as ipfs:// and ipns://
// through the same handler main.js delegates to. Exits non-zero on any failure.
'use strict';
const { app, ipcMain } = require('electron');
const path = require('path');

const [siteDir, userData] = process.argv.slice(-2);
if (!siteDir || !userData || siteDir.endsWith('.cjs')) { console.error('usage: electron bridge-smoke.cjs <site-folder> <temp-user-data>'); process.exit(2); }
app.setPath('userData', path.resolve(userData));
app.disableHardwareAcceleration();

const fail = (msg) => { console.error('FAIL:', msg); app.exit(1); };

app.whenReady().then(async () => {
  try {
    const bridge = require(path.join(__dirname, '..', '..', 'hosting-bridge.js'));
    const state = await bridge.init({ app, ipcMain, getMainWindow: () => null });
    console.log('bridge ready; node state before publish:', state.kubo.status().state);
    if (bridge.serves('ipfs://bafybeidqiapjam5a5xqm2b4n4garkhgbxpxawpdpqd2kom3vl64azyq6fq/')) fail('serves() true before anything is published');

    await state.kubo.start();
    console.log('kubo state:', state.kubo.status().state);

    const folder = await state.service.registerFolder(path.resolve(siteDir));
    const { cid, ipns } = await state.service.publish({ token: folder.token, name: 'bridge smoke', ipns: true, hosting: {} });
    console.log('published', { cid, ipns });
    if (!cid || !ipns) return fail('publish returned no cid/ipns');

    for (const url of [`ipfs://${cid}/`, `ipns://${ipns}/`, `ipfs://${cid}/app.js`]) {
      if (!bridge.serves(url)) return fail(`serves() false for ${url}`);
      const res = await bridge.handle(new Request(url));
      const body = await res.text();
      console.log(url.slice(0, 40) + '…', res.status, res.headers.get('content-type'), JSON.stringify(body.slice(0, 50)));
      if (res.status !== 200) return fail(`${url} -> ${res.status}`);
    }
    const env = await bridge.handle(new Request(`ipfs://${cid}/.env`));
    console.log('.env ->', env.status);
    if (env.status === 200) return fail('.env was published');

    await bridge.shutdown();
    console.log('OK');
    app.exit(0);
  } catch (e) { fail(e.stack || e.message); }
});
