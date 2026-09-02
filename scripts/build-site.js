#!/usr/bin/env node
'use strict';
/**
 * Builds the static dashboard for GitHub Pages, and optionally emails the digest.
 *
 *   node scripts/build-site.js            build docs/index.html
 *   node scripts/build-site.js --email    also send, if the schedule says to
 *   node scripts/build-site.js --force-email   send regardless of schedule
 *
 * There is no server here. The data is baked into the HTML at build time and
 * Pages serves it, so the page has nothing to fetch and cannot go stale between
 * builds — it is exactly as fresh as the last workflow run.
 *
 * Auth: GCP_SERVICE_ACCOUNT_JSON (a GitHub secret) or a local BQ_TOKEN_PATH.
 */

const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'functions', 'spend_pacing_cron', 'lib');
const { fetchSpend } = require(path.join(LIB, 'bigquery'));
const { PRODUCTS, BUDGETS_USD, QUARTER } = require(path.join(LIB, 'config'));
const { resolve: fxResolve } = require(path.join(LIB, 'fx'));
const {
  benchmark, recentRate, aggregate, metricsFor, buildInsights, RECENT_WINDOW_DAYS,
} = require(path.join(LIB, 'pacing'));
const { buildHtml, buildText, send } = require(path.join(LIB, 'email'));
const periodLib = require(path.join(LIB, 'period'));

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'site', 'template.html');
const OUT_DIR = path.join(ROOT, 'docs');
const OUT = path.join(OUT_DIR, 'index.html');
const CONFIG = path.join(ROOT, 'alerts.config.json');

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function loadConfig() {
  const base = {
    enabled: true, cadence: 'weekly', days: ['MON'], dayOfMonth: 1,
    recipients: '', alwaysEmailWhenOverBudget: 0,
  };
  if (!fs.existsSync(CONFIG)) return base;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    // Keys beginning with _ are documentation, not settings.
    for (const k of Object.keys(raw)) if (!k.startsWith('_')) base[k] = raw[k];
    return base;
  } catch (e) {
    console.error(`alerts.config.json is not valid JSON (${e.message}) — using defaults`);
    return base;
  }
}

/** Business day in IST; GitHub runners are UTC. */
function istToday(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return {
    day: DAY_NAMES[ist.getUTCDay()],
    dayOfMonth: ist.getUTCDate(),
    month: ist.getUTCMonth(),
    iso: ist.toISOString().slice(0, 10),
  };
}

function isSendDay(cfg, now = new Date()) {
  if (!cfg.enabled) return false;
  const t = istToday(now);
  if (cfg.cadence === 'weekly') return (cfg.days || []).includes(t.day);
  if (cfg.cadence === 'monthly') return t.dayOfMonth === cfg.dayOfMonth;
  if (cfg.cadence === 'quarterly') {
    return [0, 3, 6, 9].includes(t.month) && t.dayOfMonth === cfg.dayOfMonth;
  }
  return false;
}

/** Google and Bing land on different days — never show a Google-only tail. */
function alignedCutoff(rows) {
  const maxBy = {};
  for (const r of rows) {
    if (!maxBy[r.engine] || r.date > maxBy[r.engine]) maxBy[r.engine] = r.date;
  }
  const engines = Object.keys(maxBy);
  return { cutoff: engines.map((e) => maxBy[e]).sort()[0], perEngine: maxBy };
}

