// A small JSON collection on disk, shared by the stores of hosted sites and installed apps:
// written atomically (temp file + rename, one write at a time), schema-versioned (a file from a
// newer Bucks is read but never overwritten), re-read when another process changed it, and every
// record validated on the way in and out. No Electron imports.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * @template T
 * @param {{
 *   file: string, key: string, version: number, max: number, what: string,
 *   sanitize: (raw: any) => (T & { id: string }) | null,
 *   migrate?: (raw: any) => { version: number, [k: string]: any },
 *   log?: { warn: Function, error: Function },
 * }} opts  key: the array's property in the file; what: "sites", "apps" (for messages)
 */
export function createRecordStore({ file, key, version, max, what, sanitize, migrate, log = { warn() {}, error() {} } }) {
  const upgrade = migrate || ((raw) => (raw && typeof raw === 'object' && Array.isArray(raw[key]) ? { ...raw, version: Number(raw.version) || version } : { version, [key]: [] }));
  let readOnly = false;
  let stamp = null;
  let records = load();

  function stampOf() {
    try {
      const st = fs.statSync(file);
      return `${st.ino}:${st.mtimeMs}:${st.size}`; // every atomic write is a new inode
    } catch {
      return null;
    }
  }

  function refresh() {
    if (stampOf() !== stamp) records = load();
  }

  function load() {
    stamp = stampOf();
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        log.warn(`${file} is unreadable (${e.message}); keeping it as ${path.basename(file)}.corrupt and starting empty`);
        try { fs.renameSync(file, `${file}.corrupt`); } catch { /* best effort */ }
      }
      return [];
    }
    const data = upgrade(raw);
    if (data.version > version) {
      readOnly = true;
      log.warn(`${file} was written by a newer Bucks (schema ${data.version}); it will not be changed`);
    }
    const seen = new Set();
    const out = [];
    for (const r of (Array.isArray(data[key]) ? data[key] : []).slice(0, max)) {
      const clean = sanitize(r);
      if (clean && !seen.has(clean.id)) { seen.add(clean.id); out.push(clean); }
    }
    return out;
  }

  let writing = Promise.resolve();
  function persist() {
    if (readOnly) return Promise.reject(new Error(`The ${what} list was written by a newer version of Bucks and cannot be changed here.`));
    const data = JSON.stringify({ version, [key]: records }, null, 2);
    writing = writing.catch(() => {}).then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, data, { mode: 0o600 });
      await fsp.rename(tmp, file);
      stamp = stampOf();
    });
    return writing;
  }

  return {
    file,
    get readOnly() { return readOnly; },
    /** @returns {T[]} */
    list: () => {
      refresh();
      return records.map((r) => structuredClone(r));
    },
    /** @returns {T|null} */
    get: (id) => {
      refresh();
      const r = records.find((x) => x.id === id);
      return r ? structuredClone(r) : null;
    },
    /** Insert or replace a record (validated); resolves once it is on disk. */
    async put(record) {
      const clean = sanitize(record);
      if (!clean) throw new Error(`Invalid ${what.replace(/s$/, '')} record`);
      refresh();
      const i = records.findIndex((x) => x.id === clean.id);
      if (i === -1) {
        if (records.length >= max) throw new Error(`At most ${max} ${what} are allowed`);
        records = [...records, clean];
      } else {
        records = records.map((x, j) => (j === i ? clean : x));
      }
      await persist();
      return structuredClone(clean);
    },
    async remove(id) {
      refresh();
      const before = records.length;
      records = records.filter((x) => x.id !== id);
      if (records.length !== before) await persist();
      return records.length !== before;
    },
  };
}
