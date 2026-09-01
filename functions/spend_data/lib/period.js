'use strict';
/**
 * Period reporting for the emailed digest.
 *
 * The quarter outlook answers "where will we land?". This answers "how did the
 * last week / month actually go?" — and the digest should lead with whichever
 * matches the delivery cadence, since that's the window the reader just lived
 * through.
 *
 * A period still in progress is judged against a PRO-RATED budget, so a
 * half-finished month is never reported as half underspent.
 */

const { PRODUCTS, BUDGETS_USD, FX_INR_PER_USD, QUARTER } = require('./config');

const DAY = 86400000;
const d = (s) => Date.parse(`${s}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Monday-start week containing ms. */
function weekStart(ms) {
  const dt = new Date(ms);
  const back = (dt.getUTCDay() + 6) % 7;
  return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - back);
}

/**
 * The window to report on, given a cadence.
 * Weekly and monthly look at the LAST COMPLETE period when one exists, since a
 * Monday email is about last week, not the few hours of this one.
 */
function windowFor(cadence, asOf) {
  const end = d(asOf);

  if (cadence === 'weekly') {
    const thisWeek = weekStart(end);
    const prevEnd = thisWeek - DAY;
    // Use last week unless the current one is already complete.
    if (thisWeek + 6 * DAY <= end) {
      return { start: thisWeek, end: thisWeek + 6 * DAY, kind: 'week' };
    }
    return { start: weekStart(prevEnd), end: prevEnd, kind: 'week' };
  }

  if (cadence === 'monthly') {
    const dt = new Date(end);
    const firstThis = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1);
    const lastThis = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0);
    if (lastThis <= end) return { start: firstThis, end: lastThis, kind: 'month' };
    const prevEnd = firstThis - DAY;
    const p = new Date(prevEnd);
    return { start: Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), 1), end: prevEnd, kind: 'month' };
  }

  // quarterly — the quarter to date
  return { start: d(QUARTER.start), end, kind: 'quarter' };
}

function label(win) {
  if (win.kind === 'week') return `${iso(win.start).slice(5)} – ${iso(win.end).slice(5)}`;
  if (win.kind === 'month') {
    const dt = new Date(win.start);
    return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
  }
  return `${QUARTER.label} to date`;
}

/** Share of the quarterly budget this window represents. */
function budgetFraction(win) {
  const days = Math.round((win.end - win.start) / DAY) + 1;
  const qDays = Math.round((d(QUARTER.end) - d(QUARTER.start)) / DAY) + 1;
  if (win.kind === 'quarter') return 1;
  if (win.kind === 'week') return 1 / 13;
  if (win.kind === 'month') return 1 / 3;
  return days / qDays;
}

/**
 * @returns {{label, kind, partial, elapsed, totalDays, products[], total}}
 */
function report(rows, asOf, cadence, { fx = FX_INR_PER_USD, usOnly = true } = {}) {
  const win = windowFor(cadence, asOf);
  const end = d(asOf);
  const lastDay = Math.min(win.end, end);
  const totalDays = Math.round((win.end - win.start) / DAY) + 1;
  const elapsed = Math.max(0, Math.round((lastDay - win.start) / DAY) + 1);
  const partial = elapsed < totalDays;
  const frac = totalDays > 0 ? elapsed / totalDays : 1;

  const spend = {};
  for (const p of PRODUCTS) spend[p.code] = { google: 0, bing: 0, total: 0 };
  for (const r of rows) {
    if (usOnly && !r.isUs) continue;
    const t = d(r.date);
    if (t < win.start || t > lastDay) continue;
    const b = spend[r.product];
    if (!b) continue;
    const usd = r.costInr / fx;
    b[r.engine] += usd;
    b.total += usd;
  }

  const share = budgetFraction(win);
  const products = [];
  let sumSpend = 0;
  let sumBudget = 0;
  for (const p of PRODUCTS) {
    const bq = BUDGETS_USD[p.code] || { google: 0, bing: 0 };
    const budget = (bq.google + bq.bing) * share * (partial ? frac : 1);
    const s = spend[p.code].total;
    sumSpend += s;
    sumBudget += budget;
    if (budget <= 0) continue;
    products.push({
      code: p.code, name: p.name, bu: p.bu, grp: p.grp,
      spend: s, budget,
      used: (s / budget) * 100,
      delta: s - budget,
    });
  }
  products.sort((a, b) => b.delta - a.delta);

  return {
    label: label(win),
    kind: win.kind,
    start: iso(win.start),
    end: iso(Math.min(win.end, end)),
    partial, elapsed, totalDays,
    products,
    over: products.filter((p) => p.used > 110),
    under: products.filter((p) => p.used < 90),
    onTrack: products.filter((p) => p.used >= 90 && p.used <= 110),
    total: {
      spend: sumSpend,
      budget: sumBudget,
      used: sumBudget > 0 ? (sumSpend / sumBudget) * 100 : null,
      delta: sumSpend - sumBudget,
    },
  };
}

module.exports = { report, windowFor, label, budgetFraction, weekStart };
