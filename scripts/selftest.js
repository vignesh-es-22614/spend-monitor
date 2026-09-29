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

/**
 * The workbook's used% was computed against ONE quarterly plan. Budgets are
 * now stored per month and September was re-cut, so live used% no longer
 * matches those figures — correctly so.
 *
 * That plan is kept here as a fixture, because what it actually anchors is the
 * SPEND: classification, the US rule and FX. Dividing our spend by the basis
 * the workbook used keeps that anchored to an external source instead of
 * asserting whatever the code currently computes.
 */
const WORKBOOK_Q3_BUDGET = {
  ADMP: 708000, SPMP: 30000, MMP: 27000, RMP: 24000, AD360: 10500,
  ADSSP: 315000, ADAP: 630000, DSP: 60000, ELA: 315000,
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

console.log('\nprod    spend$   wbk%  expect   diff   live%   proj%');
console.log('-'.repeat(56));
let worst = 0;
for (const [code, exp] of Object.entries(EXPECT_USED)) {
  const m = metrics[code];
  // Used% on the workbook's own budget basis — this is the spend check.
  const wbk = (m.spend.total / WORKBOOK_Q3_BUDGET[code]) * 100;
  const d = wbk - exp;
  worst = Math.max(worst, Math.abs(d));
  console.log(
    `${code.padEnd(7)}${Math.round(m.spend.total).toLocaleString('en-US').padStart(8)}`
    + `${wbk.toFixed(1).padStart(7)}${String(exp).padStart(8)}`
    + `${((d >= 0 ? '+' : '') + d.toFixed(1)).padStart(7)}`
    + `${m.used.toFixed(1).padStart(8)}${m.projected.toFixed(0).padStart(8)}`
  );
}
console.log('-'.repeat(56));
// RMP sits ~3.2 pts out: `RMP Search US Imp - Exact` ($811) is live US spend in
// Bing but missing from the export. See RECONCILIATION.md.
check('spend reconciles to the workbook within 4 pts', worst <= 4,
  `worst ${worst.toFixed(1)} pts`);

const total = rollup(Object.keys(QTD), metrics, bench);
const wbkTotal = Object.keys(QTD)
  .reduce((a, c) => a + metrics[c].spend.total, 0)
  / Object.values(WORKBOOK_Q3_BUDGET).reduce((a, b) => a + b, 0) * 100;
check('total spend is ~69% of the workbook plan', Math.abs(wbkTotal - 69) <= 1.5,
  pct(wbkTotal, 1));

/* ---- monthly budgets --------------------------------------------------
   Budgets are now per month, so assert the new data against its own source:
   the Projected Spend sheet's September US Total row. */
const cfg = require('../functions/spend_pacing_cron/lib/config');
const septTotals = cfg.PRODUCTS.reduce((a, p) => {
  const b = cfg.budgetForMonth(p.code, '2026-09');
  return { google: a.google + b.google, bing: a.bing + b.bing };
}, { google: 0, bing: 0 });
check('Sept Google budget is 661,013', septTotals.google === 661013,
  septTotals.google.toLocaleString('en-US'));
check('Sept Bing budget is 117,487', septTotals.bing === 117487,
  septTotals.bing.toLocaleString('en-US'));

// July + Aug + Sept must equal the derived quarter total, or a period's budget
// would not add up to the quarter it sits in.
const monthSum = ['2026-07', '2026-08', '2026-09'].reduce((a, ym) => a
  + cfg.PRODUCTS.reduce((s, p) => {
    const b = cfg.budgetForMonth(p.code, ym);
    return s + b.google + b.bing;
  }, 0), 0);
const qSum = Object.values(cfg.BUDGETS_USD).reduce((a, b) => a + b.google + b.bing, 0);
check('months sum to the quarter total', Math.abs(monthSum - qSum) < 1,
  `${Math.round(monthSum).toLocaleString('en-US')} vs ${Math.round(qSum).toLocaleString('en-US')}`);

// A week spanning August and September must draw from both plans, or the
// day-weighting is not actually happening.
const straddle = cfg.budgetForRange('ADAP', '2026-08-29', '2026-09-04');
const augDaily = cfg.budgetForMonth('ADAP', '2026-08').google / 31;
const sepDaily = cfg.budgetForMonth('ADAP', '2026-09').google / 30;
const expectStraddle = augDaily * 3 + sepDaily * 4;
check('a week across two months blends both plans',
  Math.abs(straddle.google - expectStraddle) < 0.01,
  `${straddle.google.toFixed(0)} vs ${expectStraddle.toFixed(0)}`);

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
