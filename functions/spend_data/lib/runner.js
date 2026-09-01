'use strict';
/**
 * One refresh cycle: query, cache, decide whether to email, send.
 *
 * Lives in lib/ so both the cron and the spend_data "send test" endpoint can
 * call it — Catalyst bundles each function separately, so cross-function
 * requires are impossible.
 */

const { QUARTER } = require('./config');
const { pct } = require('./pacing');
const { buildPayload, cachePayload } = require('./payload');
const { buildHtml, buildText, send } = require('./email');
const scheduleLib = require('./schedule');
const periodLib = require('./period');

/**
 * @param {object} catalyst        initialised SDK (null for a local dry run)
 * @param {object} opts
 * @param {boolean} opts.dryRun    build everything, store and send nothing
 * @param {boolean} opts.forceEmail ignore the schedule and send now
 * @param {string}  opts.recipients override the recipient list
 */
async function run(catalyst, { dryRun = false, forceEmail = false, recipients } = {}) {
  const { payload, metrics, bench, insights, asOf, fx, perEngine, rows } =
    await buildPayload(catalyst);

  const stored = dryRun
    ? { cache: false, bytes: JSON.stringify(payload).length }
    : await cachePayload(catalyst, payload);

  const schedule = catalyst ? await scheduleLib.read(catalyst) : scheduleLib.defaults();
  // Cache TTL caps at 48h, so refresh it each run to keep the saved schedule alive.
  if (catalyst && !dryRun) await scheduleLib.touch(catalyst, schedule);

  // A cron set to "every N hours" fires several times a day; only mail once.
  const dupe = !forceEmail && scheduleLib.alreadySentToday(schedule);
  const emailing = forceEmail || (scheduleLib.isSendDay(schedule) && !dupe);
  const to = (recipients && recipients.trim())
    || (schedule.recipients && schedule.recipients.trim())
    || process.env.MAIL_TO;

  // Report the window that matches the delivery cadence — a Monday email is
  // about last week, a month-start email about last month.
  const period = periodLib.report(rows, asOf, schedule.cadence, { fx: fx.rate });

  const subject = insights.over.length
    ? `SEM Spend Pacing — ${period.label} — ${insights.over.length} over budget (Q3 ${pct(insights.total.projected)})`
    : `SEM Spend Pacing — ${period.label} — on plan (Q3 ${pct(insights.total.projected)})`;

  const html = buildHtml({
    metrics, bench, insights, asOf, period,
    dashboardUrl: process.env.DASHBOARD_URL || '',
  });
  const text = buildText({ insights, bench, asOf, period });

  if (dryRun) {
    return { subject, html, text, asOf, bench, insights, stored, emailing, fx, perEngine,
             schedule, period, payload, sentTo: [] };
  }

  let sentTo = [];
  let mailError = null;
  if (emailing) {
    try {
      sentTo = await send(catalyst, { to, subject, html });
      // Only stamp on a real scheduled send — a manual test shouldn't suppress
      // the day's actual digest.
      if (!forceEmail) await scheduleLib.markSent(catalyst, schedule);
    } catch (e) {
      // A mail failure must not fail the refresh — the dashboard is current either way.
      mailError = e.message;
      console.error('Email delivery failed:', e);
    }
  }

  return {
    subject, asOf, bench, insights, stored, emailing, sentTo, mailError,
    fx, perEngine, schedule, dupe, rowCount: payload.rows.length,
  };
}

module.exports = { run };
