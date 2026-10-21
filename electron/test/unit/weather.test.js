'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanCity, parsePlace, parseForecast, weatherCode, createWeather } = require('../../weather');

const GEO = { results: [{ name: 'Lisbon', admin1: 'Lisbon', country: 'Portugal', latitude: 38.7, longitude: -9.1, timezone: 'Europe/Lisbon' }] };
const FORECAST = {
  current: { temperature_2m: 21.4, apparent_temperature: 20, relative_humidity_2m: 55, weather_code: 2, wind_speed_10m: 12, is_day: 1 },
  current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
  daily: { time: ['2026-10-21', '2026-10-22'], weather_code: [1, 61], temperature_2m_max: [23, 19], temperature_2m_min: [14, null] },
};

const fakeFetch = (log) => async (url) => {
  log.push(String(url));
  const body = String(url).includes('geocoding') ? GEO : FORECAST;
  return { ok: true, status: 200, json: async () => body };
};

test('cleanCity trims and rejects empty or oversized names', () => {
  assert.equal(cleanCity('  New   York '), 'New York');
  assert.throws(() => cleanCity('   '), /city name/);
  assert.throws(() => cleanCity('x'.repeat(81)), /too long/);
});

test('weatherCode maps WMO codes', () => {
  assert.equal(weatherCode(0).label, 'Clear');
  assert.equal(weatherCode(63).label, 'Rain');
  assert.equal(weatherCode(999).label, 'Unknown');
});

test('parsePlace takes the first hit and rejects unusable results', () => {
  assert.equal(parsePlace(GEO).name, 'Lisbon');
  assert.equal(parsePlace({ results: [] }), null);
  assert.equal(parsePlace({ results: [{ name: 'X' }] }), null);
});

test('parseForecast reads current conditions and drops days with missing temperatures', () => {
  const r = parseForecast(FORECAST);
  assert.equal(r.temperature, 21.4);
  assert.equal(r.label, 'Partly cloudy');
  assert.equal(r.days.length, 1); // second day has a null minimum
  assert.throws(() => parseForecast({}), /Unexpected/);
});

test('lookup sends only the city name, then serves repeats from the cache', async () => {
  const calls = [];
  let t = 1000;
  const w = createWeather({ fetchImpl: fakeFetch(calls), now: () => t });
  const a = await w.lookup('Lisbon');
  assert.equal(a.place.name, 'Lisbon');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('name=Lisbon'));
  assert.ok(!/key|token|user/i.test(calls[0]));
  await w.lookup('lisbon');
  assert.equal(calls.length, 2, 'cached');
  t += 16 * 60_000;
  await w.lookup('Lisbon');
  assert.equal(calls.length, 4, 'cache expired');
});

test('lookup reports an unknown place and a failing service', async () => {
  const none = createWeather({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(() => none.lookup('Nowhereville'), /No place called/);
  const down = createWeather({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(() => down.lookup('Lisbon'), /503/);
});
