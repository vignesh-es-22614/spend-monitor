'use strict';
/**
 * Pacing maths and insight generation.
 *
 *   benchmark       = days elapsed / days in quarter        (calendar position)
 *   used %          = spend to date / budget
 *
 * Projection uses the RECENT run-rate, not the quarter average, so it reacts
 * to how spend is actually trending now:
 *
 *   daily rate      = spend in the last N days / N          (N = 21, 3 weeks)
 *   remaining days  = days in quarter - days elapsed        (exact, ignores
 *                                                            week/month edges)
 *   projected spend = spend to date + daily rate * remaining days
 *   projected %     = projected spend / budget
 *   over / under    = projected spend - budget
 *
 * Because projection starts from money already spent and only adds, it can
 * never land below actual spend — that was the bug in the workbook's AD360 row.
 */

const {
  FX_INR_PER_USD, QUARTER, PRODUCTS, BUDGETS_USD, THRESHOLDS,
} = require('./config');

const DAY = 86400000;
const d = (s) => Date.parse(`${s}T00:00:00Z`);

// Length of the trailing window used for the projection run-rate.
const RECENT_WINDOW_DAYS = Number(process.env.RECENT_WINDOW_DAYS || 21);

function benchmark(asOf) {
  const total = Math.round((d(QUARTER.end) - d(QUARTER.start)) / DAY) + 1;
  const raw = Math.round((d(asOf) - d(QUARTER.start)) / DAY) + 1;
  const elapsed = Math.max(0, Math.min(raw, total));
  return {
    total,
    elapsed,
    remaining: total - elapsed,
    fraction: elapsed / total,
    windowDays: RECENT_WINDOW_DAYS,
  };
}

/**
 * Average daily USD spend per product over the trailing window ending at asOf.
 * The window is clipped to the quarter start, and the divisor is the number of
 * days actually covered — so an early-quarter run does not understate the rate.
 */
function recentRate(rows, asOf, { usOnly = true, fx = FX_INR_PER_USD,
                                  windowDays = RECENT_WINDOW_DAYS } = {}) {
  const end = d(asOf);
  const qStart = d(QUARTER.start);
  const start = Math.max(qStart, end - (windowDays - 1) * DAY);
  const days = Math.round((end - start) / DAY) + 1;

  const acc = {};
  for (const p of PRODUCTS) acc[p.code] = { google: 0, bing: 0, total: 0 };
  for (const r of rows) {
    if (usOnly && !r.isUs) continue;
    const t = d(r.date);
    if (t < start || t > end) continue;
    const b = acc[r.product];
    if (!b) continue;
    const usd = r.costInr / fx;
    b[r.engine] += usd;
    b.total += usd;
  }
  const rate = {};
  for (const p of PRODUCTS) {
    const a = acc[p.code];
    rate[p.code] = {
      google: a.google / days,
      bing: a.bing / days,
      total: a.total / days,
      days,
    };
  }
  rate._days = days;
  return rate;
}

/** Aggregate raw rows into per-product USD spend, US-targeted only. */
function aggregate(rows, { usOnly = true, fx = FX_INR_PER_USD } = {}) {
  const out = {};
  for (const p of PRODUCTS) out[p.code] = { google: 0, bing: 0, total: 0 };
  for (const r of rows) {
    if (usOnly && !r.isUs) continue;
    const bucket = out[r.product];
    if (!bucket) continue;
    const usd = r.costInr / fx;
    bucket[r.engine] += usd;
    bucket.total += usd;
  }
  return out;
}

function budgetOf(code) {
  const b = BUDGETS_USD[code] || { google: 0, bing: 0 };
  return { google: b.google, bing: b.bing, total: b.google + b.bing };
}

