'use strict';
/**
 * SMTP delivery, used because Catalyst Mail requires domain-level verification
 * of zohocorp.com — which needs a DNS record we can't add.
 *
 * Zoho Mail SMTP (India DC):
 *   host smtp.zoho.in   port 465 (SSL)  or  587 (STARTTLS)
 *   user  your full address
 *   pass  an APP-SPECIFIC password, not your login password
 *         (Zoho Mail > Settings > Security > App Passwords)
 *
 * Configured entirely through env vars; if SMTP_HOST/USER/PASS are absent this
 * module reports itself unavailable and the caller falls back to Catalyst Mail.
 */

const nodemailer = require('nodemailer');

function config() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    host,
    port,
    // 465 is implicit TLS; 587 upgrades via STARTTLS.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: { user, pass },
  };
}

function available() {
  return config() !== null;
}

/**
 * @returns {Promise<{transport:string, sentTo:string[], messageId:string}>}
 */
async function send({ from, to, subject, html, cc, displayName }) {
  const cfg = config();
  if (!cfg) throw new Error('SMTP is not configured (need SMTP_HOST, SMTP_USER, SMTP_PASS)');

  const recipients = (Array.isArray(to) ? to : String(to).split(','))
    .map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) throw new Error('No recipients');

  const transporter = nodemailer.createTransport({
    ...cfg,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });

  // Most providers reject a From that isn't the authenticated mailbox.
  const fromAddr = from || cfg.auth.user;
  const info = await transporter.sendMail({
    from: displayName ? `"${displayName}" <${fromAddr}>` : fromAddr,
    to: recipients.join(', '),
    cc: cc && cc.length ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
    subject,
    html,
  });

  return { transport: 'smtp', sentTo: recipients, messageId: info.messageId };
}

/** Opens a connection and authenticates without sending — for diagnostics. */
async function verify() {
  const cfg = config();
  if (!cfg) return { ok: false, reason: 'not_configured' };
  try {
    await nodemailer.createTransport({ ...cfg, connectionTimeout: 15000 }).verify();
    return { ok: true, host: cfg.host, port: cfg.port, user: cfg.auth.user };
  } catch (e) {
    return { ok: false, reason: e.message, host: cfg.host, port: cfg.port };
  }
}

module.exports = { send, available, verify, config };
