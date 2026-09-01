#!/usr/bin/env node
'use strict';
/**
 * Generates each function's catalyst-config.json from its .template.json plus
 * the values in .env.deploy.
 *
 * Catalyst reads function environment variables from
 * `deployment.env_variables` in catalyst-config.json - there is no console UI
 * and no CLI flag for them. That file would therefore carry the GCP service
 * account key, so the generated configs are gitignored and only the templates
 * are committed.
 *
 *   node scripts/prepare-deploy.js
 *   catalyst deploy
 *
 * GCP_SERVICE_ACCOUNT_KEY_FILE in .env.deploy points at the downloaded JSON
 * key; its contents are inlined as GCP_SERVICE_ACCOUNT_JSON.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.deploy');
const FUNCTIONS = ['spend_pacing_cron', 'spend_data'];

// Passed to both functions. Anything not listed here is ignored.
const SHARED_KEYS = [
  'GCP_SERVICE_ACCOUNT_JSON',
  'BQ_PROJECT_ID', 'BQ_DATASET_GOOGLE', 'BQ_DATASET_BING', 'BQ_MCC', 'BQ_LOCATION',
  'FX_INR_PER_USD', 'FX_FALLBACK',
  'RECENT_WINDOW_DAYS', 'CACHE_TTL_HOURS', 'AS_OF',
  'MAIL_FROM', 'MAIL_TO', 'MAIL_CC', 'MAIL_DISPLAY_NAME', 'EMAIL_DAYS',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE',
  'DASHBOARD_URL', 'REFRESH_TOKEN', 'ALLOWED_ORIGIN',
];

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return null;
  const out = {};
  for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = parseEnvFile(ENV_FILE);
if (!env) {
  console.error(
    `Missing ${path.relative(ROOT, ENV_FILE)}\n\n` +
    `Copy the example and fill it in:\n` +
    `  copy .env.deploy.example .env.deploy\n`
  );
  process.exit(1);
}

// Inline the service account key file if one was pointed at.
if (env.GCP_SERVICE_ACCOUNT_KEY_FILE && !env.GCP_SERVICE_ACCOUNT_JSON) {
  const keyPath = path.isAbsolute(env.GCP_SERVICE_ACCOUNT_KEY_FILE)
    ? env.GCP_SERVICE_ACCOUNT_KEY_FILE
    : path.join(ROOT, env.GCP_SERVICE_ACCOUNT_KEY_FILE);
  if (!fs.existsSync(keyPath)) {
    console.error(`Key file not found: ${keyPath}`);
    process.exit(1);
  }
  // A key inside the repo is one `git add -A` away from being public.
  const rel = path.relative(ROOT, keyPath);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    console.error(
      `\nREFUSING: the service account key is inside the repo:\n` +
      `  ${keyPath}\n\n` +
      `This repo is pushed to GitHub. Move the key outside the project folder\n` +
      `(e.g. keep it in Downloads) and point GCP_SERVICE_ACCOUNT_KEY_FILE at it.\n`
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(keyPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`Key file is not valid JSON: ${keyPath}`);
    process.exit(1);
  }
  if (parsed.type !== 'service_account') {
    console.error(`Key file is not a service account key (type="${parsed.type}")`);
    process.exit(1);
  }
  // Minified, so it survives as a single JSON string value.
  env.GCP_SERVICE_ACCOUNT_JSON = JSON.stringify(parsed);
  console.log(`Inlined key for ${parsed.client_email}`);
}

const missing = ['GCP_SERVICE_ACCOUNT_JSON', 'MAIL_TO'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing required values in .env.deploy: ${missing.join(', ')}`);
  process.exit(1);
}
if (!env.MAIL_FROM) {
  console.warn('WARNING: MAIL_FROM not set - the digest will fail to send.');
  console.warn('         Verify a sender in Catalyst > Mail (IN datacenter) first.\n');
}

const vars = {};
for (const k of SHARED_KEYS) if (env[k]) vars[k] = env[k];

for (const fn of FUNCTIONS) {
  const dir = path.join(ROOT, 'functions', fn);
  const tpl = path.join(dir, 'catalyst-config.template.json');
  const out = path.join(dir, 'catalyst-config.json');
  if (!fs.existsSync(tpl)) {
    console.error(`Template missing: ${path.relative(ROOT, tpl)}`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(tpl, 'utf8'));
  cfg.deployment.env_variables = { ...(cfg.deployment.env_variables || {}), ...vars };
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`wrote functions/${fn}/catalyst-config.json  (${Object.keys(vars).length} env vars)`);
}

const MASK = new Set(['GCP_SERVICE_ACCOUNT_JSON', 'SMTP_PASS', 'REFRESH_TOKEN']);
const shown = Object.keys(vars)
  .map((k) => (MASK.has(k) ? `${k}=<${vars[k].length} chars, hidden>` : `${k}=${vars[k]}`));
console.log(`\n${shown.join('\n')}`);
// Guard: the deployed client must match the built dashboard. Drifting between
// scratchpad and client/ has already shipped a stale build once.
const clientPath = path.join(ROOT, 'client', 'index.html');
if (fs.existsSync(clientPath)) {
  const kb = (fs.statSync(clientPath).size / 1024).toFixed(1);
  const age = Math.round((Date.now() - fs.statSync(clientPath).mtimeMs) / 60000);
  console.log(`\nclient/index.html: ${kb} KB, built ${age} min ago`);
} else {
  console.warn('\nWARNING: client/index.html is missing — the dashboard will not deploy.');
}
console.log('\nReady. Now run:  catalyst deploy');
