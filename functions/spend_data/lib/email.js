'use strict';
/**
 * Builds the HTML digest and sends it through Catalyst Mail.
 * Table styling is inline — Gmail and Outlook strip <style> blocks.
 */

const { PRODUCTS, QUARTER } = require('./config');
const { rollup, pct, money } = require('./pacing');
const smtp = require('./smtp');

const INK = '#101920', INK2 = '#46555E', INK3 = '#76848D';
const EDGE = '#D2DAE1', SOFT = '#F7F9FB';
const OVER = '#A73232', WATCH = '#9A680D', GOOD = '#1A7F4F';

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const usd = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);

/**
 * Used% is only meaningful next to the benchmark: 87% spent is alarming two
 * thirds through a quarter and unremarkable at the end. Matches the ratio
 * bands the dashboard uses so the two never disagree.
 */
function usedColour(p, benchPct) {
  if (p === null || p === undefined) return INK3;
  if (!(benchPct > 0)) return INK3;
  const r = p / benchPct;
  if (r > 1.05) return OVER;
  if (r < 0.90) return WATCH;
  return GOOD;
}

/**
 * A projection is judged against 100, not against the clock. The old shared
 * helper marked a perfect 100% projection amber and a 50% one green.
 */
function projColour(p) {
  if (p === null || p === undefined) return INK3;
  if (p > 105) return OVER;
  if (p < 95) return WATCH;
  return GOOD;
}

function section(title, items, colour) {
  if (!items.length) return '';
  const lis = items.map((t) =>
    `<li style="margin:0 0 6px;line-height:1.5;color:${INK2}">${esc(t)}</li>`).join('');
  return `
    <tr><td style="padding:16px 24px 0">
      <div style="font:700 13px/1.3 Arial,sans-serif;color:${colour};
                  text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">${esc(title)}</div>
      <ul style="margin:0;padding-left:18px;font:400 13px/1.5 Arial,sans-serif">${lis}</ul>
    </td></tr>`;
}

