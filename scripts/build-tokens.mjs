#!/usr/bin/env node
// Build the Bucks design tokens: design/tokens/*.json → design/dist/* and the main process's copy.
// Fails (exit 1) on an unknown reference, a theme without a value, or a contrast rule that does
// not hold. --check writes nothing and fails when a generated file is out of date (CI).
//
//   node scripts/build-tokens.mjs           # write the outputs
//   node scripts/build-tokens.mjs --check   # verify they are current
//   node scripts/build-tokens.mjs --report  # also print every contrast ratio

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTokenFiles, buildModel, renderAll } from '../design/build/tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

const { model, errors } = buildModel(loadTokenFiles(path.join(root, 'design', 'tokens')));
if (errors.length) {
  console.error(`Design tokens: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (args.has('--report')) {
  for (const r of model.contrast) console.log(`${r.theme.padEnd(6)} ${r.name.padEnd(22)} on ${r.on.padEnd(16)} ${r.ratio.toFixed(2)} (min ${r.min})`);
}

const outputs = renderAll(model);
const stale = [];
for (const [rel, content] of Object.entries(outputs)) {
  const file = path.join(root, rel);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current === content) continue;
  if (args.has('--check')) { stale.push(rel); continue; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log(`wrote ${rel}`);
}
if (stale.length) {
  console.error(`Generated token files are out of date: ${stale.join(', ')}. Run: node scripts/build-tokens.mjs`);
  process.exit(1);
}
const colors = model.colors.size;
console.log(`Design tokens OK: ${colors} colours × ${model.themes.length} themes, ${model.scales.size} scale tokens, ${model.contrast.length} contrast checks.`);
