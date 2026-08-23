// Adopts this device's unclaimed local trees into the signed-in account. Additive: the create is
// insert-only (`existed` is its idempotent resume), the lattice flushes through the normal sync
// machinery, and the claim mark lands last, after everything is durable.

import { createTree } from '../persistence/TreeRegistry.js';
import { LocalTreeRegistry, resolveDeviceOwner } from '../persistence/LocalTreeRegistry.js';
import { SyncSession } from './SyncSession.js';
import { mintTreeId, moveLocalTree, deleteLocalTree } from './localTrees.js';
import { track } from '../../../telemetry/beacon.js';

const DRAIN_TIMEOUT_MS = 30_000;

// The id names a roadmap this account deleted: not an error to retry, an instruction to let go.
class RetiredTree extends Error {
  constructor(treeId) {
    super(`tree ${treeId} was deleted by its owner`);
    this.treeId = treeId;
  }
}

// One pass over the device index. `openSession` is an accessor for the live session of the
// currently-open tree; every other tree drains through a headless session. Never rejects.
export async function claimLocalTrees({ openTreeId = null, openSession = null } = {}) {
  // Who is arriving comes from the server, never from a remembered marker.
  const owner = await resolveDeviceOwner();
  if (!owner) return { claimed: 0 }; // nobody is signed in; there is no account to claim into
  const registry = new LocalTreeRegistry();
  const pending = registry.list(owner).filter((entry) => !entry.claimed);
  if (pending.length === 0) return { claimed: 0 };

  window.dispatchEvent(new CustomEvent('wm-claim-start'));
  let claimed = 0;
  for (const entry of pending) {
    try {
      const treeId = await ensureServerTree(entry);
      await syncTreeUp(treeId, entry.title, { openTreeId, openSession });
      registry.attribute([treeId], owner);
      window.dispatchEvent(new CustomEvent('wm-tree-claimed', { detail: { treeId } }));
      claimed += 1;
    } catch (err) {
      // A deleted tree is done, not pending; every other failure leaves it for the next boot.
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

// Step 1 — the server tree exists under our id: created empty at the genesis legend, or `existed`,
// a resume. 409 id-taken means another account owns the id; the local tree moves under a fresh one.
async function ensureServerTree(entry) {
  try {
    const { treeId } = await createTree(claimBody(entry.id, entry.title));
    return treeId;
  } catch (err) {
    // id-retired is this account's own deleted roadmap: never re-plant it under a fresh id.
    if (err?.code === 'id-retired') throw new RetiredTree(entry.id);
    if (err?.code !== 'id-taken') throw err;
  }
  const freshId = mintTreeId();
  await moveLocalTree(entry.id, freshId);
  window.dispatchEvent(new CustomEvent('wm-claim-conflict', { detail: { treeId: entry.id, remappedTo: freshId } }));
  if (window.location.hash === `#/app/${entry.id}`) window.location.hash = `#/app/${freshId}`;
  const { treeId } = await createTree(claimBody(freshId, entry.title));
  return treeId;
}

function claimBody(id, title) {
  const trimmed = title?.trim();
  return trimmed ? { id, title: trimmed } : { id };
}

// Step 2 — drain both lanes; the flush is derived from coverage, not a queue.
async function syncTreeUp(treeId, title, { openTreeId, openSession }) {
  // Identity-check the live session, or a tree switched since the run started takes this progress.
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
    // The subscribe can race the create's commit and a reject never resubscribes: nudge until live.
    const nudge = setInterval(() => { if (session.phase !== 'live') session.forceReconnect(); }, 2500);
    try {
      await drained;
    } finally {
      clearInterval(nudge);
    }
  } finally {
    session.onDrained(null);
    if (!live) session.close();
  }
}
