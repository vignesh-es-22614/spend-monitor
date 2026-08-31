'use strict';
/**
 * Advanced I/O function — serves the pacing payload to the dashboard.
 *
 *   GET  /server/spend_data/data     current payload (cache, then File Store)
 *   POST /server/spend_data/refresh  force a rebuild now (guarded by a token)
 *
 * The dashboard falls back to its embedded snapshot if this is unreachable,
 * so a failure here degrades to stale data rather than a blank page.
 */

const express = require('express');
const catalystSDK = require('zcatalyst-sdk-node');

const CACHE_KEY = 'spend_pacing_data';
const DATA_FILE = 'data.json';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  // The client is served from the same Catalyst project; allow simple GETs.
  res.set('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Refresh-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

async function readFromCache(catalyst) {
  try {
    const v = await catalyst.cache().segment().get(CACHE_KEY);
    // The SDK returns either the raw value or {cache_value: ...} by version.
    const raw = v && typeof v === 'object' && 'cache_value' in v ? v.cache_value : v;
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('Cache read failed:', e.message);
    return null;
  }
}

async function readFromFileStore(catalyst) {
  const folderId = process.env.CATALYST_FOLDER_ID;
  if (!folderId) return null;
  try {
    const folder = catalyst.filestore().folder(folderId);
    const files = await folder.getAllFiles();
    const match = (files || []).find((f) => f.file_name === DATA_FILE);
    if (!match) return null;
    const stream = await folder.downloadFile(match.id);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    console.error('File Store read failed:', e.message);
    return null;
  }
}

app.get('/data', async (req, res) => {
  const catalyst = catalystSDK.initialize(req);
  const payload = (await readFromCache(catalyst)) || (await readFromFileStore(catalyst));
  if (!payload) {
    return res.status(503).json({
      error: 'no_data',
      message: 'No payload cached yet. Run the spend_pacing_cron function once.',
    });
  }
  // Data changes at most daily; let the browser hold it briefly.
  res.set('Cache-Control', 'public, max-age=300');
  return res.json(payload);
});

app.post('/refresh', async (req, res) => {
  const expected = process.env.REFRESH_TOKEN;
  if (!expected) return res.status(503).json({ error: 'refresh_disabled' });
  if (req.get('X-Refresh-Token') !== expected) return res.status(401).json({ error: 'unauthorized' });

  const catalyst = catalystSDK.initialize(req);
  try {
    const { run } = require('../spend_pacing_cron/index.js');
    const r = await run(catalyst, { forceEmail: false });
    return res.json({ ok: true, asOf: r.asOf, rows: r.rowCount, stored: r.stored });
  } catch (e) {
    console.error('Manual refresh failed:', e);
    return res.status(500).json({ error: 'refresh_failed', message: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

module.exports = app;
