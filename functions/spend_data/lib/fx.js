'use strict';
/**
 * Daily USD/INR rate.
 *
 * Order of preference:
 *   1. FX_INR_PER_USD env var — an explicit pin always wins.
 *   2. Live rate from a public FX API (two independent sources).
 *   3. Last good rate cached from a previous run.
 *   4. FX_FALLBACK (95.6) — the rate reconciled against the Q3 workbook.
 *
 * A live rate drifts from the workbook's fixed rate, so the payload always
 * reports which source was used and the dashboard shows it.
 */

const { FX_INR_PER_USD } = require('./config');

const CACHE_KEY = 'fx_usd_inr';
const CACHE_TTL_HOURS = 48;
const FALLBACK = Number(process.env.FX_FALLBACK || 95.6);

// Sanity band — an FX API returning nonsense should not silently rewrite spend.
const MIN_RATE = 60;
const MAX_RATE = 150;

const SOURCES = [
  {
    name: 'frankfurter',
    url: 'https://api.frankfurter.app/latest?from=USD&to=INR',
    pick: (j) => j && j.rates && j.rates.INR,
    dateOf: (j) => (j && j.date) || null,
  },
  {
    name: 'er-api',
    url: 'https://open.er-api.com/v6/latest/USD',
    pick: (j) => j && j.rates && j.rates.INR,
    dateOf: (j) => (j && j.time_last_update_utc) || null,
  },
];

async function fetchJson(url, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function usable(rate) {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE;
}

/**
 * @param {object|null} catalyst  initialised SDK, for the last-good cache
 * @returns {{rate:number, source:string, asOf:string|null, live:boolean}}
 */
async function resolve(catalyst) {
  // 1. Explicit pin.
  if (process.env.FX_INR_PER_USD) {
    const pinned = Number(process.env.FX_INR_PER_USD);
    if (usable(pinned)) {
      return { rate: pinned, source: 'pinned (FX_INR_PER_USD)', asOf: null, live: false };
    }
    console.error(`FX_INR_PER_USD=${process.env.FX_INR_PER_USD} outside ${MIN_RATE}-${MAX_RATE}, ignoring`);
  }

  // 2. Live.
  for (const s of SOURCES) {
    try {
      const j = await fetchJson(s.url);
      const rate = s.pick(j);
      if (usable(rate)) {
        const out = { rate: Number(rate), source: s.name, asOf: s.dateOf(j), live: true };
        if (catalyst) {
          try {
            await catalyst.cache().segment().put(CACHE_KEY, JSON.stringify(out), CACHE_TTL_HOURS);
          } catch (e) {
            console.error('FX cache write failed:', e.message);
          }
        }
        return out;
      }
      console.error(`FX source ${s.name} returned unusable rate:`, rate);
    } catch (e) {
      console.error(`FX source ${s.name} failed:`, e.message);
    }
  }

  // 3. Last good.
  if (catalyst) {
    try {
      const v = await catalyst.cache().segment().get(CACHE_KEY);
      const raw = v && typeof v === 'object' && 'cache_value' in v ? v.cache_value : v;
      if (raw) {
        const prev = JSON.parse(raw);
        if (usable(prev.rate)) {
          return { ...prev, source: `${prev.source} (cached)`, live: false };
        }
      }
    } catch (e) {
      console.error('FX cache read failed:', e.message);
    }
  }

  // 4. Reconciled fallback.
  return { rate: FALLBACK, source: 'fallback', asOf: null, live: false };
}

module.exports = { resolve, FALLBACK, CACHE_KEY, MIN_RATE, MAX_RATE, usable };
