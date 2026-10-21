// The new tab's widgets show real or user-entered data: weather from Open-Meteo (a local
// stand-in here), an agenda and notes the user writes, tabs that are playing sound.
const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const http = require('http');

test.describe('New tab widgets', () => {
  let weatherServer, app, page, requests;

  test.beforeAll(async () => {
    requests = [];
    weatherServer = http.createServer((req, res) => {
      requests.push(req.url);
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/geo')) {
        res.end(JSON.stringify({ results: [{ name: 'Testville', admin1: 'Test', country: 'Nowhere', latitude: 1, longitude: 2, timezone: 'UTC' }] }));
      } else {
        res.end(JSON.stringify({
          current: { temperature_2m: 17.6, weather_code: 3, is_day: 1 },
          current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
          daily: { time: ['2026-10-21', '2026-10-22', '2026-10-23'], weather_code: [3, 61, 0], temperature_2m_max: [19, 15, 21], temperature_2m_min: [9, 8, 10] },
        }));
      }
    });
    await new Promise((r) => weatherServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${weatherServer.address().port}`;
    app = await electron.launch({
      args: ['.'],
      env: { ...process.env, BUCKS_TESTING: '1', BUCKS_WEATHER_GEOCODE_URL: `${base}/geo`, BUCKS_WEATHER_FORECAST_URL: `${base}/forecast` },
    });
    const deadline = Date.now() + 20000;
    for (;;) {
      page = app.windows().find((w) => w.url().includes('index.html'));
      if (page) break;
      if (Date.now() > deadline) throw new Error('Shell window never appeared');
      await new Promise((r) => setTimeout(r, 250));
    }
    await page.waitForLoadState('domcontentloaded');
    // Start from known widgets, including a saved markets widget from an older version.
    await page.evaluate(() => localStorage.setItem('bucks-widgets', JSON.stringify([
      { uid: 1, type: 'weather', x: 10, y: 10, w: 250, h: 200, z: 1 },
      { uid: 2, type: 'calendar', x: 270, y: 10, w: 290, h: 220, z: 2 },
      { uid: 3, type: 'notes', x: 10, y: 220, w: 290, h: 210, z: 3 },
      { uid: 4, type: 'music', x: 310, y: 240, w: 300, h: 150, z: 4 },
      { uid: 5, type: 'markets', x: 600, y: 10, w: 270, h: 210, z: 5 },
    ])));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
    await reveal();
  });

  test.afterAll(async () => {
    await app.close();
    weatherServer.close();
  });

  // The board is hidden in the current new tab design (index.html, display:none !important);
  // show it so the widgets themselves can be exercised.
  const reveal = () => page.evaluate(() => {
    for (const id of ['dashboard-window', 'view-home']) document.getElementById(id).classList.remove('hidden');
    document.getElementById('widgets-board').style.setProperty('display', 'block', 'important');
  });
  const board = () => page.locator('#widgets-board');

  test('the retired markets widget (fixed sample prices) is gone, and no sample content remains', async () => {
    const text = await board().innerText();
    expect(text).not.toMatch(/AAPL|NVDA|TSLA|MARKETS|Kacey|Deeper Well|LISBON/);
  });

  test('weather asks for a city, then shows the forecast and sends only the city name', async () => {
    const weather = board().locator('.widget-tile').nth(0);
    await weather.locator('input').fill('Testville');
    await weather.locator('input').press('Enter');
    await expect(weather).toContainText('18°C'); // 17.6 rounded
    await expect(weather).toContainText('TESTVILLE');
    await expect(weather).toContainText('Overcast');
    const geo = requests.find((u) => u.startsWith('/geo'));
    expect(geo).toContain('name=Testville');
    expect(requests.join(' ')).not.toMatch(/Bearer|token/i);
  });

  test('agenda keeps what you add, across a reload', async () => {
    const agenda = board().locator('.widget-tile').nth(1);
    await expect(agenda).toContainText('Nothing planned');
    await agenda.locator('input').fill('9:30 Standup');
    await agenda.locator('input').press('Enter');
    await expect(agenda).toContainText('Standup');
    await expect(agenda).toContainText('9:30');
    await page.reload();
    await page.waitForTimeout(1500);
    await reveal();
    await expect(board().locator('.widget-tile').nth(1)).toContainText('Standup');
  });

  test('notes persist what you type', async () => {
    const notes = board().locator('.widget-tile').nth(2).locator('textarea');
    await notes.fill('remember the milk');
    await page.waitForTimeout(700); // debounce
    await page.reload();
    await page.waitForTimeout(1500);
    await reveal();
    await expect(board().locator('.widget-tile').nth(2).locator('textarea')).toHaveValue('remember the milk');
  });

  test('now playing says so when nothing is playing', async () => {
    await expect(board().locator('.widget-tile').nth(3)).toContainText('Nothing is playing');
  });
});