function tableRows(metrics, bench) {
  let html = '';
  const row = (label, m, opts = {}) => {
    const { bold = false, indent = 0, bg = '#FFFFFF' } = opts;
    const w = bold ? '700' : '400';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid ${EDGE};background:${bg};
                 font:${w} 12px/1.4 Arial,sans-serif;color:${INK};padding-left:${10 + indent * 14}px">${esc(label)}</td>
      <td align="right" style="padding:6px 10px;border-bottom:1px solid ${EDGE};background:${bg};
                 font:${w} 12px/1.4 'Courier New',monospace;color:${INK}">${usd(m.budget.total)}</td>
      <td align="right" style="padding:6px 10px;border-bottom:1px solid ${EDGE};background:${bg};
                 font:${w} 12px/1.4 'Courier New',monospace;color:${INK}">${usd(m.spend.total)}</td>
      <td align="right" style="padding:6px 10px;border-bottom:1px solid ${EDGE};background:${bg};
                 font:700 12px/1.4 'Courier New',monospace;color:${usedColour(m.used, bench.fraction * 100)}">${pct(m.used)}</td>
      <td align="right" style="padding:6px 10px;border-bottom:1px solid ${EDGE};background:${bg};
                 font:700 12px/1.4 'Courier New',monospace;color:${projColour(m.projected)}">${pct(m.projected)}</td>
      <td align="right" style="padding:6px 10px;border-bottom:1px solid ${EDGE};background:${bg};
                 font:${w} 12px/1.4 'Courier New',monospace;color:${m.over > 0 ? OVER : INK2}">${money(m.over)}</td>
    </tr>`;
  };

  for (const bu of ['IDM', 'SIEM']) {
    const inBu = PRODUCTS.filter((p) => p.bu === bu);
    html += row(bu, rollup(inBu.map((p) => p.code), metrics, bench), { bold: true, bg: '#EEF2F5' });
    for (const grp of [...new Set(inBu.map((p) => p.grp))]) {
      const inG = inBu.filter((p) => p.grp === grp);
      html += row(grp, rollup(inG.map((p) => p.code), metrics, bench), { bold: true, indent: 1, bg: SOFT });
      for (const p of inG) html += row(p.code, metrics[p.code], { indent: 2 });
    }
  }
  const total = rollup(PRODUCTS.map((p) => p.code), metrics, bench);
  html += `<tr>
    <td style="padding:8px 10px;background:${INK};font:700 12px/1.4 Arial,sans-serif;color:#fff">Total</td>
    <td align="right" style="padding:8px 10px;background:${INK};font:700 12px/1.4 'Courier New',monospace;color:#fff">${usd(total.budget.total)}</td>
    <td align="right" style="padding:8px 10px;background:${INK};font:700 12px/1.4 'Courier New',monospace;color:#fff">${usd(total.spend.total)}</td>
    <td align="right" style="padding:8px 10px;background:${INK};font:700 12px/1.4 'Courier New',monospace;color:#fff">${pct(total.used)}</td>
    <td align="right" style="padding:8px 10px;background:${INK};font:700 12px/1.4 'Courier New',monospace;color:#fff">${pct(total.projected)}</td>
    <td align="right" style="padding:8px 10px;background:${INK};font:700 12px/1.4 'Courier New',monospace;color:#fff">${money(total.over)}</td>
  </tr>`;
  return html;
}

/** The "how did last week/month actually go" block, above the outlook. */
function periodBlock(period) {
  if (!period || !period.products.length) return '';
  const heading = period.kind === 'quarter'
    ? `${period.label}`
    : `${period.label}${period.partial ? ` — so far (${period.elapsed} of ${period.totalDays} days)` : ''}`;

  const t = period.total;
  const tone = t.used === null ? INK2 : t.used > 110 ? OVER : t.used < 90 ? WATCH : GOOD;

  const line = (p) => {
    const c = p.used > 110 ? OVER : p.used < 90 ? WATCH : GOOD;
    const word = p.delta >= 0 ? 'over' : 'under';
    return `<li style="margin:0 0 5px;line-height:1.5;color:${INK2}">
      <b style="color:${INK}">${esc(p.code)}</b>: <span style="color:${c};font-weight:700">${pct(p.used)}</span>
      — ${usd(p.spend)} of ${usd(p.budget)}, ${money(Math.abs(p.delta))} ${word}</li>`;
  };

  const notable = [...period.over, ...period.under].slice(0, 8);
  const body = notable.length
    ? `<ul style="margin:8px 0 0;padding-left:18px;font:400 13px/1.5 Arial,sans-serif">
         ${notable.map(line).join('')}</ul>`
    : `<div style="font:400 13px/1.5 Arial,sans-serif;color:${INK2};margin-top:6px">
         Every product within 10% of its budget for this period.</div>`;

  return `<tr><td style="padding:16px 24px 0">
    <div style="border:1px solid ${EDGE};border-radius:8px;padding:14px 16px;background:${SOFT}">
      <div style="font:700 13px/1.3 Arial,sans-serif;color:${INK};text-transform:uppercase;letter-spacing:.05em">
        ${esc(heading)}</div>
      <div style="font:400 13px/1.5 Arial,sans-serif;color:${INK2};margin-top:6px">
        <b style="color:${tone};font-size:15px">${pct(t.used)}</b> of budget —
        ${usd(t.spend)} against ${usd(t.budget)},
        <b style="color:${tone}">${money(Math.abs(t.delta))} ${t.delta >= 0 ? 'over' : 'under'}</b>
      </div>
      ${body}
    </div>
  </td></tr>`;
}

/**
 * Recent periods at the cadence's granularity. One number with no series
 * behind it cannot tell you whether this window is a blip or the trend.
 */
function trendBlock(trend, kind) {
  if (!trend || trend.length < 2) return '';
  const head = (t) => `<th align="right" style="padding:6px 10px;background:${SOFT};
    border-bottom:2px solid ${EDGE};font:700 10px/1.3 Arial,sans-serif;color:${INK3};
    text-transform:uppercase;letter-spacing:.06em">${t}</th>`;
  const rows = trend.map((r) => {
    // A part-finished period has no meaningful used%, so leave it uncoloured.
    const colour = r.partial ? INK3 : usedColour(r.used, 100);
    return `<tr>
      <td style="padding:5px 10px;border-bottom:1px solid ${EDGE};
        font:400 12px/1.4 Arial,sans-serif;color:${INK}">${esc(r.label)}${
  r.partial ? `<span style="color:${INK3}"> (partial)</span>` : ''}</td>
      <td align="right" style="padding:5px 10px;border-bottom:1px solid ${EDGE};
        font:400 12px/1.4 'Courier New',monospace;color:${INK2}">${usd(r.budget)}</td>
      <td align="right" style="padding:5px 10px;border-bottom:1px solid ${EDGE};
        font:400 12px/1.4 'Courier New',monospace;color:${INK}">${usd(r.spend)}</td>
      <td align="right" style="padding:5px 10px;border-bottom:1px solid ${EDGE};
        font:700 12px/1.4 'Courier New',monospace;color:${colour}">${pct(r.used)}</td>
    </tr>`;
  }).join('');
  return `<tr><td style="padding:18px 24px 0">
    <div style="font:700 13px/1.3 Arial,sans-serif;color:${INK};text-transform:uppercase;
      letter-spacing:.06em;margin-bottom:8px">Trend — last ${trend.length} ${
  kind === 'week' ? 'weeks' : 'months'}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr>${head('Period')}${head('Budget')}${head('Spend')}${head('Used')}</tr>
      ${rows}
    </table></td></tr>`;
}

function buildHtml({ metrics, bench, insights, asOf, dashboardUrl, period, trend }) {
  const th = (t, align = 'right') =>
    `<th align="${align}" style="padding:8px 10px;background:${SOFT};border-bottom:2px solid ${EDGE};
      font:700 10px/1.3 Arial,sans-serif;color:${INK3};text-transform:uppercase;letter-spacing:.06em">${t}</th>`;

  const banner = insights.over.length
    ? `<div style="background:#F8DEDE;border-radius:6px;padding:10px 14px;font:400 13px/1.5 Arial,sans-serif;color:${INK}">
         <b style="color:${OVER}">${insights.over.length} product${insights.over.length === 1 ? '' : 's'} projected over budget.</b>
         Total is tracking at ${pct(insights.total.projected)} of plan.
       </div>`
    : `<div style="background:#DDF1E5;border-radius:6px;padding:10px 14px;font:400 13px/1.5 Arial,sans-serif;color:${INK}">
         <b style="color:${GOOD}">Nothing projected over budget.</b> Total tracking at ${pct(insights.total.projected)} of plan.
       </div>`;

  return `<!doctype html><html><body style="margin:0;background:#EDF0F3">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#EDF0F3;padding:20px 0">
<tr><td align="center">
<table width="720" cellpadding="0" cellspacing="0" style="max-width:720px;background:#fff;border:1px solid ${EDGE};border-radius:10px">

  <tr><td style="padding:22px 24px 4px">
    <div style="font:700 10px/1.3 Arial,sans-serif;color:${INK3};text-transform:uppercase;letter-spacing:.14em">
      IT Security &amp; Online Marketing &middot; SEM</div>
    <div style="font:800 22px/1.2 Arial,sans-serif;color:${INK};margin-top:6px">Spend Pacing &mdash; ${esc(QUARTER.label)}</div>
    <div style="font:400 12px/1.4 'Courier New',monospace;color:${INK3};margin-top:5px">
      US-targeted campaigns &middot; USD &middot; data through ${esc(asOf)}<br>
      Benchmark ${(bench.fraction * 100).toFixed(1)}% &mdash; ${bench.elapsed} of ${bench.total} days elapsed
    </div>
  </td></tr>

  <tr><td style="padding:14px 24px 0">${banner}</td></tr>

  ${periodBlock(period)}

  ${trendBlock(trend, period && period.kind === 'week' ? 'week' : 'month')}

  ${section('Quarter outlook — overspending', insights.lines.overspending, OVER)}
  ${section('On track', insights.lines.onTrack, GOOD)}
  ${section('Under-pacing', insights.lines.underPacing, WATCH)}
  ${section('Rollups', insights.lines.rollups, INK2)}
  ${section('Flag', insights.lines.flags, '#5B4A96')}

  <tr><td style="padding:20px 24px 0">
    <div style="font:700 13px/1.3 Arial,sans-serif;color:${INK};margin-bottom:8px">By product</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr>${th('Product', 'left')}${th('Budget')}${th('Spend')}${th('Used')}${th('Projected')}${th('Over / under')}</tr>
      ${tableRows(metrics, bench)}
    </table>
  </td></tr>

  <tr><td style="padding:18px 24px 22px">
    ${dashboardUrl ? `<a href="${esc(dashboardUrl)}" style="display:inline-block;background:${INK};color:#fff;
       text-decoration:none;padding:10px 16px;border-radius:6px;font:700 13px Arial,sans-serif">Open the dashboard</a>` : ''}
    <div style="font:400 11px/1.7 'Courier New',monospace;color:${INK3};margin-top:16px;border-top:1px solid ${EDGE};padding-top:12px">
      Projected = spend to date + (average daily spend over the last ${bench.windowDays} days
      &times; ${bench.remaining} days left in the quarter). Benchmark is calendar position only.<br>
      Source: Google Ads Data Transfer + Bing keyword export, reconciled to the weekly workbook within 0.1%.
    </div>
  </td></tr>

</table></td></tr></table></body></html>`;
}

function buildText({ insights, bench, asOf, period, trend }) {
  const rule = '-'.repeat(62);
  let s = `SEM SPEND PACING — ${QUARTER.label}\n`;
  s += `US-targeted campaigns · USD · data through ${asOf}\n`;
  s += `Benchmark ${(bench.fraction * 100).toFixed(1)}% (${bench.elapsed} of ${bench.total} days)\n`;
  s += `${'='.repeat(62)}\n\n`;
  const block = (title, items) => {
    if (!items.length) return '';
    return `${title}\n${rule}\n${items.map((i) => `  * ${i}`).join('\n')}\n\n`;
  };

  if (period && period.products.length) {
    const t = period.total;
    const head = period.kind === 'quarter'
      ? period.label
      : `${period.label}${period.partial ? ` (so far, ${period.elapsed} of ${period.totalDays} days)` : ''}`;
    const rows = [
      `All products: ${pct(t.used)} — ${usd(t.spend)} of ${usd(t.budget)}, `
        + `${money(Math.abs(t.delta))} ${t.delta >= 0 ? 'over' : 'under'}`,
      ...[...period.over, ...period.under].slice(0, 8).map((p) =>
        `${p.code}: ${pct(p.used)} — ${usd(p.spend)} of ${usd(p.budget)}, `
        + `${money(Math.abs(p.delta))} ${p.delta >= 0 ? 'over' : 'under'}`),
    ];
    s += block(head.toUpperCase(), rows);
  }

  if (trend && trend.length > 1) {
    const pad = (v, w) => String(v).padStart(w);
    const kind = period && period.kind === 'week' ? 'WEEKS' : 'MONTHS';
    s += `TREND — LAST ${trend.length} ${kind}\n${rule}\n`;
    s += `  ${'Period'.padEnd(18)}${pad('Budget', 11)}${pad('Spend', 11)}${pad('Used', 7)}\n`;
    for (const r of trend) {
      s += `  ${(r.label + (r.partial ? ' *' : '')).padEnd(18)}`
        + `${pad(usd(r.budget), 11)}${pad(usd(r.spend), 11)}${pad(pct(r.used), 7)}\n`;
    }
    if (trend.some((r) => r.partial)) s += '  * partial period\n';
    s += '\n';
  }

  s += block('QUARTER OUTLOOK — OVERSPENDING', insights.lines.overspending);
  s += block('ON TRACK', insights.lines.onTrack);
  s += block('UNDER-PACING', insights.lines.underPacing);
  s += block('ROLLUPS', insights.lines.rollups);
  s += block('FLAG', insights.lines.flags);
  s += `Projected = spend to date + (average daily spend over the last\n`;
  s += `            ${bench.windowDays} days x ${bench.remaining} days remaining in the quarter).\n`;
  s += `Benchmark ${(bench.fraction * 100).toFixed(1)}% is calendar position only.\n`;
  return s;
}

/**
 * Sends the digest.
 *
 * SMTP is tried first when configured, because Catalyst Mail refuses to send
 * from zohocorp.com until the DOMAIN is verified via DNS — which we can't do.
 * Catalyst Mail remains the fallback so this keeps working if the domain is
 * verified later, or if SMTP credentials are rotated out.
 *
 * ICatalystMail (SDK v3) accepts exactly:
 *   from_email, to_email, subject, content, cc, bcc, reply_to,
 *   html_mode, display_name, attachments
 * There is no plain-text field — `content` carries the HTML and
 * `html_mode: true` tells Catalyst to render it.
 */
async function sendViaCatalyst(catalyst, { to, cc: ccIn, subject, html }) {
  const from = process.env.MAIL_FROM;
  if (!from) throw new Error('MAIL_FROM is not set (must be a Catalyst-verified sender)');
  if (!catalyst) throw new Error('Catalyst SDK unavailable');
  const recipients = (Array.isArray(to) ? to : String(to).split(','))
    .map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) throw new Error('No recipients');

  const mail = {
    from_email: from,
    to_email: recipients,
    subject,
    content: html,
    html_mode: true,
  };
  if (process.env.MAIL_DISPLAY_NAME) mail.display_name = process.env.MAIL_DISPLAY_NAME;
  const cc = ccIn
    ? (Array.isArray(ccIn) ? ccIn : String(ccIn).split(','))
      .map((s) => s.trim()).filter(Boolean)
    : (process.env.MAIL_CC || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (cc.length) mail.cc = cc;

  await catalyst.email().sendMail(mail);
  return recipients;
}

async function send(catalyst, { to, cc: ccIn, subject, html }) {
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
    .map((s) => s.trim()).filter(Boolean);

  const recipients = list(to);
  if (!recipients.length) throw new Error('No recipients configured');

  // An explicit cc (from alerts.config.json) wins; MAIL_CC is the fallback.
  const ccList = ccIn ? list(ccIn) : list(process.env.MAIL_CC);
  const cc = ccList.length ? ccList : undefined;

  if (smtp.available()) {
    try {
      const r = await smtp.send({
        from: process.env.MAIL_FROM,
        to: recipients,
        subject,
        html,
        cc,
        displayName: process.env.MAIL_DISPLAY_NAME,
      });
      console.log(`Sent via SMTP to ${r.sentTo.join(', ')} (${r.messageId})`);
      return r.sentTo;
    } catch (e) {
      console.error('SMTP send failed, trying Catalyst Mail:', e.message);
    }
  }

  const sent = await sendViaCatalyst(catalyst, { to: recipients, cc, subject, html });
  console.log(`Sent via Catalyst Mail to ${sent.join(', ')}`);
  return sent;
}

module.exports = { buildHtml, buildText, send, sendViaCatalyst, smtp };
