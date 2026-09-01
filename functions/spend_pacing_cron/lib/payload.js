'use strict';
/**
 * Builds the pacing payload. Lives in lib/ so BOTH functions can use it —
 * Catalyst bundles each function separately, so a function may only require
 * files inside its own directory. scripts/sync-lib.js keeps the copies equal.
 */

const { fetchSpend } = require('./bigquery');
const { QUARTER, PRODUCTS, BUDGETS_USD } = require('./config');
const { resolve: fxResolve } = require('./fx');
const {
  benchmark, recentRate, aggregate, metricsFor, buildInsights, RECENT_WINDOW_DAYS,
} = require('./pacing');

const CACHE_KEY = 'spend_pacing_data';
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 48);

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
  return { cutoff: engines.map((e) => maxBy[e]).sort()[0], perEngine: maxBy };
}

async function buildPayload(catalyst) {
  const from = QUARTER.start;
  const to = process.env.AS_OF || new Date().toISOString().slice(0, 10);

  const all = await fetchSpend(from, to);
  if (!all.length) throw new Error(`No spend rows returned for ${from}..${to}`);

  const { cutoff, perEngine } = alignedCutoff(all);
  const rows = all.filter((r) => r.date <= cutoff);
  const asOf = cutoff;

  const fx = await fxResolve(catalyst);

  const bench = benchmark(asOf);
  const rate = recentRate(rows, asOf, { usOnly: true, fx: fx.rate });
  const metrics = metricsFor(aggregate(rows, { usOnly: true, fx: fx.rate }), bench, rate);
  const insights = buildInsights(metrics, bench);

  const payload = {
    generatedAt: new Date().toISOString(),
    asOf,
    dataFreshness: perEngine,
    quarter: QUARTER,
    fx: fx.rate,
    fxSource: fx.source,
    fxAsOf: fx.asOf,
    fxLive: fx.live,
    windowDays: RECENT_WINDOW_DAYS,
    benchmark: bench,
    products: PRODUCTS,
    budgets: BUDGETS_USD,
    rows: rows.filter((r) => r.isUs).map((r) => ({
      d: r.date, p: r.product, e: r.engine[0], c: Number(r.costInr.toFixed(2)),
    })),
  };
  // `rows` is the raw shape ({date, product, engine, isUs, costInr}) — the
  // period report needs it, and payload.rows is the compacted form.
  return { payload, metrics, bench, insights, asOf, fx, perEngine, rows };
}

/* -------------------------------------------------------------------------
 * Cache packing
 *
 * Catalyst caps the length of a cache value, and the raw payload (~48 KB of
 * daily rows) blows past it. Two steps get it under 8 KB:
 *   1. rows become tuples [date, productIndex, engineIndex, cost] with the
 *      product names interned — roughly halves the JSON
 *   2. gzip + base64
 *
 * unpack() restores the exact original shape, so the API response and the
 * dashboard never see the compact form.
 * ---------------------------------------------------------------------- */

const zlib = require('zlib');
const PACK_PREFIX = 'gz1:';
const ENGINES = ['g', 'b'];

function pack(payload) {
  const products = [...new Set(payload.rows.map((r) => r.p))];
  const idx = new Map(products.map((p, i) => [p, i]));
  const compact = {
    ...payload,
    _P: products,
    rows: payload.rows.map((r) => [r.d, idx.get(r.p), r.e === 'g' ? 0 : 1, r.c]),
  };
  return PACK_PREFIX + zlib.gzipSync(Buffer.from(JSON.stringify(compact), 'utf8')).toString('base64');
}

function unpack(raw) {
  if (!raw.startsWith(PACK_PREFIX)) return JSON.parse(raw); // legacy uncompressed
  const json = zlib.gunzipSync(Buffer.from(raw.slice(PACK_PREFIX.length), 'base64')).toString('utf8');
  const c = JSON.parse(json);
  const products = c._P || [];
  const payload = {
    ...c,
    rows: (c.rows || []).map(([d, p, e, cost]) => ({
      d, p: products[p], e: ENGINES[e], c: cost,
    })),
  };
  delete payload._P;
  return payload;
}

/** put() creates or overwrites; some SDK builds need update() on an existing key. */
async function cachePayload(catalyst, payload) {
  const packed = pack(payload);
  const segment = catalyst.cache().segment();
  try {
    await segment.put(CACHE_KEY, packed, CACHE_TTL_HOURS);
  } catch (e) {
    console.error('Cache put failed, trying update:', e.message);
    await segment.update(CACHE_KEY, packed, CACHE_TTL_HOURS);
  }
  return {
    cache: true,
    bytes: packed.length,
    rawBytes: JSON.stringify(payload).length,
  };
}

async function readCachedPayload(catalyst) {
  try {
    const raw = await catalyst.cache().segment().getValue(CACHE_KEY);
    return raw ? unpack(raw) : null;
  } catch (e) {
    console.error('Cache read failed:', e.message);
    return null;
  }
}

module.exports = {
  buildPayload, cachePayload, readCachedPayload, alignedCutoff,
  pack, unpack, CACHE_KEY, CACHE_TTL_HOURS,
};
