// Reminders' client half: the weekly nudge's one preference, read and written. The GET tells the
// settings section everything it can say honestly — whether a reminder could actually reach this
// account (`armed`: the engine is on AND this caller is inside its rollout), whether this person
// asked for one (`enabled`), the slot it would land in, and the timezone the server holds.
// A null read means there is simply nothing to show (dark server, signed out, or the read failed),
// and the section renders nothing rather than an error.
//
// The timezone is the one thing this file is strict about. The server never marks a user due
// without an IANA zone, so an enable that cannot name one would save a switch that reads "on" and
// sends nothing — reminderPatch refuses to build that request, and the section says so plainly.
// The zone therefore travels with the enable, and at no other moment.

import { API_BASE } from '../../../shell/apiBase.js';

export async function fetchReminders() {
  try {
    const response = await fetch(`${API_BASE}/v1/reminders`, { credentials: 'include' });
    if (!response.ok) return null;
    // { armed, enabled, timezone, slotDow, slotMinute, suppressed }. `suppressed` is set by Resend's
    // delivery webhook after a hard bounce or a spam complaint — never by anything the reader did —
    // and the section renders its own face when it is true.
    return await response.json();
  } catch {
    return null;
  }
}

// True on the 204, false on anything else — a lapsed session, a dark server, a brick. The caller
// shows one honest "couldn't save" line for all of them, because to a reader they are one thing.
export async function saveReminders(patch) {
  try {
    const response = await fetch(`${API_BASE}/v1/reminders`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// This browser's IANA zone, or '' when the runtime won't name one.
export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

// The body of a PATCH. Switching off needs nothing but the flag; switching on carries the zone,
// and null means "this request is not worth sending" — the only honest answer when we can't name
// one, since the server would file the row as enabled-but-never-due.
export function reminderPatch(enabled, timezone) {
  if (!enabled) return { enabled: false };
  const zone = (timezone ?? '').trim();
  if (!zone) return null;
  return { enabled: true, timezone: zone };
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// The slot in words: "Tuesdays around 9am". slotDow is 1=Mon..7=Sun and slotMinute is minutes
// past local midnight, both straight off the wire — anything outside those ranges falls back to
// the standing slot rather than rendering a blank or a NaN into the sentence.
export function describeSchedule({ slotDow, slotMinute }) {
  const day = DAY_NAMES[slotDow - 1] ?? 'Tuesday';
  const minutes = Number.isInteger(slotMinute) && slotMinute >= 0 && slotMinute < 1440 ? slotMinute : 540;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour < 12 ? 'am' : 'pm';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  const clock = minute === 0 ? `${twelve}${suffix}` : `${twelve}:${String(minute).padStart(2, '0')}${suffix}`;
  return `${day}s around ${clock}`;
}
