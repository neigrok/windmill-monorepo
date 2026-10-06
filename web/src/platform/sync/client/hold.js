// §7.3 hold, release and undo: held entries wait durably for release, and Undo removes a gesture only
// while every entry of it is held, folding its dependents silently.

import { moveEntry } from '../core/machines.js';
import { deltasOf, foldSilently, silentFoldOf } from './dependents.js';

export function release(replica, registry, ended, entry) {
  if (entry.state !== 'held') return false;
  moveEntry(replica, ended, entry, 'release');
  return true;
}

export function releaseAll(replica, registry, ended) {
  for (const entry of replica.entries()) if (entry.state === 'held') release(replica, registry, ended, entry);
}

export function releaseDue(replica, registry, ended, deviceNow) {
  for (const entry of replica.entries()) {
    if (entry.state === 'held' && entry.releaseAt <= deviceNow) release(replica, registry, ended, entry);
  }
}

// The silent fold of the gesture's dependents is planned before its entries end.
export function undo(replica, registry, ended, gestureId) {
  const gesture = replica.entries().filter((entry) => entry.gestureId === gestureId);
  if (gesture.length === 0 || gesture.some((entry) => entry.state !== 'held')) return false;
  const parts = silentFoldOf(replica, registry, gesture.map((entry) => ({ entry, deltas: deltasOf(entry) })));
  for (const entry of gesture) moveEntry(replica, ended, entry, 'undo');
  foldSilently(replica, ended, parts);
  return true;
}

// Held gestures in commit order, with their deadline and records; Undo stands while `releaseAt` is ahead of the device clock.
export function undoOffers(replica, scope) {
  const gestures = new Map();
  for (const entry of replica.entries(scope)) gestures.set(entry.gestureId, [...(gestures.get(entry.gestureId) ?? []), entry]);
  return [...gestures.values()].filter((entries) => entries.every((entry) => entry.state === 'held'))
    .map((entries) => ({ id: entries[0].gestureId, releaseAt: entries[0].releaseAt,
      records: entries.flatMap((entry) => (entry.intent.d ?? []).map(({ t, id }) => ({ t, id }))) }));
}

export function undoOffered(replica, gestureId, deviceNow) {
  const gesture = replica.entries().filter((entry) => entry.gestureId === gestureId);
  return gesture.length > 0 && gesture.every((entry) => entry.state === 'held' && entry.releaseAt > deviceNow);
}