(async () => {
  const emailWanted = process.argv.includes('--email') || process.argv.includes('--force-email');
  const forceEmail = process.argv.includes('--force-email');
  const cfg = loadConfig();

  const from = QUARTER.start;
  const to = process.env.AS_OF || new Date().toISOString().slice(0, 10);
  console.log(`Querying BigQuery ${from} .. ${to}`);

  let all = await fetchSpend(from, to);
  if (!all.length) throw new Error(`No spend rows for ${from}..${to}`);

  // Bing's BigQuery transfer stopped after 2026-08-27 and wrote that last day
  // only partially. data/bing-backfill.json carries the missing days lifted
  // from the Ads API. It REPLACES BigQuery for every date it covers rather
  // than adding to it, so a partial day is corrected instead of double
  // counted. Verified against BigQuery on the overlapping days: 61 buckets,
  // worst 0.00%. Delete the file once the transfer is fixed.
  let backfill = null;
  const BACKFILL = path.join(ROOT, 'data', 'bing-backfill.json');
  if (fs.existsSync(BACKFILL)) {
    const bf = JSON.parse(fs.readFileSync(BACKFILL, 'utf8'));
    const covered = new Set(bf.coveredDates);
    const before = all.length;
    const kept = all.filter((r) => !(r.engine === 'bing' && covered.has(r.date)));
    const added = bf.rows
      .filter((r) => r.date >= from && r.date <= to)
      .map((r) => ({
        date: r.date, product: r.product, engine: 'bing',
        isUs: !!r.isUs, costInr: Number(r.costInr) || 0,
      }));
    all = kept.concat(added);
    backfill = { from: bf.coveredDates[0], to: bf.coveredDates.at(-1), generatedAt: bf.generatedAt };
    console.log(`Backfill: swapped ${before - kept.length} BigQuery Bing rows `
      + `for ${added.length} from the Ads API (${backfill.from}..${backfill.to})`);
  }

  const { cutoff, perEngine } = alignedCutoff(all);
  const rows = all.filter((r) => r.date <= cutoff);
  const asOf = cutoff;

  const fx = await fxResolve(null);
  console.log(`FX ${fx.rate} via ${fx.source}`);
  console.log(`Latest: google=${perEngine.google} bing=${perEngine.bing} -> using ${asOf}`);

  const bench = benchmark(asOf);
  const rate = recentRate(rows, asOf, { usOnly: true, fx: fx.rate });
  const metrics = metricsFor(aggregate(rows, { usOnly: true, fx: fx.rate }), bench, rate);
  const insights = buildInsights(metrics, bench);
  const period = periodLib.report(rows, asOf, cfg.cadence, { fx: fx.rate });

  /* ---- static page ------------------------------------------------- */
  const usRows = rows.filter((r) => r.isUs).map((r) => ({
    d: r.date, p: r.product, e: r.engine[0], c: Number(r.costInr.toFixed(2)),
  }));
  const [y, m, d] = asOf.split('-').map(Number);

  // The page stores budgets as [google, bing] tuples; config.js keeps them as
  // {google, bing}. Passing the object straight through makes every lookup
  // return 0 and the whole Budget column renders blank.
  const budgetTuples = {};
  for (const [code, b] of Object.entries(BUDGETS_USD)) {
    budgetTuples[code] = [b.google || 0, b.bing || 0];
  }
  const totalBudget = Object.values(budgetTuples).reduce((a, [g, bb]) => a + g + bb, 0);
  if (totalBudget <= 0) throw new Error('Budgets resolved to zero — check BUDGETS_USD in lib/config.js');
  console.log(`Budgets: ${Object.keys(budgetTuples).length} products, $${totalBudget.toLocaleString()} total`);

  // The Schedule tab has no server to query, so bake in the live config and a
  // link to where it is actually edited.
  const repo = process.env.GITHUB_REPOSITORY || 'vignesh-es-22614/spend-monitor';
  const configUrl = `https://github.com/${repo}/edit/main/alerts.config.json`;

  const html = fs.readFileSync(TEMPLATE, 'utf8')
    // Two sites: the FX input and the initial state. Both must match the rate
    // the digest was computed with, or page and email quote different numbers.
    .replace(/__FX__/g, String(fx.rate))
    .replace('__DATA__', JSON.stringify(usRows))
    .replace('__PRODUCTS__', JSON.stringify(PRODUCTS))
    .replace('__BUDGETS__', JSON.stringify(budgetTuples))
    .replace('__SCHEDULE__', JSON.stringify({
      enabled: cfg.enabled, cadence: cfg.cadence, days: cfg.days,
      dayOfMonth: cfg.dayOfMonth, recipients: cfg.recipients,
    }))
    .replace('__CONFIG_URL__', configUrl)
    // Per-engine coverage, so a stalled transfer is visible on the page rather
    // than looking like a broken refresh.
    .replace('__DATA_STATE__', JSON.stringify({
      status: 'embedded',
      generatedAt: new Date().toISOString(),
      fxSource: fx.source,
      fxAsOf: fx.asOf || null,
      freshness: { google: perEngine.google || null, bing: perEngine.bing || null },
      backfill,
    }))
    .replace('__AY__', String(y))
    .replace('__AM__', String(m - 1))   // JS months are 0-based
    .replace('__AD__', String(d));

  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- Built ${new Date().toISOString()} · data through ${asOf} · FX ${fx.rate} (${fx.source}) -->
${html}
</html>
`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, page);
  // Stops Pages running the output through Jekyll, which would eat _-prefixed files.
  fs.writeFileSync(path.join(OUT_DIR, '.nojekyll'), '');
  console.log(`Wrote docs/index.html (${(page.length / 1024).toFixed(1)} KB, ${usRows.length} rows)`);

  /* ---- email ------------------------------------------------------- */
  if (!emailWanted) {
    console.log('Build only — no email requested.');
    return;
  }

  const hot = insights.over.filter((mm) =>
    cfg.alwaysEmailWhenOverBudget > 0 && mm.projected > cfg.alwaysEmailWhenOverBudget);
  const scheduled = isSendDay(cfg);
  if (!forceEmail && !scheduled && !hot.length) {
    console.log(`Not a send day (${cfg.cadence}${cfg.cadence === 'weekly'
      ? ' on ' + (cfg.days || []).join(', ') : ' on day ' + cfg.dayOfMonth}). No email.`);
    return;
  }
  if (!forceEmail && !scheduled && hot.length) {
    console.log(`Off-schedule alert: ${hot.length} product(s) past ${cfg.alwaysEmailWhenOverBudget}%.`);
  }

  const to_ = (cfg.recipients || '').trim() || process.env.MAIL_TO;
  if (!to_) throw new Error('No recipients — set alerts.config.json recipients or the MAIL_TO secret');

  const subject = insights.over.length
    ? `SEM Spend Pacing — ${period.label} — ${insights.over.length} over budget (Q3 ${Math.round(insights.total.projected)}%)`
    : `SEM Spend Pacing — ${period.label} — on plan (Q3 ${Math.round(insights.total.projected)}%)`;

  const sent = await send(null, {
    to: to_,
    subject,
    html: buildHtml({
      metrics, bench, insights, asOf, period,
      dashboardUrl: process.env.DASHBOARD_URL || '',
    }),
  });
  console.log(`Emailed "${subject}" to ${sent.join(', ')}`);
  // Text version is handy in the workflow log for debugging.
  console.log('\n' + buildText({ insights, bench, asOf, period }));
})().catch((e) => {
  console.error('build-site failed:', e);
  process.exit(1);
});
