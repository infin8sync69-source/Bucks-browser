// End-to-end checks of the new-tab dashboard ported from Bucks Core: clock and greeting, the
// profile panel, the widget board (today, notes, weather, world clock) and the live status cards
// with the model picker, plus the peer-update approval queue. The weather comes from a local
// stand-in for Open-Meteo; the Soul Engine's pending-update channels are answered by the test.
//
//   npm run build:ui && xvfb-run -a node --test test/e2e/newtab.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = process.env.BUCKS_E2E_ARTIFACTS || path.join(os.tmpdir(), 'bucks-e2e');

async function waitFor(fn, { timeout = 15_000, interval = 150, label }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}: last=${JSON.stringify(last)}`);
}

/** Answers like Open-Meteo's geocoding and forecast APIs, for one city. */
function weatherServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(url.pathname + url.search);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (url.pathname === '/v1/search') {
      const hit = url.searchParams.get('name').toLowerCase() === 'lisbon';
      res.end(JSON.stringify(hit ? { results: [{ name: 'Lisbon', country: 'Portugal', latitude: 38.72, longitude: -9.13, timezone: 'Europe/Lisbon' }] } : {}));
      return;
    }
    res.end(JSON.stringify({
      current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
      current: { temperature_2m: 21.4, relative_humidity_2m: 60, weather_code: 2, wind_speed_10m: 13, is_day: 1 },
      daily: { time: ['2026-10-18', '2026-10-19', '2026-10-20'], weather_code: [2, 61, 0], temperature_2m_max: [23, 19, 24], temperature_2m_min: [15, 14, 16] },
    }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
}

test('new tab: clock, profile, widgets, status cards, model picker, peer updates', { timeout: 180_000 }, async () => {
  assert.ok(fs.existsSync(path.join(root, 'ui', 'build', 'index.html')), 'ui/build missing — run npm run build:ui first');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bucks-e2e-newtab-'));
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ipfs: { autoStart: false } }));
  const weather = await weatherServer();

  const app = await electron.launch({
    cwd: root,
    args: ['.', '--no-sandbox', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      BUCKS_USER_DATA: userData,
      BUCKS_WEATHER_GEOCODE_URL: `${weather.base}/v1/search`,
      BUCKS_WEATHER_FORECAST_URL: `${weather.base}/v1/forecast`,
    },
  });
  const board = () => page.evaluate(() => JSON.parse(localStorage.getItem('bucks_widgets_v1') || '{}'));
  let page;
  try {
    page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.bucks?.widgets?.weather === 'function', null, { timeout: 30_000 });

    // ── clock and greeting ──
    await page.getByLabel('Time').waitFor();
    assert.match(await page.getByLabel('Time').textContent(), /^\d\d:\d\d$/);
    await page.getByText(/^Good (night|morning|afternoon|evening)/).first().waitFor();

    // ── profile: name and bio, used by the greeting and the avatar ──
    await page.getByRole('button', { name: 'Add your name' }).click();
    await page.getByRole('dialog', { name: 'Profile' }).waitFor();
    await page.getByLabel('Display name').fill('Ada');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByLabel('Bio').fill('Builds things on IPFS.');
    await page.getByRole('button', { name: 'Save bio' }).click();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('bucks_profile_v1'))), { name: 'Ada', bio: 'Builds things on IPFS.' });
    await page.getByText('Available once the IPFS node is running.').waitFor();
    await page.screenshot({ path: path.join(ARTIFACTS, 'newtab-profile.png') });
    await page.getByRole('button', { name: 'Close profile' }).click();
    await page.getByText('Ada', { exact: true }).first().waitFor();
    assert.equal((await page.getByRole('button', { name: 'Profile', exact: true }).textContent()).trim(), 'A');

    // ── today and notes (on the board by default) ──
    await page.getByLabel('Add to today').fill('9:30 Standup');
    await page.getByLabel('Add to today').press('Enter');
    await page.getByLabel('Add to today').fill('Buy milk');
    await page.getByLabel('Add to today').press('Enter');
    await page.getByText('Standup').waitFor();
    await page.getByRole('textbox', { name: 'Notes' }).fill('Remember the milk');
    await page.getByRole('textbox', { name: 'Notes' }).blur();
    await waitFor(async () => {
      const b = await board();
      const today = b.widgets?.find((w) => w.type === 'today');
      const notes = b.widgets?.find((w) => w.type === 'notes');
      return today?.config.items.map((i) => `${i.time} ${i.text}`).join('|') === '09:30 Standup| Buy milk' && notes?.config.text === 'Remember the milk';
    }, { label: 'today and notes saved' });
    await page.getByLabel('Done: Standup').check();

    // ── weather widget from the library ──
    await page.getByRole('button', { name: 'Add widget' }).click();
    await page.getByRole('dialog', { name: 'Widget library' }).waitFor();
    await page.getByRole('dialog', { name: 'Widget library' }).getByText('Weather', { exact: true }).locator('xpath=../..').getByRole('button', { name: 'Add' }).click();
    await page.getByLabel('City').fill('Atlantis');
    await page.getByLabel('City').press('Enter');
    await page.getByText('No place called "Atlantis" found').waitFor();
    await page.getByRole('button', { name: 'Change city' }).click();
    await page.getByLabel('City').fill('Lisbon');
    await page.getByLabel('City').press('Enter');
    await page.getByText('21°C').waitFor();
    await page.getByText('Partly cloudy').waitFor();
    assert.ok(weather.requests.some((r) => r.startsWith('/v1/forecast?latitude=38.72')), 'forecast asked for Lisbon\'s coordinates');

    // ── world clock ──
    await page.getByRole('button', { name: 'Add widget' }).click();
    await page.getByRole('dialog', { name: 'Widget library' }).getByText('World clock', { exact: true }).locator('xpath=../..').getByRole('button', { name: 'Add' }).click();
    await page.getByRole('button', { name: 'Add a city' }).click();
    await page.getByLabel('Time zone').fill('Asia/Tokyo');
    await page.getByLabel('Time zone').press('Enter');
    await page.getByText('Tokyo', { exact: true }).waitFor();
    await waitFor(async () => (await board()).widgets.find((w) => w.type === 'clock')?.config.zones?.[0] === 'Asia/Tokyo', { label: 'zone saved' });

    // ── move and remove ──
    const order = async () => (await board()).widgets.map((w) => w.type);
    assert.deepEqual(await order(), ['today', 'notes', 'weather', 'clock']);
    await page.getByRole('button', { name: 'Move World clock left' }).click();
    await waitFor(async () => (await order()).join() === 'today,notes,clock,weather', { label: 'moved left' });
    await page.getByRole('button', { name: 'Remove Notes' }).click();
    await waitFor(async () => (await order()).join() === 'today,clock,weather', { label: 'removed' });

    // ── status cards ──
    await page.getByText('No wallet yet').waitFor();
    await page.getByText('Offline rules').first().waitFor();
    await page.getByRole('button', { name: 'Choose model' }).click();
    const picker = page.getByRole('dialog', { name: 'Choose model' });
    await picker.waitFor();
    await picker.getByText('Soul Engine').waitFor();
    await page.screenshot({ path: path.join(ARTIFACTS, 'newtab-dashboard.png'), fullPage: true });
    await page.keyboard.press('Escape');

    // ── peer updates (the Soul Engine channels are answered here) ──
    await app.evaluate(({ ipcMain }) => {
      let pending = [{ id: 'u1', kind: 'fragment', cid: 'bafkreiexample', summary: 'Notes on Kubo garbage collection', peerSoulId: 'soul-1', peer: { locality: 'Lisbon', capabilities: ['research'] }, createdAt: 1 }];
      globalThis.__decided = [];
      ipcMain.removeHandler('bucks:agent:soul-pending');
      ipcMain.handle('bucks:agent:soul-pending', () => pending);
      ipcMain.removeHandler('bucks:agent:soul-decide');
      ipcMain.handle('bucks:agent:soul-decide', (_e, p) => { globalThis.__decided.push(`${p.action} ${p.id}`); pending = pending.filter((u) => u.id !== p.id); return pending; });
    });
    await page.evaluate(() => window.bucks.settings.set({ agent: { provider: 'soul', soul: { autoStart: false } } }));
    await page.getByRole('button', { name: 'New tab' }).click(); // a fresh new tab re-reads the queue
    await page.getByText('Notes on Kubo garbage collection').waitFor({ timeout: 20_000 });
    await page.getByText('Knowledge offered by Lisbon · research').waitFor();
    await page.getByRole('button', { name: 'Approve' }).click();
    await waitFor(async () => (await page.getByText('Notes on Kubo garbage collection').count()) === 0, { label: 'approved update gone' });
    assert.deepEqual(await app.evaluate(() => globalThis.__decided), ['approve u1']);
  } finally {
    await app.close();
    weather.server.close();
  }
});
