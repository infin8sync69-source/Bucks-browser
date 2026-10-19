/**
 * The new-tab page's widget board: which widgets are on it, in which order, and their own data
 * (world-clock zones, weather city, today's agenda, notes). Pure functions over a plain object so
 * they can be unit tested; widgetsStore.ts persists the board in localStorage.
 *
 * Every widget shows real data. Bucks Core's markets, calendar, music and space widgets showed fixed
 * samples; they became Today (your own agenda), Now playing (tabs playing audio) and Spaces (your
 * Spaces), and markets was dropped for lack of a data source.
 */

export type WidgetType = 'clock' | 'weather' | 'today' | 'notes' | 'now-playing' | 'spaces';

export interface AgendaItem {
    id: string;
    /** 'HH:MM' or '' (no time). */
    time: string;
    text: string;
    done: boolean;
}

export interface WidgetConfig {
    /** clock: IANA time zones shown besides the local time. */
    zones?: string[];
    /** weather: the city to show. */
    city?: string;
    /** today: the agenda and the day (YYYY-MM-DD) it belongs to; a new day starts empty. */
    day?: string;
    items?: AgendaItem[];
    /** notes */
    text?: string;
}

export interface Widget {
    uid: string;
    type: WidgetType;
    config: WidgetConfig;
}

export interface Board {
    widgets: Widget[];
}

export interface WidgetInfo {
    type: WidgetType;
    name: string;
    description: string;
    /** lucide icon name (see AppIcon). */
    icon: string;
}

export const WIDGET_LIBRARY: WidgetInfo[] = [
    { type: 'clock', name: 'World clock', description: 'Local time and the time in other cities', icon: 'Clock' },
    { type: 'weather', name: 'Weather', description: 'Conditions and 3-day forecast for a city (Open-Meteo)', icon: 'CloudSun' },
    { type: 'today', name: 'Today', description: 'Your agenda for the day, kept on this computer', icon: 'CalendarDays' },
    { type: 'notes', name: 'Notes', description: 'A scratchpad that saves as you type', icon: 'StickyNote' },
    { type: 'now-playing', name: 'Now playing', description: 'Tabs playing sound, with mute and switch', icon: 'Music' },
    { type: 'spaces', name: 'Spaces', description: 'Your Spaces and how many tabs each holds', icon: 'Layers' },
];

export const WIDGET_TYPES = WIDGET_LIBRARY.map((w) => w.type);
export const MAX_WIDGETS = 12;
export const MAX_NOTES = 5000;
export const MAX_AGENDA = 30;
export const MAX_ZONES = 4;

export const DEFAULT_BOARD: Board = {
    widgets: [
        { uid: 'w-today', type: 'today', config: { items: [] } },
        { uid: 'w-notes', type: 'notes', config: { text: '' } },
    ],
};

