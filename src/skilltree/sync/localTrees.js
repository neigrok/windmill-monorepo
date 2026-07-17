// Local-born trees (anon-first-tree F1/F3): the signed-out lifecycle of a tree that
// lives entirely on this device — bearing one, renaming or deleting one from the
// switcher's local rows, and moving one under a fresh id when a claim hits the
// (cryptographically unreachable) id-taken wall. Everything durable rides the same
// lattice blob + per-tree stores the synced path uses, so a later claim is a plain
// create + flush, never a migration.

import { SyncSession } from './SyncSession.js';
import { SyncStore } from './SyncStore.js';
import { HlcClock, TreeLattice, hlcText } from './lattice.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { PlaceStore } from '../persistence/PlaceStore.js';
import { ProgressStore } from '../persistence/ProgressStore.js';
import { WorkspaceStore } from '../persistence/WorkspaceStore.js';
import { LegendStore } from '../persistence/LegendStore.js';
import { DEFAULT_KINDS } from '../model/Legend.js';

// t_ + 16 lowercase hex — byte-identical to the server's own tree ids, so the id
// survives the claim (POST /v1/trees keeps a client-minted id).
export function mintTreeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `t_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// Signed-out ↵ on the birth canvas: the registry entry first (the claim's durable
// input), then the lattice — the default legend at genesis (so it converges with the
// server's claim-create, zero duplication) and the named root as a real stamped write
// (so the claim's flush carries it up) — persisted to IndexedDB before the caller
// navigates into the tree.
export async function bearLocalTree({ title }) {
  const treeId = mintTreeId();
  new LocalTreeRegistry().record(treeId, title);
  const session = new SyncSession({ treeId, title });
  session.seed({ id: treeId, title, nodes: [], kinds: DEFAULT_KINDS });
  const rootId = crypto.randomUUID?.() ?? `n-${Date.now()}`;
  session.dispatch({ kind: 'CreateNode', id: rootId, label: title, icon: 'sparkles', color: DEFAULT_KINDS[0].hue, x: 0, y: 0 });
  await session.persistNow();
  session.close();
  return treeId;
}

// A switcher rename of a local row that isn't the open tree: the registry keeps the
// listing title, and the blob takes one stamped title write — exactly what a live
// session's renameTree would join — so the name survives the claim's flush.
export async function renameLocalTree(treeId, title) {
  const next = title.trim();
  if (!next) return;
  new LocalTreeRegistry().rename(treeId, next);
  const store = new SyncStore();
  const saved = await store.load(treeId).catch(() => null);
  if (!saved?.frame) return;
  const lattice = new TreeLattice(treeId);
  lattice.join(saved.frame);
  const clock = new HlcClock(`r_${crypto.randomUUID?.().slice(0, 8) ?? `${Date.now()}`}`);
  lattice.seedClock(clock);
  lattice.join({ nodes: [], edges: [], kinds: [], title: { v: next, at: hlcText(clock.tick(Date.now())) } });
  await store.save(treeId, { frame: lattice.toFrame(), lastSeq: saved.lastSeq ?? 0 });
}

// A switcher delete of a local row: no server call, ever — clear the blob, the
// per-tree stores, and the registry entry. The caller closes any live session first
// (its pagehide flush would resurrect the blob).
export async function deleteLocalTree(treeId) {
  await new SyncStore().clear(treeId).catch(() => {});
  new ProgressStore().clear(treeId);
  new WorkspaceStore().clear(treeId);
  new LegendStore().clear(treeId);
  new LocalTreeRegistry().remove(treeId);
  new PlaceStore().forget(treeId); // a dead last-place would dead-end the next magic-link landing
}

// The id-taken remap: everything the old id owned moves under the fresh one — the blob
// (seq reset to 0; a fresh tree has no server history), the per-tree stores, and the
// registry entry, claim state intact.
export async function moveLocalTree(fromId, toId) {
  const store = new SyncStore();
  const saved = await store.load(fromId).catch(() => null);
  if (saved?.frame) {
    await store.save(toId, { frame: saved.frame, lastSeq: 0 });
    await store.clear(fromId).catch(() => {});
  }
  for (const PerTreeStore of [ProgressStore, WorkspaceStore, LegendStore]) {
    const perTree = new PerTreeStore();
    const value = perTree.load(fromId);
    if (value != null) {
      perTree.save(toId, value);
      perTree.clear(fromId);
    }
  }
  new LocalTreeRegistry().move(fromId, toId);
}
