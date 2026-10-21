#!/usr/bin/env node
// Rewrite Tailwind palette classes and one-off values in the given files to Bucks design tokens
// (design/build/migrate.mjs). Dry run by default: prints what would change.
//
//   node scripts/migrate-tokens.mjs [--write] [--skeleton] [--js-durations] <file>...

import fs from 'node:fs';
import { migrateText } from '../design/build/migrate.mjs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const opts = { skeleton: args.includes('--skeleton'), jsDurations: args.includes('--js-durations') };
let total = 0;
for (const file of args.filter((a) => !a.startsWith('--'))) {
  const before = fs.readFileSync(file, 'utf8');
  let { text, changes, usedMotion } = migrateText(before, opts);
  // Svelte components that now use motion tokens import them ($design is an alias of design/ in svelte.config.js).
  if (usedMotion && file.endsWith('.svelte') && !text.includes("from '$design/dist/tokens.js'")) {
    text = text.replace(/^(<script[^>]*>\n)([ \t]*)/m, (all, open, indent) => `${open}${indent || '    '}import { duration as motion } from '$design/dist/tokens.js';\n${indent}`);
  }
  total += changes.length;
  if (!changes.length) continue;
  console.log(`${file}: ${changes.length} change(s)${usedMotion ? ' (uses motion tokens: import { duration as motion })' : ''}`);
  if (!write) for (const c of changes) console.log(`  ${c.line}: ${c.from} → ${c.to}`);
  else fs.writeFileSync(file, text);
}
console.log(`${total} change(s)${write ? ' written' : ' (dry run; --write to apply)'}`);
