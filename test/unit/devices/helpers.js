// Shared helpers for the devices tests (not a test file itself: npm test only runs *.test.js).

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Same semantics as src/main/settings.js deepMerge: objects merge, arrays are replaced wholesale. */
export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(base?.[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** In-memory settings store with the get/set/onChange surface of src/main/settings.js. */
export function makeSettings(initial = {}) {
  let current = deepMerge({
    ipfs: { mode: 'embedded', externalApiUrl: '', publicGateway: 'https://ipfs.io', preferredGateway: 'local', autoStart: true, peers: [] },
    devices: { name: '', autoPin: false },
  }, initial);
  const listeners = new Set();
  const sets = [];
  return {
    sets,
    get: () => structuredClone(current),
    set(patch) {
      sets.push(structuredClone(patch));
      current = deepMerge(current, patch);
      const snap = structuredClone(current);
      for (const cb of listeners) cb(snap);
      return snap;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    listenerCount: () => listeners.size,
  };
}

/** Let pending promise chains and I/O callbacks run. */
export async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
}

/**
 * Manually driven clock + timers: `now()` only moves with advance(), timers fire in due order.
 * Implements the `timers` dependency of createDevicesService.
 */
export function makeClock(start = 1_792_300_000_000) {
  let t = start;
  let seq = 0;
  const pending = new Map(); // id → { due, fn, every }
  const clock = {
    now: () => t,
    pendingCount: () => pending.size,
    pendingDelays: () => [...pending.values()].map((p) => p.due - t).sort((a, b) => a - b),
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { due: t + Math.max(0, ms), fn, every: 0 }); return id; },
      clearTimeout: (id) => { pending.delete(id); },
      setInterval: (fn, ms) => { const id = ++seq; pending.set(id, { due: t + ms, fn, every: ms }); return id; },
      clearInterval: (id) => { pending.delete(id); },
    },
    /** Advance time by `ms`, firing due timers in order and letting async work settle after each. */
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const [id, p] of pending) if (p.due <= target && (!next || p.due < next[1].due)) next = [id, p];
        if (!next) break;
        const [id, p] = next;
        t = p.due;
        if (p.every) p.due += p.every; else pending.delete(id);
        p.fn();
        await settle();
      }
      t = target;
      await settle();
    },
  };
  return clock;
}

/** A log that records lines (for assertions) without printing. */
export function makeLog() {
  const lines = [];
  const rec = (level) => (...a) => lines.push([level, a.map(String).join(' ')]);
  return { lines, info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
}
