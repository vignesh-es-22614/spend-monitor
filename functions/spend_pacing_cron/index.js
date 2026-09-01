'use strict';
/**
 * Catalyst Cron — SEM spend pacing.
 *
 * Runs DAILY. Every run refreshes the cached payload; the email goes out only
 * on days the saved schedule says to send. The schedule is owned by the
 * dashboard (Alerts panel) and stored in Catalyst Cache, falling back to the
 * EMAIL_DAYS env var when nothing has been saved.
 *
 * The work itself lives in lib/runner.js so the spend_data function can share
 * it — Catalyst bundles each function separately.
 */

const catalystSDK = require('zcatalyst-sdk-node');
const { run } = require('./lib/runner');
const scheduleLib = require('./lib/schedule');

module.exports = async (cronDetails, context) => {
  const catalyst = catalystSDK.initialize(context);
  try {
    const r = await run(catalyst);
    console.log(
      `Refreshed ${r.rowCount} rows through ${r.asOf} ` +
      `(google=${r.perEngine.google} bing=${r.perEngine.bing}) ` +
      `FX ${r.fx.rate} via ${r.fx.source} ` +
      `cached ${r.stored.bytes} bytes (raw ${r.stored.rawBytes}). ` +
      (r.emailing
        ? (r.mailError ? `EMAIL FAILED: ${r.mailError}` : `Emailed "${r.subject}" to ${r.sentTo.join(', ')}`)
        : r.dupe
          ? `Already emailed today — skipping. ${scheduleLib.describe(r.schedule)}.`
          : `Not a send day. ${scheduleLib.describe(r.schedule)}.`)
    );
    if (r.emailing && r.mailError) return context.closeWithFailure();
    context.closeWithSuccess();
  } catch (err) {
    console.error('spend_pacing_cron failed:', err);
    context.closeWithFailure();
  }
};

module.exports.run = run;
