import { API_BASE } from '../../../shell/apiBase.js';

export async function fetchReminders() {
  try {
    const response = await fetch(`${API_BASE}/v1/reminders`, { credentials: 'include' });
    if (!response.ok) return null;
    // { armed, enabled, timezone, slotDow, slotMinute, suppressed }
    return await response.json();
  } catch {
    return null;
  }
}

// True on the 204, false on anything else.
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

// null means the request is not worth sending: the server would file the row as enabled-but-never-due.
export function reminderPatch(enabled, timezone) {
  if (!enabled) return { enabled: false };
  const zone = (timezone ?? '').trim();
  if (!zone) return null;
  return { enabled: true, timezone: zone };
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// slotDow is 1=Mon..7=Sun and slotMinute is minutes past local midnight; out of range falls back to the standing slot.
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
