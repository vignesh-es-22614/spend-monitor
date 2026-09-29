'use strict';
/**
 * Single source of truth for scope, classification and pacing constants.
 *
 * These values are not arbitrary — every one was reconciled against the
 * SIEM_Weekwise export (6 Jul – 23 Aug 2026) to within 0.1% in total.
 * Read RECONCILIATION.md before changing any of them.
 */

// INR -> USD. Solved from the export; lands on 95.6 for ADAP (both engines),
// ADMP Bing, DSP, MMP, RMP, AD360 and SPMP Bing.
const FX_INR_PER_USD = Number(process.env.FX_INR_PER_USD || 95.6);

// Quarter under management.
const QUARTER = {
  label: 'Q3 2026',
  start: '2026-07-01',
  end: '2026-09-30',
};

// Google Ads accounts under the MCC (5419501619).
const GOOGLE_ACCOUNTS = [
  1259940298, // ADAP
  6843070472, // ADMP + AD360
  8573832901, // ADSSP
  1913132799, // ELA + L3C + Log360
  6158218545, // DSP
  8094989745, // SPMP
  1343295076, // MMP
  1650818176, // RMP
];

// Bing accounts.
const BING_ACCOUNTS = {
  ADAP: '142004499',
  MAIN: '142002557',
};

/**
 * A campaign counts as US-targeted unless its name names another country.
 * This is the opposite of the intuitive rule and is what the export uses —
 * e.g. "MMP Search Branding - Bing" carries no geo token and IS counted as US.
 */
// (?i) is REQUIRED — campaign names mix casing ("AUS" vs "Aus", "IND" vs "Ind").
// Without it, non-US campaigns slip through and are counted as US, which
// inflates ELA/RMP/SPMP/ADMP by up to 10 points.
const NON_US_PATTERN =
  '(?i)(^|[^A-Za-z])(' +
  'UK|United Kingdom|Aus|Australia|CAN|Canada|Germany|France|Italy|Spain|NL|Netherlands|' +
  'Belgium|Brazil|India|IND|Japan|Singapore|Malaysia|Indonesia|Thailand|Turkey|Israel|' +
  'UAE|Saudi|Qatar|South Africa|Africa|LATAM|Mexico|Colombia|Europe|APAC|Asia|MEA|' +
  'Middle East|Nordics|Switzerland|Poland|Denmark|Ireland|New Zealand|NZ|Hong Kong|' +
  'Global|ROW|Dominican Republic|South America|Benelux|Nordic' +
  ')([^A-Za-z]|$)';

// Products, their BU and their reporting group.
const PRODUCTS = [
  { code: 'ADMP',  name: 'ADManager Plus',          bu: 'IDM',  grp: 'ADMP Group'  },
  { code: 'SPMP',  name: 'SharePoint Manager Plus', bu: 'IDM',  grp: 'ADMP Group'  },
  { code: 'MMP',   name: 'M365 Manager Plus',       bu: 'IDM',  grp: 'ADMP Group'  },
  { code: 'RMP',   name: 'Recovery Manager Plus',   bu: 'IDM',  grp: 'ADMP Group'  },
  { code: 'AD360', name: 'AD360',                   bu: 'IDM',  grp: 'ADMP Group'  },
  { code: 'ADSSP', name: 'ADSelfService Plus',      bu: 'IDM',  grp: 'ADSSP Group' },
  { code: 'ADAP',  name: 'ADAudit Plus',            bu: 'SIEM', grp: 'ADAP Group'  },
  { code: 'DSP',   name: 'DataSecurity Plus',       bu: 'SIEM', grp: 'ADAP Group'  },
  { code: 'ELA',   name: 'EventLog Analyzer',       bu: 'SIEM', grp: 'ELA Group'   },
];

/**
 * MONTHLY budgets in USD, split Google / Bing. Edit this each month — the
 * plan is re-cut monthly, so a single quarterly figure divided by three was
 * only ever right by accident.
 *
 * July and August are the old Q3 quarterly figures divided by three, which is
 * what the dashboard effectively used before. September is the re-cut plan
 * from the Projected-Spend sheet and is materially different: ADMP 270,000
 * against 236,000 on the old basis, ADAP 260,000 against 210,000.
 *
 * A month with no entry carries forward the most recent month that has one,
 * and the Budget panel marks it as carried forward. Zeros would be worse: the
 * whole dashboard would read "no budget set" the moment a month was missed.
 *
 * NOTE on MMP September: the sheet's Overall column says 8,000 but its own
 * Google + Bing split is 6,500 + 1,000 = 7,500. The split is used here,
 * because the engine filter has to reconcile. Worth correcting at source.
 */