function metricsFor(spend, bench, rate) {
  const out = {};
  const rem = bench.remaining;
  for (const p of PRODUCTS) {
    const s = spend[p.code];
    const b = budgetOf(p.code);
    const r = (rate && rate[p.code]) || { google: 0, bing: 0, total: 0 };
    const usedTotal = b.total > 0 ? (s.total / b.total) * 100 : null;

    // Recent run-rate carried across the exact days left in the quarter.
    const projSpend = s.total + r.total * rem;
    const projG = s.google + r.google * rem;
    const projB = s.bing + r.bing * rem;

    out[p.code] = {
      ...p,
      spend: s,
      budget: b,
      dailyRate: r,
      usedGoogle: b.google > 0 ? (s.google / b.google) * 100 : null,
      usedBing: b.bing > 0 ? (s.bing / b.bing) * 100 : null,
      used: usedTotal,
      projected: b.total > 0 ? (projSpend / b.total) * 100 : null,
      projectedGoogle: b.google > 0 ? (projG / b.google) * 100 : null,
      projectedBing: b.bing > 0 ? (projB / b.bing) * 100 : null,
      projectedSpend: b.total > 0 ? projSpend : null,
      over: b.total > 0 ? projSpend - b.total : null,
      remaining: b.total > 0 ? b.total - s.total : null,
    };
  }
  return out;
}

function rollup(codes, metrics, bench) {
  const acc = { google: 0, bing: 0, total: 0 };
  const bud = { google: 0, bing: 0, total: 0 };
  const rate = { google: 0, bing: 0, total: 0 };
  for (const c of codes) {
    const m = metrics[c];
    acc.google += m.spend.google; acc.bing += m.spend.bing; acc.total += m.spend.total;
    bud.google += m.budget.google; bud.bing += m.budget.bing; bud.total += m.budget.total;
    rate.google += m.dailyRate.google; rate.bing += m.dailyRate.bing; rate.total += m.dailyRate.total;
  }
  const rem = bench.remaining;
  const projSpend = acc.total + rate.total * rem;
  const projG = acc.google + rate.google * rem;
  const projB = acc.bing + rate.bing * rem;
  return {
    spend: acc,
    budget: bud,
    dailyRate: rate,
    usedGoogle: bud.google > 0 ? (acc.google / bud.google) * 100 : null,
    usedBing: bud.bing > 0 ? (acc.bing / bud.bing) * 100 : null,
    used: bud.total > 0 ? (acc.total / bud.total) * 100 : null,
    projected: bud.total > 0 ? (projSpend / bud.total) * 100 : null,
    projectedGoogle: bud.google > 0 ? (projG / bud.google) * 100 : null,
    projectedBing: bud.bing > 0 ? (projB / bud.bing) * 100 : null,
    projectedSpend: bud.total > 0 ? projSpend : null,
    over: bud.total > 0 ? projSpend - bud.total : null,
    remaining: bud.total > 0 ? bud.total - acc.total : null,
  };
}

const pct = (n, dp = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—' : `${n.toFixed(dp)}%`);
const money = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
};

/**
 * "Bing 80%, Google 75% — both hot"
 *
 * A channel is hot when its OWN run-rate projects past budget, i.e.
 * used / benchmark > 105. Comparing raw used% to a flat 110 would call
 * ADMP's 80%/75% cool when both are in fact pacing ~130% of plan.
 */
function channels(m, bench) {
  const parts = [];
  if (m.usedBing !== null) parts.push({ k: 'Bing', v: m.usedBing });
  if (m.usedGoogle !== null) parts.push({ k: 'Google', v: m.usedGoogle });
  parts.sort((a, b) => b.v - a.v);
  const txt = parts.map((p) => `${p.k} ${pct(p.v)}`).join(', ');
  // Judge each channel on its own projection, not raw used%.
  const projOf = (k) => (k === 'Bing' ? m.projectedBing : m.projectedGoogle);
  const hot = (k) => { const p = projOf(k); return p !== null && p > THRESHOLDS.overspendingAbove; };
  const cool = (k) => { const p = projOf(k); return p !== null && p < THRESHOLDS.onTrackAbove; };
  if (parts.length === 2) {
    const [hi, lo] = parts;
    if (hot(hi.k) && hot(lo.k)) return `${txt} — both hot`;
    if (hot(hi.k) && cool(lo.k)) return `${txt} — ${hi.k} is the outlier`;
    if (hot(hi.k)) return `${txt} — ${hi.k} running hot`;
    if (Math.abs(hi.v - lo.v) < 6) return `${txt} — even`;
  }
  return txt;
}

