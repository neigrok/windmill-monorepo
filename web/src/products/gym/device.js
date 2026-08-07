// WHAT THIS DEVICE REMEMBERS ABOUT THE LOG, and the one place the two keys it is remembered under
// are spelled. The logger writes both while a workout runs — where the lifter is standing
// (logger/useLiveSession.js) and the sets that have not reached the log yet (logger/flushQueue.js).
//
// It is its own module so that a surface which only wants to ASK can ask cheaply. The /app home
// cell is drawn in the first frame after sign-in, and importing the logger's hook to learn one
// fact would pull the api client, the ladder, the prefill and the rest clock into that frame
// with it.

export const LIVE_KEY = 'windmill.gym.live';
export const QUEUE_KEY = 'windmill.gym.queue';

// Whether a workout was left open ON THIS DEVICE — a claim about this browser's own note and
// nothing else. The server may have auto-closed that session hours ago (the four-hour rule) and
// this cannot know; opening the log is what settles it. So every sentence built on this answer is
// about where the lifter left off, never about what the log currently holds.
//
// The typecheck is the identity field alone, and it is the same field the logger's own door
// refuses to repair (readLive): a blob that cannot name its session names no session, whatever
// else survived in it. Everything past the id — the movement list, the dial, the rest clock — is
// the logger's business and none of this one's.
export function openSessionOnThisDevice(store = window.localStorage) {
  try {
    const stored = JSON.parse(store.getItem(LIVE_KEY));
    if (typeof stored?.sessionId !== 'string' || stored.sessionId === '') return null;
    return stored.sessionId;
  } catch {
    return null;
  }
}
