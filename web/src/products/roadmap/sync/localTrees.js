// The signed-out lifecycle of a tree that lives entirely on this device: bearing, renaming,
// deleting and remapping one. Everything durable rides the same lattice blob and per-tree stores
// the synced path uses.

import { SyncSession } from './SyncSession.js';
import { SyncStore } from './SyncStore.js';
import { HlcClock, TreeLattice, hlcText } from './lattice.js';
import { LocalTreeRegistry, resolveDeviceOwner, deviceOwner } from '../persistence/LocalTreeRegistry.js';
import { PlaceStore } from '../persistence/PlaceStore.js';
import { ProgressStore } from '../persistence/ProgressStore.js';
import { WorkspaceStore } from '../persistence/WorkspaceStore.js';
import { LegendStore } from '../persistence/LegendStore.js';
import { ReturnLedger } from '../persistence/ReturnLedger.js';
import { MilestoneLedger } from '../persistence/MilestoneLedger.js';
import { ShareLedger } from '../persistence/ShareLedger.js';
import { DEFAULT_KINDS } from '../model/Legend.js';

// t_ + 16 lowercase hex — the server's own id shape, so the id survives the claim.
export function mintTreeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `t_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const BIRTH_OWNER_WAIT_MS = 2000;

// A birth never waits on the network: past BIRTH_OWNER_WAIT_MS it plants with whatever this load
// has already confirmed, which on an unconfirmed device is anonymous.
function ownerForBirth() {
  return Promise.race([
    resolveDeviceOwner(),
    new Promise((resolve) => { setTimeout(() => resolve(deviceOwner()), BIRTH_OWNER_WAIT_MS); }),
  ]);
}

// The registry entry first, then the lattice: the default legend at genesis, so it converges with
// the server's claim-create, and the named root as a stamped write.
export async function bearLocalTree({ title }) {
  const treeId = mintTreeId();
  // The owner is asked of the server, never of a remembered marker.
  new LocalTreeRegistry().record(treeId, title, await ownerForBirth());
  const session = new SyncSession({ treeId, title });
  session.seed({ id: treeId, title, nodes: [], kinds: DEFAULT_KINDS });
  const rootId = crypto.randomUUID?.() ?? `n-${Date.now()}`;
  session.dispatch({ kind: 'CreateNode', id: rootId, label: title, icon: 'sparkles', color: DEFAULT_KINDS[0].hue, x: 0, y: 0 });
  await session.persistNow();
  session.close();
  return treeId;
}

// The paste-import plant: the lattice is seeded with the default legend at genesis, never the
// parsed kinds — the claim converges only while both sides seed byte-equal legends. The parsed
// legend arrives as stamped gestures. Imported [x] marks are status seeds, not progress rows.
export async function bearImportedTree({ title, nodes, kinds }) {
  const treeId = mintTreeId();
  new LocalTreeRegistry().record(treeId, title, await ownerForBirth());
  const session = new SyncSession({ treeId, title });
  session.seed({ id: treeId, title, nodes: [], kinds: DEFAULT_KINDS });
  // The legend diff must go first, while no node wears a hue: RecolorKind repaints as it lands.
  for (const gesture of legendGestures(kinds)) session.dispatch(gesture);
  session.dispatch({
    kind: 'ImportSubgraph',
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, icon: n.icon, color: n.color, status: n.status, description: n.description, links: n.links, order: n.order })),
    edges: nodes.flatMap((n) => n.prerequisites.map((from) => ({ from, to: n.id }))),
  });
  await session.persistNow();
  session.close();
  return treeId;
}

// What separates the parsed legend from the genesis seed, as ordinary kind gestures.
function legendGestures(kinds) {
  const gestures = [];
  const seeded = new Map(DEFAULT_KINDS.map((kind) => [kind.id, kind]));
  for (const kind of kinds) {
    const genesis = seeded.get(kind.id);
    if (!genesis) {
      gestures.push({ kind: 'AddKind', id: kind.id, hue: kind.hue });
      if (kind.label) gestures.push({ kind: 'RenameKind', id: kind.id, label: kind.label });
      if (kind.description) gestures.push({ kind: 'DescribeKind', id: kind.id, description: kind.description });
      continue;
    }
    seeded.delete(kind.id);
    if (kind.hue !== genesis.hue) gestures.push({ kind: 'RecolorKind', id: kind.id, hue: kind.hue });
    if (kind.label !== genesis.label) gestures.push({ kind: 'RenameKind', id: kind.id, label: kind.label });
    if (kind.description !== genesis.description) gestures.push({ kind: 'DescribeKind', id: kind.id, description: kind.description });
  }
  for (const id of seeded.keys()) gestures.push({ kind: 'RemoveKind', id });
  return gestures;
}

// This device's answer for a tree the server did not give us: the lattice blob replayed into the
// TreeData shape a server seed has, or null when this browser has no standing to open it. Only a
// device row visible to the account the server says is here opens the door.
export async function loadDeviceTree(treeId) {
  const entry = new LocalTreeRegistry().get(treeId, await resolveDeviceOwner());
  if (!entry) return null;
  const saved = await new SyncStore().load(treeId).catch(() => null);
  if (!saved?.frame) return null;
  const lattice = new TreeLattice(treeId, entry.title ?? '');
  lattice.join(saved.frame);
  const seed = lattice.toTreeData();
  // The blob path carries no server `mine` bit; a device row visible to this account is its own.
  seed.mine = true;
  return seed;
}

// The registry keeps the listing title and the blob takes one stamped title write, so the name
// survives the claim's flush.
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

// No server call, ever. The caller must close any live session first, or its pagehide flush
// resurrects the blob.
export async function deleteLocalTree(treeId) {
  await new SyncStore().clear(treeId).catch(() => {});
  new ProgressStore().clear(treeId);
  new WorkspaceStore().clear(treeId);
  new LegendStore().clear(treeId);
  new ReturnLedger().clear(treeId);
  new MilestoneLedger().clear(treeId);
  new ShareLedger().clear(treeId);
  new LocalTreeRegistry().remove(treeId);
  new PlaceStore().forget(treeId); // a dead last-place dead-ends the next magic-link landing
}

// When the account holding this device changes, everything not anonymous goes: stamped
// device-index rows, their per-tree stores and blobs, and residue whose index row is gone.
// Anonymous rows stay — that work follows whoever signs in next.
export async function forgetDeviceTrees() {
  const registry = new LocalTreeRegistry();
  const anonymous = new Set(registry.list(null).map((tree) => tree.id));
  for (const treeId of Object.keys(registry.entries())) {
    if (!anonymous.has(treeId)) await deleteLocalTree(treeId);
  }

  const store = new SyncStore();
  const blobs = await store.treeIds().catch(() => []);
  for (const treeId of blobs) if (!anonymous.has(treeId)) await store.clear(treeId).catch(() => {});

  for (const PerTreeStore of [ProgressStore, WorkspaceStore, LegendStore, ReturnLedger, MilestoneLedger, ShareLedger]) {
    const perTree = new PerTreeStore();
    for (const treeId of perTree.treeIds()) if (!anonymous.has(treeId)) perTree.clear(treeId);
  }

  const place = new PlaceStore();
  const stood = place.load()?.treeId;
  if (stood && !anonymous.has(stood)) place.forget(stood);
}

// Everything the old id owned moves under the fresh one: the blob with seq reset to 0, the
// per-tree stores and the registry entry.
export async function moveLocalTree(fromId, toId) {
  const store = new SyncStore();
  const saved = await store.load(fromId).catch(() => null);
  if (saved?.frame) {
    await store.save(toId, { frame: saved.frame, progress: saved.progress, lastSeq: 0 });
    await store.clear(fromId).catch(() => {});
  }
  for (const PerTreeStore of [WorkspaceStore, LegendStore]) {
    const perTree = new PerTreeStore();
    const value = perTree.load(fromId);
    if (value != null) {
      perTree.save(toId, value);
      perTree.clear(fromId);
    }
  }
  new LocalTreeRegistry().move(fromId, toId);
}
