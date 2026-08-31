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

// Quarterly budgets in USD, split Google / Bing. From the Q3 workbook.
const BUDGETS_USD = {
  ADMP:  { google: 639000, bing: 69000 },
  SPMP:  { google:  24000, bing:  6000 },
  MMP:   { google:  24000, bing:  3000 },
  RMP:   { google:   9000, bing: 15000 },
  AD360: { google:   8400, bing:  2100 },
  ADSSP: { google: 255000, bing: 60000 },
  ADAP:  { google: 555000, bing: 75000 },
  DSP:   { google:  45000, bing: 15000 },
  ELA:   { google: 255000, bing: 60000 },
};

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
  THRESHOLDS,
};
