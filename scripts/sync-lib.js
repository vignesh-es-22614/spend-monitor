#!/usr/bin/env node
'use strict';
/**
 * Copies functions/spend_pacing_cron/lib -> functions/spend_data/lib.
 *
 * Catalyst bundles each function separately, so a function can only require
 * files inside its own directory. spend_pacing_cron/lib is the source of
 * truth; this mirrors it so both functions share identical logic.
 *
 *   node scripts/sync-lib.js          copy
 *   node scripts/sync-lib.js --check  fail if they differ (used in CI)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'functions', 'spend_pacing_cron', 'lib');
const DST = path.join(ROOT, 'functions', 'spend_data', 'lib');
const checkOnly = process.argv.includes('--check');

const hash = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 8);

if (!fs.existsSync(SRC)) {
  console.error(`Source not found: ${SRC}`);
  process.exit(1);
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
let differ = 0;

if (checkOnly) {
  for (const f of files) {
    const s = path.join(SRC, f);
    const d = path.join(DST, f);
    if (!fs.existsSync(d)) { console.error(`MISSING  ${f}`); differ++; continue; }
    if (hash(s) !== hash(d)) { console.error(`DIFFERS  ${f}`); differ++; }
  }
  // Anything in the copy that no longer exists in the source is stale.
  if (fs.existsSync(DST)) {
    for (const f of fs.readdirSync(DST).filter((x) => x.endsWith('.js'))) {
      if (!files.includes(f)) { console.error(`STALE    ${f}`); differ++; }
    }
  }
  if (differ) {
    console.error(`\n${differ} file(s) out of sync. Run: node scripts/sync-lib.js`);
    process.exit(1);
  }
  console.log(`lib/ in sync (${files.length} files)`);
  process.exit(0);
}

fs.mkdirSync(DST, { recursive: true });
// Drop anything the source no longer has, so deletions propagate.
for (const f of fs.readdirSync(DST).filter((x) => x.endsWith('.js'))) {
  if (!files.includes(f)) { fs.unlinkSync(path.join(DST, f)); console.log(`removed ${f}`); }
}
for (const f of files) {
  fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
  console.log(`copied  ${f}`);
}
console.log(`\nSynced ${files.length} files to functions/spend_data/lib`);
