// The notices of roadmap's this browser has told the intake of, or reported (§6, web/OBSERVABILITY.md), so each is told
// once: once a page load always, and once on this browser where it keeps storage. Storage holds the ids of the told
// notices the engine still holds, never what they say, and signing out takes them (`forgetToldNotices`). A browser that
// refuses storage tells each notice once a page load.

import { localStorageOrNothing } from '../persistence/browserStorage.js';

const TOLD = 'windmill:roadmap:kept-told';
const told = new Set();

// Of the notices the engine holds now (`held`, their ids, in its order), those not yet told, which count as told from
// here on. Storage then holds exactly the held ids, so a notice the engine no longer holds leaves it.
export function untoldNotices(held) {
  const storage = localStorageOrNothing();
  let stored = [];
  try { stored = JSON.parse(storage.getItem(TOLD) ?? '[]'); } catch { stored = []; }
  if (!Array.isArray(stored)) stored = [];
  for (const id of stored) told.add(id);
  const untold = held.filter((id) => !told.has(id));
  for (const id of untold) told.add(id);
  if (JSON.stringify(held) !== JSON.stringify(stored)) {
    try { storage.setItem(TOLD, JSON.stringify(held)); } catch { /* told again on the next page load, never lost */ }
  }
  return untold;
}

// Sign-out: this browser forgets which notices it told, in storage and in this page.
export function forgetToldNotices() {
  told.clear();
  try { localStorageOrNothing().removeItem(TOLD); } catch { /* storage refused holds nothing */ }
}
