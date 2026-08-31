'use strict';
/**
 * Advanced I/O function — serves the pacing payload to the dashboard.
 *
 *   GET  /data      cached payload; rebuilds from BigQuery on a cache miss
 *   POST /refresh   force a rebuild now (guarded by X-Refresh-Token)
 *   GET  /health    liveness
 *
 * Self-healing by design: a cache miss triggers an inline rebuild rather than
 * failing, so there is no second store to keep in sync and nothing to lose if
 * the cron is late. The dashboard also keeps its own embedded snapshot, so a
 * total outage here degrades to stale data rather than a blank page.
 */

const express = require('express');
const catalystSDK = require('zcatalyst-sdk-node');

const CACHE_KEY = 'spend_pacing_data';
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 48);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Refresh-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

/** Segment.getValue() returns the stored string directly. */
async function readCache(catalyst) {
  try {
    const raw = await catalyst.cache().segment().getValue(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('Cache read failed:', e.message);
    return null;
  }
}

async function rebuild(catalyst) {
  const { buildPayload } = require('../spend_pacing_cron/index.js');
  const { payload } = await buildPayload(catalyst);
  const json = JSON.stringify(payload);
  const segment = catalyst.cache().segment();
  try {
    await segment.put(CACHE_KEY, json, CACHE_TTL_HOURS);
  } catch (e) {
    await segment.update(CACHE_KEY, json, CACHE_TTL_HOURS);
  }
  return payload;
}

app.get('/data', async (req, res) => {
  const catalyst = catalystSDK.initialize(req);
  try {
    let payload = await readCache(catalyst);
    let source = 'cache';
    if (!payload) {
      console.log('Cache miss — rebuilding from BigQuery');
      payload = await rebuild(catalyst);
      source = 'rebuilt';
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.set('X-Data-Source', source);
    return res.json(payload);
  } catch (e) {
    console.error('/data failed:', e);
    return res.status(503).json({ error: 'unavailable', message: e.message });
  }
});

app.post('/refresh', async (req, res) => {
  const expected = process.env.REFRESH_TOKEN;
  if (!expected) return res.status(503).json({ error: 'refresh_disabled' });
  if (req.get('X-Refresh-Token') !== expected) return res.status(401).json({ error: 'unauthorized' });

  const catalyst = catalystSDK.initialize(req);
  try {
    const payload = await rebuild(catalyst);
    return res.json({
      ok: true, asOf: payload.asOf, rows: payload.rows.length,
      fx: payload.fx, fxSource: payload.fxSource,
    });
  } catch (e) {
    console.error('Manual refresh failed:', e);
    return res.status(500).json({ error: 'refresh_failed', message: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

module.exports = app;