let uidCounter = 0;
export function newUid(prefix = 'w'): string {
    uidCounter += 1;
    return `${prefix}-${Date.now().toString(36)}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Local date as YYYY-MM-DD. */
export function dayKey(d: Date = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** True when `tz` is an IANA zone this runtime knows. */
export function validTimeZone(tz: unknown): tz is string {
    if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanItems(v: unknown): AgendaItem[] {
    if (!Array.isArray(v)) return [];
    return v
        .filter(isObj)
        .map((i) => ({
            id: typeof i.id === 'string' && i.id ? i.id.slice(0, 64) : newUid('a'),
            time: typeof i.time === 'string' && TIME_RE.test(i.time) ? i.time : '',
            text: typeof i.text === 'string' ? i.text.trim().slice(0, 200) : '',
            done: i.done === true,
        }))
        .filter((i) => i.text)
        .slice(0, MAX_AGENDA);
}

function cleanConfig(type: WidgetType, c: unknown): WidgetConfig {
    const o = isObj(c) ? c : {};
    switch (type) {
        case 'clock':
            return { zones: (Array.isArray(o.zones) ? o.zones : []).filter(validTimeZone).slice(0, MAX_ZONES) };
        case 'weather':
            return { city: typeof o.city === 'string' ? o.city.trim().slice(0, 80) : '' };
        case 'today':
            return { day: typeof o.day === 'string' ? o.day : dayKey(), items: cleanItems(o.items) };
        case 'notes':
            return { text: typeof o.text === 'string' ? o.text.slice(0, MAX_NOTES) : '' };
        default:
            return {};
    }
}

/** A board from untrusted storage: unknown widget types and bad fields are dropped, ids made unique. */
export function sanitizeBoard(raw: unknown): Board {
    if (!isObj(raw) || !Array.isArray(raw.widgets)) return structuredClone(DEFAULT_BOARD);
    const seen = new Set<string>();
    const widgets: Widget[] = [];
    for (const w of raw.widgets) {
        if (!isObj(w) || !WIDGET_TYPES.includes(w.type as WidgetType)) continue;
        const type = w.type as WidgetType;
        let uid = typeof w.uid === 'string' && w.uid ? w.uid.slice(0, 64) : newUid();
        if (seen.has(uid)) uid = newUid();
        seen.add(uid);
        widgets.push({ uid, type, config: cleanConfig(type, w.config) });
        if (widgets.length >= MAX_WIDGETS) break;
    }
    return { widgets };
}

export function addWidget(board: Board, type: WidgetType): Board {
    if (!WIDGET_TYPES.includes(type) || board.widgets.length >= MAX_WIDGETS) return board;
    return { widgets: [...board.widgets, { uid: newUid(), type, config: cleanConfig(type, {}) }] };
}

export function removeWidget(board: Board, uid: string): Board {
    return { widgets: board.widgets.filter((w) => w.uid !== uid) };
}

/** Move a widget to position `to` (clamped). */
export function moveWidget(board: Board, uid: string, to: number): Board {
    const from = board.widgets.findIndex((w) => w.uid === uid);
    if (from < 0) return board;
    const widgets = [...board.widgets];
    const [w] = widgets.splice(from, 1);
    widgets.splice(Math.max(0, Math.min(to, widgets.length)), 0, w);
    return { widgets };
}

export function updateConfig(board: Board, uid: string, patch: WidgetConfig): Board {
    return {
        widgets: board.widgets.map((w) => (w.uid === uid ? { ...w, config: cleanConfig(w.type, { ...w.config, ...patch }) } : w)),
    };
}

/* ── today ─────────────────────────────────────────────────────────────── */

/** Items with a time first, in time order; untimed ones after, in the order they were added. */
export function sortAgenda(items: AgendaItem[]): AgendaItem[] {
    const timed = items.filter((i) => i.time).sort((a, b) => a.time.localeCompare(b.time));
    return [...timed, ...items.filter((i) => !i.time)];
}

/** The agenda shown for `today`: yesterday's list does not carry over. */
export function agendaFor(config: WidgetConfig, today: string = dayKey()): AgendaItem[] {
    return config.day === today ? sortAgenda(config.items ?? []) : [];
}

/** Config patch that adds an item to today's agenda (starting a fresh list on a new day). */
export function withAgendaItem(config: WidgetConfig, item: AgendaItem, today: string = dayKey()): WidgetConfig {
    return { day: today, items: [...agendaFor(config, today), item].slice(-MAX_AGENDA) };
}

export function withAgendaToggled(config: WidgetConfig, id: string, today: string = dayKey()): WidgetConfig {
    return { day: today, items: agendaFor(config, today).map((i) => (i.id === id ? { ...i, done: !i.done } : i)) };
}

export function withoutAgendaItem(config: WidgetConfig, id: string, today: string = dayKey()): WidgetConfig {
    return { day: today, items: agendaFor(config, today).filter((i) => i.id !== id) };
}

/** Parse "9:30 Standup" / "14:00 Call" / "Buy milk" into an item (null for empty text). */
export function parseAgendaEntry(input: string): AgendaItem | null {
    const s = input.trim();
    const m = /^(\d{1,2})[:.h](\d{2})\s+(.+)$/.exec(s);
    if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
        return { id: newUid('a'), time: `${m[1].padStart(2, '0')}:${m[2]}`, text: m[3].trim().slice(0, 200), done: false };
    }
    return s ? { id: newUid('a'), time: '', text: s.slice(0, 200), done: false } : null;
}

/* ── clock ─────────────────────────────────────────────────────────────── */

export function greeting(hour: number): string {
    if (hour < 5) return 'Good night';
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
}

/** "Europe/Lisbon" → "Lisbon", "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function zoneCity(tz: string): string {
    return (tz.split('/').pop() || tz).replace(/_/g, ' ');
}

/** Time in a zone, e.g. "14:05", plus the day offset from local time (-1, 0, +1). */
export function timeIn(tz: string, now: Date = new Date()): { time: string; dayOffset: number } {
    const fmt = (opts: Intl.DateTimeFormatOptions, zone?: string) =>
        new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: zone }).format(now);
    const time = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, tz);
    const there = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, tz);
    const here = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
    const dayOffset = Math.round((Date.parse(there) - Date.parse(here)) / 86_400_000);
    return { time, dayOffset };
}

/** IANA zones for the zone picker (all of them where the runtime can list them). */
export function knownTimeZones(): string[] {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    try {
        const all = intl.supportedValuesOf?.('timeZone');
        if (all?.length) return all;
    } catch {
        /* older runtime */
    }
    return ['UTC', 'Europe/London', 'Europe/Lisbon', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Kolkata', 'Australia/Sydney'];
}
