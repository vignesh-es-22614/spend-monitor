#!/usr/bin/env node
'use strict';
/**
 * Turns raw Bing Ads campaign exports into data/bing-backfill.json, which
 * build-site.js splices in for any date it covers.
 *
 *   node scripts/bing-backfill.js <export.json> [more.json ...]
 *
 * Why this exists: the Microsoft Ads BigQuery transfer stopped after
 * 2026-08-27 (and wrote that day only partially). The Ads account still has
 * the data, so we lift it straight from the API export rather than let the
 * dashboard sit frozen. Validated against BigQuery on the overlapping days --
 * 23-26 Aug matched to the rupee.
 *
 * Input is whatever the Bing Ads reporting API returns for a Daily
 * per-campaign pull: an object with {account_id, campaigns:[{TimePeriod,
 * CampaignName, Spend, ...}]}, optionally wrapped as {result:"<json>"}.
 *
 * DELETE data/bing-backfill.json once the transfer is fixed and BigQuery has
 * backfilled itself. Leaving it costs nothing (the numbers agree) but it is
 * one more thing to keep in step.
 */

const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'functions', 'spend_pacing_cron', 'lib');
const { BING_ACCOUNTS, NON_US_PATTERN } = require(path.join(LIB, 'config'));

const OUT = path.join(__dirname, '..', 'data', 'bing-backfill.json');

// NON_US_PATTERN carries a leading (?i) for BigQuery's RE2; JS wants the flag.
const nonUs = new RegExp(NON_US_PATTERN.replace(/^\(\?i\)/, ''), 'i');

/** Mirrors bingProductCase() in lib/bigquery.js. Keep the two in step. */
function classify(accountId, name) {
  if (accountId === BING_ACCOUNTS.ADAP) return 'ADAP';
  if (accountId !== BING_ACCOUNTS.MAIN) return null;
  const rules = [
    [/^ADMP/i, 'ADMP'],
    [/^AD360/i, 'AD360'],
    [/^ADS(SP|elfservice|elf.?Service)/i, 'ADSSP'],
    [/^ELA/i, 'ELA'],
    [/^DSP/i, 'DSP'],
    [/^SPMP/i, 'SPMP'],
    [/^MMP/i, 'MMP'],
    [/^RMP/i, 'RMP'],
  ];
  for (const [re, code] of rules) if (re.test(name)) return code;
  return null;
}

function load(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // MCP tool results arrive as {result:"<json string>"}; a direct API dump does not.
  const j = typeof raw.result === 'string' ? JSON.parse(raw.result) : raw;
  if (!Array.isArray(j.campaigns)) {
    throw new Error(`${file}: expected a "campaigns" array`);
  }
  return { accountId: String(j.account_id), campaigns: j.campaigns };
}

function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node scripts/bing-backfill.js <export.json> [...]');
    process.exit(1);
  }

  const agg = new Map();          // date|product|isUs -> cost
  const dates = new Set();
  let seen = 0, unclassified = 0;
  const unknownNames = new Set();

  for (const f of files) {
    const { accountId, campaigns } = load(f);
    for (const c of campaigns) {
      seen++;
      const date = String(c.TimePeriod).slice(0, 10);
      if (!/^\d{4}-\d\d-\d\d$/.test(date)) {
        throw new Error(`${f}: unparseable TimePeriod ${c.TimePeriod}`);
      }
      const product = classify(accountId, c.CampaignName || '');
      if (!product) { unclassified++; unknownNames.add(c.CampaignName); continue; }
      const isUs = !nonUs.test(c.CampaignName || '');
      const key = `${date}|${product}|${isUs ? 1 : 0}`;
      agg.set(key, (agg.get(key) || 0) + (Number(c.Spend) || 0));
      dates.add(date);
    }
  }

  const rows = [...agg.entries()].map(([k, cost]) => {
    const [date, product, us] = k.split('|');
    return { date, product, isUs: us === '1', costInr: Math.round(cost * 100) / 100 };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.product.localeCompare(b.product));

  const total = rows.reduce((a, r) => a + r.costInr, 0);
  if (!rows.length) throw new Error('No classifiable rows — check the account ids');

  const payload = {
    _comment: 'Bing spend lifted from the Ads API while the BigQuery transfer '
      + 'is down. build-site.js uses these rows INSTEAD OF BigQuery for any '
      + 'date listed in coveredDates. Delete this file once the transfer is '
      + 'fixed and has backfilled.',
    generatedAt: new Date().toISOString(),
    coveredDates: [...dates].sort(),
    rows,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log(`read ${seen} campaign-days from ${files.length} file(s)`);
  console.log(`skipped ${unclassified} unclassified`
    + (unknownNames.size ? ` (${[...unknownNames].slice(0, 5).join(', ')}${unknownNames.size > 5 ? ', …' : ''})` : ''));
  console.log(`wrote ${rows.length} rows covering ${payload.coveredDates.length} days`);
  console.log(`  ${payload.coveredDates[0]} .. ${payload.coveredDates.at(-1)}`);
  console.log(`  total INR ${total.toFixed(0)}`);
}

main();
