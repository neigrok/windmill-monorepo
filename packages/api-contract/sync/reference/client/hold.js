// §7.3 hold, release and undo: held entries wait durably for release, and Undo removes a gesture only
// while every entry of it is held.

import { moveEntry } from '../core/machines.js';
import { coalesce } from './coalesce.js';

export function release(replica, registry, ended, entry) {
  if (entry.state !== 'held') return false;
  moveEntry(replica, ended, entry, 'release');
  coalesce(replica, registry, ended, entry);
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

export function undo(replica, ended, gestureId) {
  const gesture = replica.entries().filter((entry) => entry.gestureId === gestureId);
  if (gesture.length === 0 || gesture.some((entry) => entry.state !== 'held')) return false;
  for (const entry of gesture) moveEntry(replica, ended, entry, 'undo');
  return true;
}

export function undoOffered(replica, gestureId, deviceNow) {
  const gesture = replica.entries().filter((entry) => entry.gestureId === gestureId);
  return gesture.length > 0 && gesture.every((entry) => entry.state === 'held' && entry.releaseAt > deviceNow);
}
