'use strict';
/**
 * Advanced I/O function — serves the pacing payload to the dashboard.
 *
 *   GET  /data      cached payload; rebuilds from BigQuery on a cache miss
 *   POST /refresh   force a rebuild now (guarded by X-Refresh-Token)
 *   GET  /health    liveness
 *
 * lib/ is a COPY of spend_pacing_cron/lib — Catalyst bundles each function
 * separately, so a function can only require files inside its own directory.
 * Run `node scripts/sync-lib.js` before deploying to keep the copies identical.
 */

const express = require('express');
const catalystSDK = require('zcatalyst-sdk-node');
const {
  buildPayload, cachePayload, readCachedPayload,
} = require('./lib/payload');
const schedule = require('./lib/schedule');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Refresh-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

async function rebuild(catalyst) {
  const { payload } = await buildPayload(catalyst);
  await cachePayload(catalyst, payload);
  return payload;
}

app.get('/data', async (req, res) => {
  const catalyst = catalystSDK.initialize(req);
  try {
    let payload = await readCachedPayload(catalyst);
    let source = 'cache';
    if (!payload) {
      console.log('Cache miss - rebuilding from BigQuery');
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

/* ---- delivery schedule, owned by the dashboard ---------------------- */

app.get('/schedule', async (req, res) => {
  const catalyst = catalystSDK.initialize(req);
  try {
    const s = await schedule.read(catalyst);
    return res.json({ ...s, summary: schedule.describe(s), mailFrom: !!process.env.MAIL_FROM });
  } catch (e) {
    console.error('/schedule read failed:', e);
    return res.status(500).json({ error: 'read_failed', message: e.message });
  }
});

app.post('/schedule', async (req, res) => {
  const catalyst = catalystSDK.initialize(req);
  try {
    const s = await schedule.write(catalyst, req.body || {});
    return res.json({ ok: true, ...s, summary: schedule.describe(s) });
  } catch (e) {
    console.error('/schedule write failed:', e);
    return res.status(500).json({ error: 'write_failed', message: e.message });
  }
});

/** Send the digest right now, to confirm delivery works. */
app.post('/send-test', async (req, res) => {
  const catalyst = catalystSDK.initialize(req);
  if (!process.env.MAIL_FROM) {
    return res.status(503).json({
      error: 'no_sender',
      message: 'MAIL_FROM is not set. Verify a sender in Catalyst > Mail, then redeploy.',
    });
  }
  try {
    const { run } = require('./lib/runner');
    const r = await run(catalyst, { forceEmail: true, recipients: (req.body || {}).recipients });
    if (r.mailError) return res.status(500).json({ error: 'send_failed', message: r.mailError });
    return res.json({ ok: true, sentTo: r.sentTo, subject: r.subject, asOf: r.asOf });
  } catch (e) {
    console.error('/send-test failed:', e);
    return res.status(500).json({ error: 'send_failed', message: e.message });
  }
});

/** Diagnose mail delivery without sending anything. */
app.get('/mail-status', async (req, res) => {
  const { smtp } = require('./lib/email');
  const out = {
    mailFrom: process.env.MAIL_FROM || null,
    smtpConfigured: smtp.available(),
    catalystMailConfigured: !!process.env.MAIL_FROM,
  };
  if (out.smtpConfigured) {
    const cfg = smtp.config();
    out.smtp = { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.auth.user };
    out.smtpVerify = await smtp.verify();   // opens a connection and authenticates
  }
  out.transport = out.smtpConfigured ? 'smtp (Catalyst Mail as fallback)' : 'catalyst mail';
  return res.json(out);
});

app.get('/health', (req, res) => res.json({ ok: true }));

module.exports = app;
