// School-local date helpers for screens. The server re-validates every date; these only pick defaults.
import { schoolDateOf, localToUtc } from '../../../src/shared/time.js';

export function schoolTz(app) {
  return (app.publicConfig && app.publicConfig.timezone) || 'Asia/Bangkok';
}

/** Today's school date (YYYY-MM-DD) in the school timezone, not the device timezone. */
export function todayLocal(app) {
  return schoolDateOf(new Date().toISOString(), schoolTz(app));
}

/** Combine a school date and HH:MM (school timezone) into an ISO UTC timestamp. */
export function localTimestamp(app, date, hhmm) {
  return localToUtc(date, hhmm, schoolTz(app));
}
