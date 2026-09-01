'use strict';
/**
 * Delivery schedule, editable from the dashboard.
 *
 * Stored in Catalyst Cache so the cron and the UI share one source of truth.
 * The cron still runs DAILY — this only decides whether today is a send day.
 * If nothing has been saved, it falls back to the EMAIL_DAYS env var.
 *
 *   { enabled, cadence: 'weekly'|'monthly'|'quarterly',
 *     days: ['MON'], dayOfMonth: 1, recipients: 'a@x.com,b@x.com' }
 */

const CACHE_KEY = 'spend_pacing_schedule';
// Catalyst rejects anything outside 1-48. The daily cron calls touch() on every
// run, so the schedule stays alive indefinitely; it only reverts to the
// EMAIL_DAYS default if the cron fails to run for two days straight.
const TTL_HOURS = 48;

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const QUARTER_START_MONTHS = [0, 3, 6, 9]; // Jan, Apr, Jul, Oct

/** Catalyst cron runs in UTC; the business day is IST. */
function istParts(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return {
    day: DAY_NAMES[ist.getUTCDay()],
    dayOfMonth: ist.getUTCDate(),
    month: ist.getUTCMonth(),
    iso: ist.toISOString().slice(0, 10),
  };
}

function defaults() {
  const cfg = (process.env.EMAIL_DAYS || 'MON').toUpperCase().trim();
  if (cfg === 'NEVER') return { enabled: false, cadence: 'weekly', days: [], dayOfMonth: 1, recipients: '' };
  if (cfg === 'DAILY') {
    return { enabled: true, cadence: 'weekly', days: [...DAY_NAMES], dayOfMonth: 1, recipients: '' };
  }
  return {
    enabled: true,
    cadence: 'weekly',
    days: cfg.split(',').map((s) => s.trim()).filter((d) => DAY_NAMES.includes(d)),
    dayOfMonth: 1,
    recipients: '',
  };
}

function normalise(input) {
  const d = defaults();
  if (!input || typeof input !== 'object') return d;
  const cadence = ['weekly', 'monthly', 'quarterly'].includes(input.cadence) ? input.cadence : d.cadence;
  const days = Array.isArray(input.days)
    ? input.days.map((x) => String(x).toUpperCase()).filter((x) => DAY_NAMES.includes(x))
    : d.days;
  let dayOfMonth = Number(input.dayOfMonth);
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) dayOfMonth = d.dayOfMonth;
  return {
    enabled: input.enabled !== false,
    cadence,
    days: cadence === 'weekly' && !days.length ? ['MON'] : days,
    dayOfMonth,
    recipients: typeof input.recipients === 'string' ? input.recipients.trim() : d.recipients,
    updatedAt: input.updatedAt || new Date().toISOString(),
    // IST date of the last successful send, so a cron that fires more than
    // once a day still only mails once.
    lastSent: typeof input.lastSent === 'string' ? input.lastSent : null,
  };
}

/** Is today a send day under this schedule? */
function isSendDay(schedule, now = new Date()) {
  const s = normalise(schedule);
  if (!s.enabled) return false;
  const t = istParts(now);
  if (s.cadence === 'weekly') return s.days.includes(t.day);
  if (s.cadence === 'monthly') return t.dayOfMonth === s.dayOfMonth;
  if (s.cadence === 'quarterly') {
    return QUARTER_START_MONTHS.includes(t.month) && t.dayOfMonth === s.dayOfMonth;
  }
  return false;
}

/** Human summary, e.g. "Weekly on Mon, Thu". */
function describe(schedule) {
  const s = normalise(schedule);
  if (!s.enabled) return 'Alerts are not being emailed';
  const nice = (d) => d.charAt(0) + d.slice(1).toLowerCase();
  if (s.cadence === 'weekly') {
    if (s.days.length === 7) return 'Emailed daily';
    return `Emailed weekly on ${s.days.map(nice).join(', ')}`;
  }
  const ord = (n) => {
    const v = n % 100;
    if (v >= 11 && v <= 13) return `${n}th`;
    return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
  };
  if (s.cadence === 'monthly') return `Emailed monthly on the ${ord(s.dayOfMonth)}`;
  return `Emailed quarterly on the ${ord(s.dayOfMonth)} of Jan, Apr, Jul, Oct`;
}

async function read(catalyst) {
  try {
    const raw = await catalyst.cache().segment().getValue(CACHE_KEY);
    if (raw) return normalise(JSON.parse(raw));
  } catch (e) {
    console.error('Schedule read failed, using defaults:', e.message);
  }
  return defaults();
}

async function write(catalyst, input) {
  const s = normalise({ ...input, updatedAt: new Date().toISOString() });
  const json = JSON.stringify(s);
  const segment = catalyst.cache().segment();
  try {
    await segment.put(CACHE_KEY, json, TTL_HOURS);
  } catch (e) {
    await segment.update(CACHE_KEY, json, TTL_HOURS);
  }
  return s;
}

/**
 * Re-write the schedule to reset its 48h TTL. Called on every cron run so a
 * saved schedule never quietly expires back to the default.
 */
async function touch(catalyst, schedule) {
  try {
    await write(catalyst, schedule);
  } catch (e) {
    console.error('Schedule touch failed (will retry next run):', e.message);
  }
}

/** Already mailed today (IST)? Guards against a cron firing several times a day. */
function alreadySentToday(schedule, now = new Date()) {
  const s = normalise(schedule);
  return !!s.lastSent && s.lastSent === istParts(now).iso;
}

/** Record a successful send against today's IST date. */
async function markSent(catalyst, schedule, now = new Date()) {
  try {
    await write(catalyst, { ...normalise(schedule), lastSent: istParts(now).iso });
  } catch (e) {
    console.error('Could not record last-sent date:', e.message);
  }
}

module.exports = {
  read, write, touch, normalise, defaults, isSendDay, describe, istParts,
  alreadySentToday, markSent,
  DAY_NAMES, CACHE_KEY, TTL_HOURS,
};
