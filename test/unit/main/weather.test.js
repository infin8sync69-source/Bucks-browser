import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/electron-loader.mjs', import.meta.url);
const { createWeather, parseForecast, parsePlace, weatherCode, cleanCity, GEOCODE_URL, FORECAST_URL } = await import('../../../src/main/weather.js');

const GEO = { results: [{ name: 'Lisbon', admin1: 'Lisbon', country: 'Portugal', latitude: 38.72, longitude: -9.13, timezone: 'Europe/Lisbon' }] };
const FORECAST = {
  current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
  current: { temperature_2m: 21.4, apparent_temperature: 20.9, relative_humidity_2m: 60, weather_code: 2, wind_speed_10m: 13.1, is_day: 1 },
  daily: { time: ['2026-10-18', '2026-10-19', '2026-10-20'], weather_code: [2, 61, 0], temperature_2m_max: [23, 19, 24], temperature_2m_min: [15, 14, null] },
};

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const body = routes[`${u.origin}${u.pathname}`];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (typeof body === 'function' ? body(u) : body) };
  };
  return { fetchImpl, calls };
}

test('weather codes, city names and parsing', () => {
  assert.deepEqual(weatherCode(0), { label: 'Clear', icon: 'sun' });
  assert.equal(weatherCode(63).icon, 'rain');
  assert.equal(weatherCode(96).label, 'Thunderstorm');
  assert.equal(weatherCode(undefined).label, 'Unknown');
  assert.equal(cleanCity('  New   York '), 'New York');
  assert.throws(() => cleanCity(''), /Type a city/);
  assert.throws(() => cleanCity('x'.repeat(81)), /too long/);
  assert.throws(() => cleanCity(42), /Type a city/);
  assert.equal(parsePlace({ results: [] }), null);
  assert.equal(parsePlace({ results: [{ name: 'X' }] }), null);
  const f = parseForecast(FORECAST);
  assert.equal(f.temperature, 21.4);
  assert.equal(f.label, 'Partly cloudy');
  assert.equal(f.days.length, 2, 'a day with a missing value is left out');
  assert.equal(f.days[1].icon, 'rain');
  assert.throws(() => parseForecast({}), /Unexpected forecast/);
});

test('lookup geocodes, fetches the forecast, and caches per city', async () => {
  const { fetchImpl, calls } = fakeFetch({ [GEOCODE_URL]: GEO, [FORECAST_URL]: FORECAST });
  let now = 1_000_000;
  const w = createWeather({ fetchImpl, now: () => now });
  const r = await w.lookup('lisbon');
  assert.equal(r.place.name, 'Lisbon');
  assert.equal(r.place.country, 'Portugal');
  assert.equal(r.temperature, 21.4);
  assert.equal(calls.length, 2);
  const forecast = new URL(calls[1]);
  assert.equal(forecast.searchParams.get('latitude'), '38.72');
  assert.equal(forecast.searchParams.get('timezone'), 'Europe/Lisbon');
  assert.equal(new URL(calls[0]).searchParams.get('name'), 'lisbon');

  await w.lookup('  LISBON ');
  assert.equal(calls.length, 2, 'cached');
  now += 16 * 60_000;
  await w.lookup('Lisbon');
  assert.equal(calls.length, 4, 'cache expires after 15 minutes');
});

test('lookup errors are readable', async () => {
  const { fetchImpl } = fakeFetch({ [GEOCODE_URL]: { results: [] }, [FORECAST_URL]: FORECAST });
  await assert.rejects(createWeather({ fetchImpl }).lookup('Atlantis'), /No place called "Atlantis"/);
  const down = fakeFetch({});
  await assert.rejects(createWeather({ fetchImpl: down.fetchImpl }).lookup('Lisbon'), /responded 404/);
});
