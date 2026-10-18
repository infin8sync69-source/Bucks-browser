// Generative UI: turn the Soul Engine's `ui_component` events into the small, flat card shapes the
// chrome renders (docs/IPC-CONTRACT.md, `UiComponent`). The content can come from web pages the
// agent read, so everything is treated as untrusted: only known components survive, strings are
// cut to size, lists are capped, and links must be http(s), ipfs or ipns. The chrome renders the
// result as plain text (never as HTML) and does not load remote images: the chrome's session has
// none of the tracker blocking that tabs get.
// Pure functions, no Electron imports (unit-tested).

import { isAllowedUrl } from './a2ui.js';

export const UI_COMPONENTS = Object.freeze([
  'answer', 'list', 'table', 'stats', 'chart', 'timeline', 'checklist', 'accordion', 'code', 'weather', 'links',
]);

const MAX_COMPONENTS = 12;
const MAX_ITEMS = 50;
const MAX_COLUMNS = 12;
const TEXT = 300;
const LONG_TEXT = 4000;
const CODE_TEXT = 8000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function str(v, max = TEXT) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function url(v) {
  const s = str(v, 2048);
  return isAllowedUrl(s) ? s : '';
}

function num(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.eE+-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function list(v, max = MAX_ITEMS) {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

const join = (...parts) => parts.map((p) => str(p)).filter(Boolean).join(' · ');

function listCard(title, items) {
  const clean = items
    .map((it) => ({ title: str(it.title), subtitle: str(it.subtitle), url: url(it.url) }))
    .filter((it) => it.title || it.url);
  return clean.length ? { component: 'list', title: str(title), items: clean } : null;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;

/**
 * Normalise one engine component spec into zero or more chrome cards.
 * @param {any} spec  `{ component, title?, data }` as emitted by the engine
 * @returns {object[]}
 */
export function normalizeComponent(spec) {
  if (!isObj(spec)) return [];
  const data = isObj(spec.data) ? spec.data : {};
  const title = str(spec.title);
  let out;
  switch (spec.component) {
    case 'answer': {
      const text = str(data.markdown ?? data.text, LONG_TEXT);
      out = text ? { component: 'answer', title, text } : null;
      break;
    }
    case 'list':
      out = listCard(title, list(data.items).filter(isObj).map((it) => ({ title: it.title || it.domain, subtitle: it.subtitle, url: it.url })));
      break;
    case 'product_grid':
      out = listCard(title, list(data.items).filter(isObj).map((it) => ({ title: it.title, subtitle: join(it.price, it.badge), url: it.url })));
      break;
    case 'image_gallery':
      out = listCard(title, list(data.items).filter(isObj).map((it) => ({ title: it.title || it.source, subtitle: it.source, url: it.url || it.image })));
      break;
    case 'video':
      out = listCard(title, list(data.videos).filter(isObj)
        .filter((v) => YOUTUBE_ID.test(String(v.videoId || '')))
        .map((v) => ({ title: v.title, subtitle: join(v.channel, v.duration), url: `https://www.youtube.com/watch?v=${v.videoId}` })));
      break;
    case 'research': {
      const cards = [];
      const summary = str(data.summary, LONG_TEXT);
      if (summary) cards.push({ component: 'answer', title: title || str(data.topic), text: summary });
      const sections = listCard('Findings', list(data.sections).filter(isObj).map((s) => ({ title: s.heading, subtitle: str(s.text), url: s.url })));
      if (sections) cards.push(sections);
      const stats = normalizeComponent({ component: 'stat_cards', title: 'Key figures', data: { stats: data.stats } });
      cards.push(...stats);
      const sources = listCard('Sources', list(data.sources).filter(isObj).map((s) => ({ title: s.title || s.domain, subtitle: s.domain, url: s.url })));
      if (sources) cards.push(sources);
      return cards;
    }
    case 'cta_row': {
      const actions = list(data.actions, 12).filter(isObj).map((a) => {
        const label = str(a.label, 80);
        if (a.kind === 'navigate') return url(a.value) && label ? { label, url: url(a.value) } : null;
        if (a.kind === 'search') return str(a.value) && label ? { label, query: str(a.value) } : null;
        return null; // 'agent' and 'copy' actions have no safe equivalent in the chrome yet
      }).filter(Boolean);
      out = actions.length ? { component: 'links', title, actions } : null;
      break;
    }
    case 'stat_cards': {
      const stats = list(data.stats, 12).filter(isObj).map((s) => ({ label: str(s.label, 80), value: str(s.value, 80), delta: str(s.delta, 40) }))
        .filter((s) => s.label || s.value);
      out = stats.length ? { component: 'stats', title, stats } : null;
      break;
    }
    case 'table': {
      const columns = list(data.columns, MAX_COLUMNS).map((c) => str(c, 80));
      const width = columns.length || MAX_COLUMNS;
      const rows = list(data.rows).filter(Array.isArray).map((r) => r.slice(0, width).map((c) => str(c)));
      out = rows.length ? { component: 'table', title, columns, rows } : null;
      break;
    }
    case 'chart': {
      const series = list(data.series, 24).filter(isObj).map((p) => ({ label: str(p.label, 60), value: num(p.value) }))
        .filter((p) => p.value !== null);
      const kind = ['line', 'bar', 'pie'].includes(data.kind) ? data.kind : 'bar';
      out = series.length ? { component: 'chart', title, kind, series } : null;
      break;
    }
    case 'timeline': {
      const events = list(data.events).filter(isObj).map((e) => ({ date: str(e.date, 40), title: str(e.title), text: str(e.text) }))
        .filter((e) => e.title || e.text);
      out = events.length ? { component: 'timeline', title, events } : null;
      break;
    }
    case 'checklist': {
      const items = list(data.items).map((it) => (typeof it === 'string' ? { text: str(it), done: false } : isObj(it) ? { text: str(it.text), done: it.done === true } : null))
        .filter((it) => it && it.text);
      out = items.length ? { component: 'checklist', title, items } : null;
      break;
    }
    case 'accordion': {
      const items = list(data.items).filter(isObj).map((it) => ({ heading: str(it.heading), text: str(it.text, LONG_TEXT) }))
        .filter((it) => it.heading || it.text);
      out = items.length ? { component: 'accordion', title, items } : null;
      break;
    }
    case 'code': {
      const code = typeof data.code === 'string' ? data.code.slice(0, CODE_TEXT) : '';
      out = code ? { component: 'code', title, language: str(data.language, 30), code } : null;
      break;
    }
    case 'weather': {
      const c = isObj(data.current) ? data.current : {};
      out = {
        component: 'weather',
        title,
        place: str(data.place, 120),
        current: {
          temp_c: num(c.temp_c), feels_c: num(c.feels_c), condition: str(c.condition, 80),
          wind_kmh: num(c.wind_kmh), humidity: num(c.humidity),
        },
        days: list(data.days, 10).filter(isObj).map((d) => ({ day: str(d.day, 20), condition: str(d.condition, 80), high_c: num(d.high_c), low_c: num(d.low_c) })),
      };
      break;
    }
    default:
      out = null;
  }
  return out ? [out] : [];
}

/** Normalise all components of one answer, capped at MAX_COMPONENTS cards. */
export function normalizeComponents(specs) {
  const out = [];
  for (const spec of Array.isArray(specs) ? specs : []) {
    out.push(...normalizeComponent(spec));
    if (out.length >= MAX_COMPONENTS) break;
  }
  return out.slice(0, MAX_COMPONENTS);
}

const FOLLOWUP = /<followup>([\s\S]*?)<\/followup>/gi;

/**
 * Pull the `<followup>…</followup>` suggestions the engine appends to an answer out of the text.
 * @returns {{ text: string, followups: string[] }}
 */
export function splitFollowups(text) {
  const followups = [];
  const rest = String(text ?? '').replace(FOLLOWUP, (_m, q) => {
    const s = q.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (s && followups.length < 4 && !followups.includes(s)) followups.push(s);
    return '';
  });
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), followups };
}
