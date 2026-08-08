// The claim (anon-first-tree F4): adopt this device's unclaimed local trees into the
// signed-in account. Additive by construction — the create is INSERT-only (POST
// /v1/trees with the client-minted id; `existed` is the idempotent resume), the lattice
// flushes through the normal sync machinery (a CRDT join, never PUT), progress pushes
// only marks the server holds NO row for, and markClaimed lands LAST. Every input is
// durable before any wire traffic, so the whole sequence is resumable: a reload
// mid-claim loses nothing — the boot trigger simply runs it again.

import { API_BASE } from '../../../shell/apiBase.js';
import { createTree } from '../persistence/TreeRegistry.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { ProgressStore } from '../persistence/ProgressStore.js';
import { SyncSession } from './SyncSession.js';
import { mintTreeId, moveLocalTree, deleteLocalTree } from './localTrees.js';
import { track } from '../../../telemetry/beacon.js';

const DRAIN_TIMEOUT_MS = 30_000;

// The id names a roadmap this account deleted. Not an error to retry — an answer: this device
// is holding the leftovers of a tree its owner retired, and the claim's job is to let it go.
class RetiredTree extends Error {
  constructor(treeId) {
    super(`tree ${treeId} was deleted by its owner`);
    this.treeId = treeId;
  }
}

// One pass over the device index. `openSession` is an accessor for the live session of
// the currently-open tree (its socket already carries the fresh principal); every other
// tree drains through a headless session. Never rejects — a tree whose claim fails just
// stays unclaimed for the next pass.
export async function claimLocalTrees({ openTreeId = null, openSession = null } = {}) {
  const registry = new LocalTreeRegistry();
  const pending = registry.list().filter((entry) => !entry.claimed);
  if (pending.length === 0) return { claimed: 0 };

  window.dispatchEvent(new CustomEvent('wm-claim-start'));
  let claimed = 0;
  for (const entry of pending) {
    try {
      const treeId = await ensureServerTree(entry);
      await syncTreeUp(treeId, entry.title, { openTreeId, openSession });
      registry.markClaimed(treeId);
      window.dispatchEvent(new CustomEvent('wm-tree-claimed', { detail: { treeId } }));
      claimed += 1;
    } catch (err) {
      // A tree the account has deleted is done, not pending: clear this device's copy so the
      // next boot has nothing left to claim. Every other failure leaves the tree unclaimed and
      // the next boot retries it; an unreachable or signed-out server dooms the rest of the run
      // too, so stop asking.
      if (err instanceof RetiredTree) {
        await deleteLocalTree(err.treeId).catch(() => {});
        window.dispatchEvent(new CustomEvent('wm-claim-retired', { detail: { treeId: err.treeId } }));
        continue;
      }
      if (err?.code === 'unreachable' || err?.code === 'unauthenticated') break;
    }
  }
  window.dispatchEvent(new CustomEvent('wm-claim-done', { detail: { claimed, pending: pending.length } }));
  if (claimed > 0) track('claim', { treeCount: claimed });
  return { claimed, pending: pending.length };
}

// Step 1 — the server tree exists under our id: created empty (default legend at
// genesis, so the local seed converges with it), or `existed` (owner == caller, a
// plain resume). 409 id-taken means another account owns the id — cryptographically
// unreachable for an honestly-minted one. The local tree survives by moving under a
// fresh id; the server's version stands untouched.
async function ensureServerTree(entry) {
  try {
    const { treeId } = await createTree(claimBody(entry.id, entry.title));
    return treeId;
  } catch (err) {
    // 409 id-retired is this account's own deleted roadmap. Re-planting it under a fresh id —
    // what the id-taken path below does — is how a deleted tree came back every boot, forever,
    // wearing a new id each time so deleting it again never helped. A delete is an instruction:
    // honour it by clearing what this device still holds, and claim nothing.
    if (err?.code === 'id-retired') throw new RetiredTree(entry.id);
    if (err?.code !== 'id-taken') throw err;
  }
  const freshId = mintTreeId();
  await moveLocalTree(entry.id, freshId);
  // wm-claim-conflict is a stub seam: the F7/X4 two-versions card will listen here and decide, instead of this silent remap.
  window.dispatchEvent(new CustomEvent('wm-claim-conflict', { detail: { treeId: entry.id, remappedTo: freshId } }));
  if (window.location.hash === `#/app/${entry.id}`) window.location.hash = `#/app/${freshId}`;
  const { treeId } = await createTree(claimBody(freshId, entry.title));
  return treeId;
}

function claimBody(id, title) {
  const trimmed = title?.trim();
  return trimmed ? { id, title: trimmed } : { id };
}

// Steps 2 + 3 — drain the lattice up through the normal machinery (the flush is derived
// from coverage, not a queue), then push only the progress marks the server has never
// heard of: cleared marks stay dead, known marks stand.
async function syncTreeUp(treeId, title, { openTreeId, openSession }) {
  // openSession() returns whatever session is live NOW — the user may have switched
  // trees since the run started, and draining a stranger's session would record this
  // tree's progress onto that one. Identity-check it; the headless path is always safe.
  const candidate = treeId === openTreeId ? openSession?.() : null;
  const live = candidate?.treeId === treeId ? candidate : null;
  const session = live ?? new SyncSession({ treeId, title });
  try {
    const drained = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`claim drain timed out for ${treeId}`)), DRAIN_TIMEOUT_MS);
      session.onDrained(() => { clearTimeout(timer); resolve(); });
    });
    if (live) session.forceReconnect();
    else await session.start();
    // The subscribe can race the create's commit: one silent "no such tree" reject and
    // the session sits dead (rejects never resubscribe on their own). Nudge the wire
    // until it goes live — the drain resolves the happy side of the race.
    const nudge = setInterval(() => { if (session.phase !== 'live') session.forceReconnect(); }, 2500);
    try {
      await drained;
    } finally {
      clearInterval(nudge);
    }
    await pushUnknownProgress(session, treeId);
  } finally {
    session.onDrained(null);
    if (!live) session.close();
  }
}

async function pushUnknownProgress(session, treeId) {
  const saved = new ProgressStore().load(treeId);
  if (!saved) return;
  const response = await fetch(`${API_BASE}/v1/trees/${treeId}/progress`, { credentials: 'include' });
  if (!response.ok) throw new Error(`claim progress fetch for ${treeId}: HTTP ${response.status}`);
  const server = await response.json();
  const known = new Set([...(server.completed ?? []), ...(server.inProgress ?? []), ...(server.cleared ?? [])]);
  for (const nodeId of saved.completed ?? []) if (!known.has(nodeId)) session.sendProgress(nodeId, 'complete');
  for (const nodeId of saved.inProgress ?? []) if (!known.has(nodeId)) session.sendProgress(nodeId, 'active');
}