const BUDGETS_BY_MONTH = {
  // Q3 quarterly plan / 3 — all nine divide cleanly.
  '2026-07': {
    ADMP:  { google: 213000, bing: 23000 },
    SPMP:  { google:   8000, bing:  2000 },
    MMP:   { google:   8000, bing:  1000 },
    RMP:   { google:   3000, bing:  5000 },
    AD360: { google:   2800, bing:   700 },
    ADSSP: { google:  85000, bing: 20000 },
    ADAP:  { google: 185000, bing: 25000 },
    DSP:   { google:  15000, bing:  5000 },
    ELA:   { google:  85000, bing: 20000 },
  },
  '2026-08': {
    ADMP:  { google: 213000, bing: 23000 },
    SPMP:  { google:   8000, bing:  2000 },
    MMP:   { google:   8000, bing:  1000 },
    RMP:   { google:   3000, bing:  5000 },
    AD360: { google:   2800, bing:   700 },
    ADSSP: { google:  85000, bing: 20000 },
    ADAP:  { google: 185000, bing: 25000 },
    DSP:   { google:  15000, bing:  5000 },
    ELA:   { google:  85000, bing: 20000 },
  },
  // Projected spend 2026, September.
  '2026-09': {
    ADMP:  { google: 244000, bing: 26000 },
    SPMP:  { google:   6000, bing:  4000 },
    MMP:   { google:   6500, bing:  1000 },
    RMP:   { google:   5100, bing:  2400 },
    AD360: { google:   2275, bing:  1225 },
    ADSSP: { google:  75000, bing: 15000 },
    ADAP:  { google: 223000, bing: 37000 },
    DSP:   { google:  18750, bing:  6250 },
    ELA:   { google:  80388, bing: 24612 },
  },
};

const MONTH_KEYS = Object.keys(BUDGETS_BY_MONTH).sort();

/** Calendar days in a 'YYYY-MM'. */
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The budget for one product in one month. Falls back to the latest earlier
 * month that has one; `carried` says whether that happened, so callers can
 * label it rather than pass it off as planned.
 */
function budgetForMonth(code, ym) {
  let use = ym;
  if (!BUDGETS_BY_MONTH[ym]) {
    const prior = MONTH_KEYS.filter((m) => m <= ym);
    use = prior.length ? prior[prior.length - 1] : MONTH_KEYS[0];
  }
  const b = (BUDGETS_BY_MONTH[use] || {})[code] || { google: 0, bing: 0 };
  return { google: b.google || 0, bing: b.bing || 0, source: use, carried: use !== ym };
}

/**
 * Budget for an inclusive date range, day-weighted.
 *
 * Every period's budget now comes from here. With one figure per quarter a
 * flat 1/13 per week was defensible; with a different figure each month it is
 * not — a week straddling August and September draws from both, and months
 * are 30 or 31 days long. Summing per day is the only version that adds up.
 */
function budgetForRange(code, fromIso, toIso) {
  const DAY = 86400000;
  let google = 0;
  let bing = 0;
  const end = Date.parse(`${toIso}T00:00:00Z`);
  for (let t = Date.parse(`${fromIso}T00:00:00Z`); t <= end; t += DAY) {
    const ym = new Date(t).toISOString().slice(0, 7);
    const b = budgetForMonth(code, ym);
    const n = daysInMonth(ym);
    google += b.google / n;
    bing += b.bing / n;
  }
  return { google, bing };
}

/**
 * Quarter totals, derived rather than declared, so the months stay the single
 * source of truth. Same shape as the old constant, which is why the pacing and
 * payload code that wants a quarter figure needs no change.
 */
const BUDGETS_USD = PRODUCTS.reduce((acc, p) => {
  acc[p.code] = budgetForRange(p.code, QUARTER.start, QUARTER.end);
  return acc;
}, {});

// Thresholds for the insight buckets, as % of budget projected to quarter end.
const THRESHOLDS = {
  overspendingAbove: 105,
  onTrackAbove: 95,
  channelHotAbove: 110,
  channelCoolBelowBenchmarkBy: 15,
};

module.exports = {
  FX_INR_PER_USD,
  QUARTER,
  GOOGLE_ACCOUNTS,
  BING_ACCOUNTS,
  NON_US_PATTERN,
  PRODUCTS,
  BUDGETS_USD,
  BUDGETS_BY_MONTH,
  MONTH_KEYS,
  budgetForMonth,
  budgetForRange,
  daysInMonth,
  THRESHOLDS,
};
