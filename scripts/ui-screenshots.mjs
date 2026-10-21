#!/usr/bin/env node
// Screenshots of the chrome's main screens, and a pixel comparison of two sets. Used to check that
// a styling change (such as the design-token migration) looks the way it should.
//
//   npm run build:ui && xvfb-run -a node scripts/ui-screenshots.mjs --out /tmp/shots-before
//   node scripts/ui-screenshots.mjs --compare /tmp/shots-before /tmp/shots-after --diff /tmp/shots-diff
//
// --compare prints, per screen, the share of pixels that changed (any channel by more than 8/255)
// and writes a diff image (changed pixels in magenta over a dimmed copy of the first image).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

const PAGES = ['settings', 'downloads', 'history', 'bookmarks', 'ipfs', 'wallet', 'login', 'superapp', 'implementation'];

async function capture(out) {
  fs.mkdirSync(out, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-shots-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ipfs: { autoStart: false } }));
  const app = await electron.launch({ cwd: root, args: ['.', '--no-sandbox', `--user-data-dir=${userData}`], env: { ...process.env, BUCKS_USER_DATA: userData, TZ: 'UTC' } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setBounds({ x: 0, y: 0, width: 1280, height: 800 }); });
    await page.waitForFunction(() => typeof window.bucks?.tabs?.create === 'function', null, { timeout: 30_000 });
    // Freeze time-dependent and animated parts so two runs are comparable.
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await page.waitForTimeout(1500);
    const shot = async (name) => {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(out, `${name}.png`) });
      console.log(`captured ${name}`);
    };
    await shot('newtab');
    const omnibox = page.getByLabel('Address or search');
    for (const p of PAGES) {
      await omnibox.fill(`bucks://${p}`);
      await omnibox.press('Enter');
      await shot(p);
    }
    await omnibox.fill('bucks://newtab');
    await omnibox.press('Enter');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f').catch(() => {});
    await shot('find-bar');
    await page.keyboard.press('Escape');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

async function compare(a, b, diffDir) {
  fs.mkdirSync(diffDir, { recursive: true });
  // nativeImage decodes PNGs; run it inside Electron's main process.
  const app = await electron.launch({ cwd: root, args: [path.join(root, 'scripts', 'lib', 'blank-main.cjs'), '--no-sandbox'] });
  try {
    const names = fs.readdirSync(a).filter((f) => f.endsWith('.png') && fs.existsSync(path.join(b, f)));
    for (const name of names) {
      const r = await app.evaluate(({ nativeImage }, { pa, pb }) => {
        const ia = nativeImage.createFromPath(pa);
        const ib = nativeImage.createFromPath(pb);
        const sa = ia.getSize();
        const sb = ib.getSize();
        if (sa.width !== sb.width || sa.height !== sb.height) return { error: `sizes differ: ${sa.width}x${sa.height} vs ${sb.width}x${sb.height}` };
        const ba = ia.toBitmap();
        const bb = ib.toBitmap();
        const out = Buffer.alloc(ba.length);
        let changed = 0;
        for (let i = 0; i < ba.length; i += 4) {
          const d = Math.max(Math.abs(ba[i] - bb[i]), Math.abs(ba[i + 1] - bb[i + 1]), Math.abs(ba[i + 2] - bb[i + 2]));
          if (d > 8) { changed += 1; out[i] = 255; out[i + 1] = 0; out[i + 2] = 255; out[i + 3] = 255; } // BGRA magenta
          else { out[i] = ba[i] >> 2; out[i + 1] = ba[i + 1] >> 2; out[i + 2] = ba[i + 2] >> 2; out[i + 3] = 255; }
        }
        return { share: changed / (ba.length / 4), png: nativeImage.createFromBitmap(out, sa).toPNG().toString('base64') };
      }, { pa: path.join(a, name), pb: path.join(b, name) });
      if (r.png) fs.writeFileSync(path.join(diffDir, name), Buffer.from(r.png, 'base64'));
      console.log(`${name.padEnd(22)} ${r.error || `${(r.share * 100).toFixed(2)}% of pixels changed`}`);
    }
  } finally {
    await app.close().catch(() => {});
  }
}

if (opt('--out')) await capture(path.resolve(opt('--out')));
else if (argv.includes('--compare')) {
  const i = argv.indexOf('--compare');
  await compare(path.resolve(argv[i + 1]), path.resolve(argv[i + 2]), path.resolve(opt('--diff') || path.join(os.tmpdir(), 'bucks-shots-diff')));
} else {
  console.error('usage: ui-screenshots.mjs --out <dir> | --compare <dirA> <dirB> [--diff <dir>]');
  process.exit(2);
}
