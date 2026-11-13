// Adopts this device's unclaimed local trees into the signed-in account. Additive: the create is
// insert-only (`existed` is its idempotent resume), the lattice flushes through the normal sync
// machinery, and the claim mark lands last, after everything is durable. What goes up is what the
// device showed: a step done by its seed goes as the person's mark, and a mark on a step whose pointer
// leads to no tree here goes as any mark does.

import { createTree } from '../persistence/TreeRegistry.js';
import { LocalTreeRegistry, resolveDeviceOwner } from '../persistence/LocalTreeRegistry.js';
import { OpenedTrees } from '../model/OpenedTrees.js';
import { SyncSession } from './SyncSession.js';
import { mintTreeId, moveLocalTree, deleteLocalTree, readDeviceTrees, repointDeviceSteps } from './localTrees.js';
import { countBucket } from '../board/acts.js';
import { track } from '../../../telemetry/beacon.js';

const DRAIN_TIMEOUT_MS = 30_000;
const CLAIMS = 'windmill-roadmap-claims';

// A tree a claim took to the account, told to this document and to every other tab on the device.
function announceClaim(treeId) {
  window.dispatchEvent(new CustomEvent('wm-tree-claimed', { detail: { treeId } }));
  if (typeof BroadcastChannel !== 'function') return;
  const channel = new BroadcastChannel(CLAIMS);
  try {
    channel.postMessage({ treeId });
  } finally {
    channel.close();
  }
}

// Every claim that lands, in this tab or another on this device: `handler(treeId)`. Answers the unsubscribe.
export function onTreeClaimed(handler) {
  const claimed = (event) => handler(event.detail?.treeId ?? null);
  window.addEventListener('wm-tree-claimed', claimed);
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CLAIMS) : null;
  if (channel) channel.onmessage = ({ data }) => handler(typeof data?.treeId === 'string' ? data.treeId : null);
  return () => {
    window.removeEventListener('wm-tree-claimed', claimed);
    channel?.close();
  };
}

// The pointers of each tree about to go up that lead to no tree on this device, by tree, as the device's rule finds them
// now: a mark on such a step goes up as any mark does. A device that cannot read its trees answers none, and every mark
// under a pointer stays set aside.
async function pointersLeadingNowhere() {
  const trees = await readDeviceTrees().catch(() => new Map());
  const judged = new OpenedTrees(trees);
  return new Map([...trees.keys()].map((id) => [id, [...judged.openings(id).byStep].flatMap(([step, opening]) => (opening.dangling ? [[step, opening.treeId]] : []))]));
}

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
  // The server or restored replica identifies the device holder; claiming still requires a server session.
  const owner = await resolveDeviceOwner();
  if (!owner) return { claimed: 0 }; // no known device holder to claim for
  const registry = new LocalTreeRegistry();
  const pending = registry.list(owner).filter((entry) => !entry.claimed);
  if (pending.length === 0) return { claimed: 0 };

  window.dispatchEvent(new CustomEvent('wm-claim-start'));
  const leadNowhere = await pointersLeadingNowhere();
  const live = () => openSession?.() ?? null;
  let claimed = 0;
  for (const entry of pending) {
    try {
      const treeId = await ensureServerTree(entry);
      // A tree that took a fresh id keeps every pointer at it: the device's trees take the new id, and one already up
      // sends the pointer write as any other.
      if (treeId !== entry.id) {
        const written = await repointDeviceSteps(entry.id, treeId, { live: live() });
        const up = new Set(registry.list(owner).filter((row) => row.claimed).map((row) => row.id));
        for (const id of written.filter((written) => up.has(written) && live()?.treeId !== written)) {
          await syncTreeUp(id, registry.get(id, owner)?.title ?? '', { openTreeId, openSession });
        }
      }
      await syncTreeUp(treeId, entry.title, { openTreeId, openSession, leadNowhere: leadNowhere.get(entry.id) ?? [] });
      registry.attribute([treeId], owner);
      announceClaim(treeId);
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
  if (claimed > 0) track('claim', { treeCount: countBucket(claimed) });
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
  const [route, query] = window.location.hash.split('?');
  if (route === `#/app/${entry.id}`) window.location.hash = `#/app/${freshId}${query === undefined ? '' : `?${query}`}`;
  const { treeId } = await createTree(claimBody(freshId, entry.title));
  return treeId;
}

function claimBody(id, title) {
  const trimmed = title?.trim();
  return trimmed ? { id, title: trimmed } : { id };
}

// Step 2 — drain both lanes; each flush carries unconfirmed registers not already in flight, the steps' seeds made marks and
// the marks under pointers that lead nowhere (`leadNowhere`, by step) among them.
async function syncTreeUp(treeId, title, { openTreeId, openSession, leadNowhere = [] }) {
  // Identity-check the live session, or a tree switched since the run started takes this progress.
  const candidate = treeId === openTreeId ? openSession?.() : null;
  const live = candidate?.treeId === treeId ? candidate : null;
  const session = live ?? new SyncSession({ treeId, title });
  try {
    const drained = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`claim drain timed out for ${treeId}`)), DRAIN_TIMEOUT_MS);
      session.onDrained(() => { clearTimeout(timer); resolve(); });
    });
    // The open room tells its own session which pointers lead nowhere; a headless one is told what the device found.
    if (live) {
      session.adoptSeeds();
      session.forceReconnect();
    } else {
      await session.start();
      session.adoptSeeds();
      session.pointersLeadNowhere(leadNowhere);
    }
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
