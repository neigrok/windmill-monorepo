export const OFFLINE_GRACE_MS = 3000;
export const SAVING_DELAY_MS = 300;
export const SAVED_HOLD_MS = 2000;

export function deriveSyncStatus(snapshot, now, { lastLiveAt, pendingSince, drainedAt }) {
  if (!snapshot.online) return 'offline';
  if (snapshot.phase !== 'live' && now - lastLiveAt >= OFFLINE_GRACE_MS) return 'offline';
  if (snapshot.refused) return null;
  const pending = snapshot.structurePending + snapshot.progressPending
    + snapshot.structureInFlight + snapshot.progressInFlight;
  if (pending > 0) {
    if (pendingSince != null && now - pendingSince >= SAVING_DELAY_MS) return 'saving';
    return null;
  }
  if (snapshot.phase === 'live' && drainedAt != null && now - drainedAt < SAVED_HOLD_MS) return 'saved';
  return null;
}