function buildInsights(metrics, bench) {
  const over = [], onTrack = [], under = [], flagged = [];
  for (const p of PRODUCTS) {
    const m = metrics[p.code];
    if (m.budget.total <= 0) { flagged.push({ m, why: `no budget set, spend ${money(m.spend.total)}` }); continue; }
    if (m.spend.total === 0) { flagged.push({ m, why: `budget of ${money(m.budget.total)} set but nothing spent` }); continue; }
    if (m.projectedSpend < m.spend.total - 0.5) {
      flagged.push({ m, why: 'projection lands below money already spent — formula error' }); continue;
    }
    if (m.projected > THRESHOLDS.overspendingAbove) over.push(m);
    else if (m.projected >= THRESHOLDS.onTrackAbove) onTrack.push(m);
    else under.push(m);
  }
  over.sort((a, b) => b.over - a.over);
  under.sort((a, b) => a.projected - b.projected);
  onTrack.sort((a, b) => b.used - a.used);

  const biggest = over.length ? over[0].code : null;
  const lines = {
    overspending: over.map((m) => {
      const tail = m.code === biggest
        ? ` — biggest overshoot at ${money(m.over)}`
        : ` — ${money(m.over)} over`;
      return `${m.code}: ${pct(m.used)} used (${channels(m, bench)}), projected spend over ${pct(m.projected - 100)}${tail}`;
    }),
    onTrack: onTrack.map((m) =>
      `${m.code}: ${pct(m.used)} used (${channels(m, bench)}), projected ${pct(m.projected)}`),
    underPacing: under.map((m) =>
      `${m.code}: ${pct(m.used)} used (${channels(m, bench)}), projected ${pct(m.projected)} — ${money(m.budget.total - m.projectedSpend)} headroom to reallocate`),
    rollups: [],
    flags: flagged.map((f) => `${f.m.code}: ${f.why}`),
  };

  const all = PRODUCTS.map((p) => p.code);
  const total = rollup(all, metrics, bench);
  lines.rollups.push(
    `Total: ${pct(total.used)} used, projected ${total.projected > 100 ? `over ${pct(total.projected - 100)}` : pct(total.projected)} (${money(total.projectedSpend)} vs ${money(total.budget.total)})`
  );
  for (const bu of ['SIEM', 'IDM']) {
    const inBu = PRODUCTS.filter((p) => p.bu === bu);
    const r = rollup(inBu.map((p) => p.code), metrics, bench);
    if (r.budget.total <= 0) continue;
    lines.rollups.push(
      `${bu}: ${pct(r.used)} used (${channels(r, bench)}), projected ${r.projected > 100 ? `over ${pct(r.projected - 100)}` : pct(r.projected)}`
    );
    for (const grp of [...new Set(inBu.map((p) => p.grp))]) {
      const inG = inBu.filter((p) => p.grp === grp);
      const g = rollup(inG.map((p) => p.code), metrics, bench);
      if (g.budget.total <= 0) continue;
      lines.rollups.push(
        `    ${grp}: ${pct(g.used)} used (${channels(g, bench)}), projected ${g.projected > 100 ? `over ${pct(g.projected - 100)}` : pct(g.projected)}`
      );
    }
  }

  return { over, onTrack, under, flagged, total, lines };
}

module.exports = {
  benchmark, recentRate, aggregate, metricsFor, rollup, buildInsights,
  channels, pct, money, budgetOf, RECENT_WINDOW_DAYS,
};
