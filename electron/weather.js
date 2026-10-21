// Ported from Bucks-browser (src/main/weather.js).
// Weather for the new-tab page's weather widget, from Open-Meteo (free, no API key, no account).
// Fetched here, in the main process, so the shell needs no network access for it. Only the city name the user typed leaves the machine; results are cached for 15 min.
//
//   widgets:weather { city } → WeatherReport
//
// BUCKS_WEATHER_GEOCODE_URL / BUCKS_WEATHER_FORECAST_URL point at a self-hosted Open-Meteo (or a
// test server) instead of the public one.

const { ipcMain } = require('electron');

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_MS = 15 * 60_000;
const TIMEOUT_MS = 8000;
const MAX_CITY = 80;

/** WMO weather interpretation codes (as used by Open-Meteo) → a short label and an icon name. */
function weatherCode(code) {
  const c = Number(code);
  if (c === 0) return { label: 'Clear', icon: 'sun' };
  if (c === 1) return { label: 'Mainly clear', icon: 'sun' };
  if (c === 2) return { label: 'Partly cloudy', icon: 'cloud-sun' };
  if (c === 3) return { label: 'Overcast', icon: 'cloud' };
  if (c === 45 || c === 48) return { label: 'Fog', icon: 'fog' };
  if (c >= 51 && c <= 57) return { label: 'Drizzle', icon: 'drizzle' };
  if (c >= 61 && c <= 67) return { label: 'Rain', icon: 'rain' };
  if (c >= 71 && c <= 77) return { label: 'Snow', icon: 'snow' };
  if (c >= 80 && c <= 82) return { label: 'Rain showers', icon: 'rain' };
  if (c === 85 || c === 86) return { label: 'Snow showers', icon: 'snow' };
  if (c >= 95 && c <= 99) return { label: 'Thunderstorm', icon: 'storm' };
  return { label: 'Unknown', icon: 'cloud' };
}

/** A city name the user typed, trimmed; throws on anything unusable. */
function cleanCity(city) {
  const c = typeof city === 'string' ? city.trim().replace(/\s+/g, ' ') : '';
  if (!c) throw new Error('Type a city name');
  if (c.length > MAX_CITY) throw new Error('City name too long');
  return c;
}

/** The first geocoding hit, or null. */
function parsePlace(json) {
  const r = Array.isArray(json?.results) ? json.results[0] : null;
  if (!r || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) return null;
  return {
    name: String(r.name || ''),
    region: String(r.admin1 || ''),
    country: String(r.country || ''),
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: String(r.timezone || 'auto'),
  };
}

const num = (v) => (typeof v === 'number' ? v : NaN); // Open-Meteo sends null for a missing value

/** Current conditions plus the next days from an Open-Meteo forecast response. */
function parseForecast(json) {
  const cur = json?.current;
  if (!cur || !Number.isFinite(cur.temperature_2m)) throw new Error('Unexpected forecast response');
  const d = json.daily || {};
  const days = (Array.isArray(d.time) ? d.time : []).map((date, i) => ({
    date: String(date),
    max: num(d.temperature_2m_max?.[i]),
    min: num(d.temperature_2m_min?.[i]),
    ...weatherCode(d.weather_code?.[i]),
  })).filter((x) => Number.isFinite(x.max) && Number.isFinite(x.min));
  return {
    temperature: cur.temperature_2m,
    apparent: Number.isFinite(cur.apparent_temperature) ? cur.apparent_temperature : null,
    humidity: Number.isFinite(cur.relative_humidity_2m) ? cur.relative_humidity_2m : null,
    wind: Number.isFinite(cur.wind_speed_10m) ? cur.wind_speed_10m : null,
    isDay: cur.is_day !== 0,
    ...weatherCode(cur.weather_code),
    days,
    units: { temperature: json.current_units?.temperature_2m || '°C', wind: json.current_units?.wind_speed_10m || 'km/h' },
  };
}

/**
 * @param {{ fetchImpl?: typeof fetch, geocodeUrl?: string, forecastUrl?: string, now?: () => number }} [deps]
 */
function createWeather({ fetchImpl = (...a) => globalThis.fetch(...a), geocodeUrl = GEOCODE_URL, forecastUrl = FORECAST_URL, now = Date.now } = {}) {
  const cache = new Map(); // lower-case city → { at, report }

  async function getJson(url) {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Weather service responded ${res.status}`);
    return res.json();
  }

  return {
    /** @returns {Promise<object>} the place, the current conditions and a 3-day forecast */
    async lookup(city) {
      const name = cleanCity(city);
      const key = name.toLowerCase();
      const hit = cache.get(key);
      if (hit && now() - hit.at < CACHE_MS) return hit.report;

      const g = new URL(geocodeUrl);
      g.search = new URLSearchParams({ name, count: '1', language: 'en', format: 'json' }).toString();
      const place = parsePlace(await getJson(g.href));
      if (!place) throw new Error(`No place called "${name}" found`);

      const f = new URL(forecastUrl);
      f.search = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min',
        timezone: place.timezone || 'auto',
        forecast_days: '3',
      }).toString();
      const report = { place, ...parseForecast(await getJson(f.href)), fetchedAt: now() };
      cache.set(key, { at: now(), report });
      if (cache.size > 20) cache.delete(cache.keys().next().value);
      return report;
    },
  };
}

/** Register widgets:weather. `fetchImpl` is Electron's net.fetch in the app (system proxy, certificates). */
function installWeather({ fetchImpl, env = process.env } = {}) {
  const weather = createWeather({
    fetchImpl,
    geocodeUrl: env.BUCKS_WEATHER_GEOCODE_URL || GEOCODE_URL,
    forecastUrl: env.BUCKS_WEATHER_FORECAST_URL || FORECAST_URL,
  });
  ipcMain.removeHandler?.('widgets:weather');
  ipcMain.handle('widgets:weather', async (_e, p) => {
    try {
      return await weather.lookup(p?.city);
    } catch (e) {
      console.debug(`[Weather] lookup failed: ${e.message}`);
      throw e;
    }
  });
  return weather;
}

module.exports = { weatherCode, cleanCity, parsePlace, parseForecast, createWeather, installWeather, GEOCODE_URL, FORECAST_URL };
