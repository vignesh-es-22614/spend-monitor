'use strict';
/**
 * Catalyst Cron — SEM spend pacing.
 *
 * Runs DAILY. Every run refreshes the dashboard data; the email goes out only
 * on the days listed in EMAIL_DAYS (default Monday). That keeps the numbers
 * current without mailing people every morning.
 *
 * Storage: the payload is written to Catalyst Cache (fast reads for the
 * dashboard) and to File Store (durable, survives cache eviction).
 */

const catalystSDK = require('zcatalyst-sdk-node');
const { fetchSpend } = require('./lib/bigquery');
const { QUARTER, PRODUCTS, BUDGETS_USD } = require('./lib/config');
const { resolve: fx_resolve } = require('./lib/fx');
const {
  benchmark, recentRate, aggregate, metricsFor, buildInsights, pct, RECENT_WINDOW_DAYS,
} = require('./lib/pacing');
const { buildHtml, buildText, send } = require('./lib/email');

const CACHE_KEY = 'spend_pacing_data';
// Hours. One missed daily run still leaves yesterday's numbers readable.
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 48);

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * Google and Bing land on different days. Use the EARLIER of the two maxima so
 * the last day in view is never Google-only — that would read as a sudden dip.
 */
function alignedCutoff(rows) {
  const maxBy = {};
  for (const r of rows) {
    if (!maxBy[r.engine] || r.date > maxBy[r.engine]) maxBy[r.engine] = r.date;
  }
  const engines = Object.keys(maxBy);
  if (!engines.length) return null;
  const cutoff = engines.map((e) => maxBy[e]).sort()[0];
  return { cutoff, perEngine: maxBy };
}

/** Should today send an email? EMAIL_DAYS=MON or MON,THU or DAILY or NEVER. */
function shouldEmail(now = new Date()) {
  const cfg = (process.env.EMAIL_DAYS || 'MON').toUpperCase().trim();
  if (cfg === 'NEVER') return false;
  if (cfg === 'DAILY') return true;
  // Catalyst cron runs UTC; IST is +5:30, so evaluate the day in IST.
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return cfg.split(',').map((s) => s.trim()).includes(DAY_NAMES[ist.getUTCDay()]);
}

async function buildPayload(catalyst) {
  const from = QUARTER.start;
  const to = process.env.AS_OF || new Date().toISOString().slice(0, 10);

  const all = await fetchSpend(from, to);
  if (!all.length) throw new Error(`No spend rows returned for ${from}..${to}`);

  const { cutoff, perEngine } = alignedCutoff(all);
  const rows = all.filter((r) => r.date <= cutoff);
  const asOf = cutoff;

  // Live USD/INR, refreshed on every run.
  const fx = await fx_resolve(catalyst);

  const bench = benchmark(asOf);
  const rate = recentRate(rows, asOf, { usOnly: true, fx: fx.rate });
  const metrics = metricsFor(aggregate(rows, { usOnly: true, fx: fx.rate }), bench, rate);
  const insights = buildInsights(metrics, bench);

  const payload = {
    generatedAt: new Date().toISOString(),
    asOf,
    dataFreshness: perEngine,          // per-engine latest, before alignment
    quarter: QUARTER,
    fx: fx.rate,
    fxSource: fx.source,
    fxAsOf: fx.asOf,
    fxLive: fx.live,
    windowDays: RECENT_WINDOW_DAYS,
    benchmark: bench,
    products: PRODUCTS,
    budgets: BUDGETS_USD,
    // US rows only, compact keys — the dashboard buckets these itself.
    rows: rows.filter((r) => r.isUs).map((r) => ({
      d: r.date, p: r.product, e: r.engine[0], c: Number(r.costInr.toFixed(2)),
    })),
  };
  return { payload, metrics, bench, insights, asOf, fx, perEngine };
}

/**
 * Cache is the only store. TTL is 48h so a single missed run still serves
 * yesterday's numbers, and the /data endpoint rebuilds from BigQuery on a
 * miss — so there is nothing to lose and no extra console setup.
 */
async function persist(catalyst, payload) {
  const json = JSON.stringify(payload);
  const segment = catalyst.cache().segment();
  try {
    // put() creates or overwrites; update() only works on an existing key.
    await segment.put(CACHE_KEY, json, CACHE_TTL_HOURS);
  } catch (e) {
    // Some SDK builds reject put() on an existing key — fall back to update().
    console.error('Cache put failed, trying update:', e.message);
    await segment.update(CACHE_KEY, json, CACHE_TTL_HOURS);
  }
  return { cache: true, bytes: json.length };
}

async function run(catalyst, { dryRun = false, forceEmail = false } = {}) {
  const { payload, metrics, bench, insights, asOf, fx, perEngine } = await buildPayload(catalyst);

  const stored = dryRun ? { cache: false, bytes: JSON.stringify(payload).length }
                        : await persist(catalyst, payload);

  const emailing = forceEmail || shouldEmail();
  const subject = insights.over.length
    ? `SEM Spend Pacing — ${QUARTER.label} — ${insights.over.length} over budget (total ${pct(insights.total.projected)})`
    : `SEM Spend Pacing — ${QUARTER.label} — on plan (total ${pct(insights.total.projected)})`;

  const html = buildHtml({
    metrics, bench, insights, asOf,
    dashboardUrl: process.env.DASHBOARD_URL || '',
  });
  const text = buildText({ insights, bench, asOf });

  if (dryRun) {
    return { subject, html, text, asOf, bench, insights, stored, emailing, fx, perEngine,
             payload, sentTo: [] };
  }

  let sentTo = [];
  let mailError = null;
  if (emailing) {
    try {
      sentTo = await send(catalyst, { to: process.env.MAIL_TO, subject, html, text });
    } catch (e) {
      // A mail failure must not fail the whole run — the data refresh already
      // succeeded and the dashboard is current.
      mailError = e.message;
      console.error('Email delivery failed:', e);
    }
  }

  return {
    subject, asOf, bench, insights, stored, emailing, sentTo, mailError,
    fx, perEngine, rowCount: payload.rows.length,
  };
}

/* ------------------------------------------------------------------ */

module.exports = async (cronDetails, context) => {
  const catalyst = catalystSDK.initialize(context);
  try {
    const r = await run(catalyst);
    console.log(
      `Refreshed ${r.rowCount} rows through ${r.asOf} ` +
      `(google=${r.perEngine.google} bing=${r.perEngine.bing}) ` +
      `FX ${r.fx.rate} via ${r.fx.source} ` +
      `cached ${r.stored.bytes} bytes. ` +
      (r.emailing
        ? (r.mailError ? `EMAIL FAILED: ${r.mailError}` : `Emailed "${r.subject}" to ${r.sentTo.join(', ')}`)
        : 'No email scheduled today.')
    );
    // Data refresh is the primary job. Only a mail failure on a mail day is
    // worth failing the run, so it shows red in the console.
    if (r.emailing && r.mailError) return context.closeWithFailure();
    context.closeWithSuccess();
  } catch (err) {
    console.error('spend_pacing_cron failed:', err);
    context.closeWithFailure();
  }
};

module.exports.run = run;
module.exports.buildPayload = buildPayload;
module.exports.shouldEmail = shouldEmail;
module.exports.CACHE_KEY = CACHE_KEY;
