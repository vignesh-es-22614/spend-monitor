#!/usr/bin/env node
'use strict';
/**
 * Local dry run — queries BigQuery, builds the digest, writes it to disk.
 * Sends nothing.
 *
 *   node scripts/dry_run.js            # writes preview.html + preview.txt
 *   node scripts/dry_run.js --verify   # also prints the reconciliation table
 *
 * Needs GCP_SERVICE_ACCOUNT_JSON (or local ADC) in the environment.
 */

const fs = require('fs');
const path = require('path');
const { run } = require('../functions/spend_pacing_cron/index.js');
const { pct, money } = require('../functions/spend_pacing_cron/lib/pacing');

// Percentages from the Q3 workbook, for the --verify check.
const SHEET_PCT = {
  ADMP: 76, ELA: 70, ADAP: 69, RMP: 71, SPMP: 66,
  ADSSP: 56, DSP: 55, MMP: 44, AD360: 61,
};

(async () => {
  try {
    const r = await run(null, { dryRun: true });
    const out = path.join(__dirname, '..');
    fs.writeFileSync(path.join(out, 'preview.html'), r.html);
    fs.writeFileSync(path.join(out, 'preview.txt'), r.text);

    console.log(`Subject : ${r.subject}`);
    console.log(`As of   : ${r.asOf}`);
    console.log(`Benchmark: ${(r.bench.fraction * 100).toFixed(1)}%  (${r.bench.elapsed}/${r.bench.total} days)`);
    console.log(`\nWrote preview.html and preview.txt\n`);
    console.log(r.text);

    if (process.argv.includes('--verify')) {
      const m = r.insights;
      const all = [...m.over, ...m.onTrack, ...m.under];
      console.log('\nReconciliation vs the Q3 workbook');
      console.log('prod      used%   sheet%    diff');
      console.log('-'.repeat(36));
      let worst = 0;
      for (const x of all.sort((a, b) => a.code.localeCompare(b.code))) {
        const s = SHEET_PCT[x.code];
        if (s === undefined) continue;
        const d = x.used - s;
        worst = Math.max(worst, Math.abs(d));
        console.log(`${x.code.padEnd(8)}${x.used.toFixed(1).padStart(6)}${String(s).padStart(9)}${(d >= 0 ? '+' : '') + d.toFixed(1).padStart(8)}`);
      }
      console.log('-'.repeat(36));
      console.log(`worst |diff| ${worst.toFixed(1)} pts`);
      if (worst > 5) {
        console.error('\nWARNING: drift above 5 pts — check the classifier in lib/config.js');
        process.exitCode = 1;
      }
    }
  } catch (e) {
    console.error('Dry run failed:', e);
    process.exit(1);
  }
})();
