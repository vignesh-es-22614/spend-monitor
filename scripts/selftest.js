#!/usr/bin/env node
'use strict';
/**
 * Offline self-test — no BigQuery needed.
 * Exercises the trailing-window projection and checks the reconciled figures.
 */

const {
  benchmark, recentRate, aggregate, metricsFor, buildInsights, rollup, pct, money,
} = require('../functions/spend_pacing_cron/lib/pacing');
const { FX_INR_PER_USD } = require('../functions/spend_pacing_cron/lib/config');

const AS_OF = '2026-08-23';
const Q_START = '2026-07-01';

// Q3-to-date US spend in INR (google, bing), as reconciled.
const QTD = {
  ADMP:  [45688943, 5285686], ADAP: [34988108, 6559461],
  ELA:   [16467963, 4755191], ADSSP:[13733227, 3400014],
  DSP:   [2575756, 545590],   SPMP: [1167276, 722345],
  RMP:   [1004460, 698107],   MMP:  [958591, 188141],
  AD360: [405389, 210627],
};
const EXPECT_USED = {
  ADMP: 76, ELA: 70, ADAP: 69, RMP: 71, SPMP: 66,
  ADSSP: 56, DSP: 55, MMP: 44, AD360: 61,
};

// Spread each product's QTD spend evenly across the 54 elapsed days so the
// trailing-window rate is well defined and equals the quarter average.
const DAY = 86400000;
const days = [];
for (let t = Date.parse(`${Q_START}T00:00:00Z`); t <= Date.parse(`${AS_OF}T00:00:00Z`); t += DAY) {
  days.push(new Date(t).toISOString().slice(0, 10));
}
const rows = [];
for (const [product, [g, b]] of Object.entries(QTD)) {
  for (const date of days) {
    rows.push({ date, product, engine: 'google', isUs: true, costInr: g / days.length });
    rows.push({ date, product, engine: 'bing',   isUs: true, costInr: b / days.length });
  }
  // non-US rows that must be ignored entirely
  rows.push({ date: AS_OF, product, engine: 'google', isUs: false, costInr: 9e9 });
}

const bench = benchmark(AS_OF);
const rate = recentRate(rows, AS_OF, { usOnly: true });
const metrics = metricsFor(aggregate(rows, { usOnly: true }), bench, rate);
const insights = buildInsights(metrics, bench);

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails++;
};

check('quarter is 92 days', bench.total === 92, `${bench.total}`);
check('54 elapsed, 38 remaining', bench.elapsed === 54 && bench.remaining === 38,
  `${bench.elapsed} elapsed / ${bench.remaining} remaining`);
check('trailing window is 21 days', rate._days === 21, `${rate._days} days`);
check('FX is 95.6', FX_INR_PER_USD === 95.6, String(FX_INR_PER_USD));

console.log('\nprod      used%  expect   diff   proj%');
console.log('-'.repeat(42));
let worst = 0;
for (const [code, exp] of Object.entries(EXPECT_USED)) {
  const m = metrics[code];
  const d = m.used - exp;
  worst = Math.max(worst, Math.abs(d));
  console.log(
    `${code.padEnd(8)}${m.used.toFixed(1).padStart(6)}${String(exp).padStart(8)}` +
    `${((d >= 0 ? '+' : '') + d.toFixed(1)).padStart(7)}${m.projected.toFixed(0).padStart(8)}`
  );
}
console.log('-'.repeat(42));
// RMP sits ~3.2 pts out: `RMP Search US Imp - Exact` ($811) is live US spend in
// Bing but missing from the export. See RECONCILIATION.md.
check('every product within 4 pts of the workbook', worst <= 4, `worst ${worst.toFixed(1)} pts`);

const total = rollup(Object.keys(QTD), metrics, bench);
check('total used ~69%', Math.abs(total.used - 69) <= 1.5, pct(total.used, 1));

// With spend spread evenly, the trailing rate equals the quarter average, so
// projection must land on budget-independent spend * (92/54).
const expectedProj = total.spend.total * (92 / 54);
check('even spend projects to quarter-average run-rate',
  Math.abs(total.projectedSpend - expectedProj) / expectedProj < 0.005,
  `${money(total.projectedSpend)} vs ${money(expectedProj)}`);

const impossible = Object.values(metrics)
  .filter((m) => m.projectedSpend !== null && m.projectedSpend < m.spend.total - 0.5);
check('projection never below actual spend', impossible.length === 0,
  impossible.map((m) => m.code).join(',') || 'none');

check('non-US spend excluded', total.spend.total < 2e6,
  `$${Math.round(total.spend.total).toLocaleString()}`);

check('insights bucket every budgeted product',
  insights.over.length + insights.onTrack.length + insights.under.length + insights.flagged.length === 9,
  `${insights.over.length} over / ${insights.onTrack.length} on track / ${insights.under.length} under`);

console.log('\n' + insights.lines.overspending.map((l) => '  * ' + l).join('\n'));
console.log('\n' + (fails ? `${fails} check(s) FAILED` : 'All checks passed'));
process.exit(fails ? 1 : 0);
