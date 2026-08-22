// The device-tree index (anon-first-tree F3): which trees live on THIS device, their
// titles, and whether the signed-in account has claimed them. localStorage-backed like
// ProgressStore; the durable structure itself is the SyncStore blob — this is only the
// listing the switcher, the bare-#/app resolver, and the claim sequence read. Birth is
// the only writer of unclaimed entries; a syncing session touching a tree this index
// doesn't know registers it claimed, so the claim path can never adopt a tree this
// device didn't bear.
//
// Every entry also carries the ACCOUNT it belongs to, and the index only answers for the
// account holding the device now. That stamp is what makes a shared browser safe (audit
// WEB-4): the shell's sign-out hook is skipped by a crashed tab, a killed browser, or any
// entry written before the stamp existed, so the rule cannot live in the hook alone — a
// stamped entry is unreadable by the next account no matter what ran. `owner: null` is
// anonymous work: this device's own, still waiting for whoever signs in next to claim it,
// which is the anonymous-first door and must stay open. A row with NO owner at all is a row
// from before the stamp: shown to nobody until the first confirmed answer attributes it.

import { fetchMe } from '../../../shell/auth/AuthClient.js';

const KEY = 'windmill:device-trees';

// THE RULE, and it is the whole of the fix: a remembered or hinted identity may PAINT a face,
// but it may never authorise a device-side read until this document load has had one successful
// /v1/me. The confirmation lives in memory precisely so it cannot survive a reload — anything on
// disk is a statement by the previous session, and a stranger who pulls the wifi would otherwise
// inherit it (a persisted marker was the second hole the reviewer drove through). Until a call
// succeeds the account is unknown, which reads as the anonymous scope.
//
// The cost, accepted and named: a cold start with no network shows only anonymous work until one
// call gets through. Nothing is lost — the trees come back with the network. Without the server
// this device genuinely cannot tell its owner from a stranger, and answering that question wrongly
// IS the finding. Once confirmed, a later blip keeps the confirmed account: a connection dying
// mid-session must never throw the owner out of their own tree.
//
// It hangs off `window` rather than storage because it is a fact about THIS document — a reload, a
// new tab and a restored session must each start out not knowing.
function confirmation() {
  return typeof window === 'undefined' ? null : window.wmDeviceConfirmation ?? null;
}

// The account this document load has CONFIRMED with the server, or null while unknown.
export function deviceOwner() {
  return confirmation()?.owner ?? null;
}

// A server-confirmed answer about who holds this device — /v1/me below, or the shell's own settled
// account change (routes.js forgetDevice). It also attributes anything unstamped: see
// stampUnattributed.
export function confirmDeviceOwner(userId) {
  const owner = userId ?? null;
  window.wmDeviceConfirmation = { owner };
  new LocalTreeRegistry().stampUnattributed(owner);
  return owner;
}

export async function resolveDeviceOwner() {
  const me = await fetchMe();
  if (me === undefined) return deviceOwner(); // a blip is not an account change, in either direction
  return confirmDeviceOwner(me?.id ?? null);
}

// Whose eyes this row is for. A row with no owner at all is attributed to NOBODY and shown to
// nobody: an unstamped row that every account could see was the leak itself (a signed-in person
// whose claim never finished leaves exactly the shape an anonymous tree does, so "unclaimed means
// anonymous" handed the next account a private tree, and its claim uploaded it).
function visibleTo(entry, owner) {
  if (entry.owner === undefined) return false;
  if (entry.owner === null) return true;
  return entry.owner === owner;
}

export class LocalTreeRegistry {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  entries() {
    try {
      return JSON.parse(this.storage.getItem(KEY)) ?? {};
    } catch {
      return {};
    }
  }

  write(entries) {
    try {
      this.storage.setItem(KEY, JSON.stringify(entries));
    } catch {
      // storage full or unavailable — the index is best-effort, never fatal
    }
  }

  list(owner = deviceOwner()) {
    return Object.entries(this.entries())
      .filter(([, entry]) => visibleTo(entry, owner))
      .map(([id, entry]) => ({ id, title: entry.title ?? '', updatedAt: entry.updatedAt ?? 0, claimed: !!entry.claimed }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id, owner = deviceOwner()) {
    return this.list(owner).find((entry) => entry.id === id) ?? null;
  }

  // Birth: a tree this device bore, awaiting its account. The owner is stamped at birth so
  // a tree born signed-out but offline-planted by a signed-in person doesn't read as
  // anonymous work the next account may claim.
  record(id, title, owner = deviceOwner()) {
    const entries = this.entries();
    entries[id] = { title, updatedAt: Date.now(), claimed: false, owner };
    this.write(entries);
  }

  // Rows written before entries named an account — and any row a tab wrote before its first
  // confirmed answer — are attributed on FIRST CONTACT: the first server answer of this document
  // load writes itself onto them, once, and they are invisible until it does. On a signed-out
  // device that answer is `null`, which is what keeps anonymous-first working for every browser
  // already carrying unstamped rows.
  //
  // What it cannot resolve, stated rather than hidden: an unstamped row is ambiguous by
  // construction — an anonymous tree and a signed-in person's interrupted claim leave the same
  // bytes — so on a device whose real owner never opens the roadmap again, the first person who
  // does inherits those rows. Every row written from here on carries its owner and is never
  // ambiguous again.
  stampUnattributed(owner) {
    const entries = this.entries();
    let changed = false;
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.owner !== undefined) continue;
      entries[id] = { ...entry, owner };
      changed = true;
    }
    if (changed) this.write(entries);
  }

  // A persisting session passed through. Known entries keep their claim state AND their owner —
  // a session never re-attributes a row, or an unconfirmed tab would move this device's own
  // anonymous tree under an account that never touched it. An unknown tree arriving through sync
  // is a server tree landing on this device — born claimed, and stamped only if this load has a
  // confirmed answer; without one it is left unattributed, which shows it to nobody until the
  // first confirmation names its account.
  touch(id, title) {
    const entries = this.entries();
    const known = entries[id];
    entries[id] = known
      ? { ...known, title, updatedAt: Date.now() }
      : { title, updatedAt: Date.now(), claimed: true, ...(confirmation() ? { owner: deviceOwner() } : {}) };
    this.write(entries);
  }

  rename(id, title) {
    const entries = this.entries();
    if (!entries[id]) return;
    entries[id] = { ...entries[id], title, updatedAt: Date.now() };
    this.write(entries);
  }

  // The server vouched for these rows under this account: stamp them claimed and owned. It
  // is the claim's last step, and it is also how a row written before the stamp existed —
  // or one a stale marker mis-attributed — is healed the first time the account lists.
  attribute(ids, owner) {
    const entries = this.entries();
    let changed = false;
    for (const id of ids) {
      const entry = entries[id];
      if (!entry || (entry.claimed && entry.owner === owner)) continue;
      entries[id] = { ...entry, claimed: true, owner };
      changed = true;
    }
    if (changed) this.write(entries);
  }

  move(fromId, toId) {
    const entries = this.entries();
    if (!entries[fromId]) return;
    entries[toId] = entries[fromId];
    delete entries[fromId];
    this.write(entries);
  }

  remove(id) {
    const entries = this.entries();
    delete entries[id];
    this.write(entries);
  }
}
