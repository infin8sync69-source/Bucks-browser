// Syntax-check every main-process module without launching Electron.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(c?m?js)$/.test(name)) out.push(p);
  }
  return out;
}

const files = [...walk('src'), ...walk('scripts')];
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${f}\n${r.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} main-process files parse OK`);
process.exit(failed ? 1 : 0);
