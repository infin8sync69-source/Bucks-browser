#!/usr/bin/env node
// Design-system lint: every colour, type size, radius, shadow, blur, layer and duration in the UI,
// the shared components and the pages the main process renders must come from the Bucks tokens.
// Exit 1 when anything bypasses them. See docs/DESIGN-SYSTEM.md.
//
//   node scripts/lint-tokens.mjs            # report and fail
//   node scripts/lint-tokens.mjs --summary  # counts per file and rule

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintText, kindOf } from '../design/build/lint.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['ui/src', 'design/components', 'design/runtime', 'design/gallery', 'chrome/src', 'src/main', 'src/preload'];

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

const all = [];
let files = 0;
for (const r of ROOTS) {
  for (const file of walk(path.join(root, r))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const kind = kindOf(rel);
    if (!kind) continue;
    files += 1;
    for (const f of lintText(fs.readFileSync(file, 'utf8'), { kind })) all.push({ file: rel, ...f });
  }
}

if (process.argv.includes('--summary')) {
  const byFile = new Map();
  for (const f of all) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
  for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${file}`);
  const byRule = new Map();
  for (const f of all) byRule.set(f.rule, (byRule.get(f.rule) || 0) + 1);
  console.log([...byRule].map(([r, n]) => `${r}: ${n}`).join(', '));
} else {
  for (const f of all) console.log(`${f.file}:${f.line}:${f.column}  ${f.rule}  ${f.message}`);
}
if (all.length) {
  console.error(`\nDesign tokens lint: ${all.length} problem(s) in ${new Set(all.map((f) => f.file)).size} of ${files} files.`);
  process.exit(1);
}
console.log(`Design tokens lint: ${files} files, no problems.`);
