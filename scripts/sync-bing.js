#!/usr/bin/env node
'use strict';
/**
 * One command to close a Bing gap: fetch from the Ads API, classify, rebuild.
 *
 *   node scripts/sync-bing.js            14 trailing days
 *   node scripts/sync-bing.js --days 30
 *   node scripts/sync-bing.js --no-build just refresh data/bing-backfill.json
 *
 * Runs scripts/bing-fetch.py with the local Bing Ads Agent's venv python, so
 * its credentials stay in that folder and never enter this repo. Then hands
 * the raw JSON to bing-backfill.js and rebuilds docs/index.html.
 *
 * Commit data/bing-backfill.json afterwards and the daily workflow picks it up
 * — the merge takes whichever source has more spend per day, so this can never
 * hold back BigQuery once the transfer catches up.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENT = process.env.BING_AGENT_DIR
  || path.join(os.homedir(), 'Desktop', 'Bing Ads Agent');
const PY = path.join(AGENT, 'venv', 'Scripts', 'python.exe');
const PY_NIX = path.join(AGENT, 'venv', 'bin', 'python');

function python() {
  if (fs.existsSync(PY)) return PY;
  if (fs.existsSync(PY_NIX)) return PY_NIX;
  throw new Error(
    `No venv python under ${AGENT}.\n`
    + 'Set BING_AGENT_DIR to the Bing Ads Agent folder.',
  );
}

const args = process.argv.slice(2);
const daysIx = args.indexOf('--days');
const days = daysIx >= 0 ? args[daysIx + 1] : '14';
const build = !args.includes('--no-build');

const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'bing-sync-'));

try {
  const py = python();
  console.log(`Using ${py}`);
  execFileSync(py, [path.join(__dirname, 'bing-fetch.py'), '--days', String(days),
    '--out', raw, '--agent-dir', AGENT], { stdio: 'inherit', cwd: AGENT });

  const files = fs.readdirSync(raw).filter((f) => f.endsWith('.json'))
    .map((f) => path.join(raw, f));
  if (!files.length) throw new Error('bing-fetch.py wrote no files');

  execFileSync(process.execPath, [path.join(__dirname, 'bing-backfill.js'), ...files],
    { stdio: 'inherit', cwd: ROOT });

  if (build) {
    execFileSync(process.execPath, [path.join(__dirname, 'build-site.js')],
      { stdio: 'inherit', cwd: ROOT });
  }
  console.log('\nDone. Commit data/bing-backfill.json and docs/ to publish.');
} finally {
  fs.rmSync(raw, { recursive: true, force: true });
}
