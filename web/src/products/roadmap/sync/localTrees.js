// The signed-out lifecycle of a tree that lives entirely on this device: bearing, reading, renaming,
// deleting and remapping one. Everything durable rides the same lattice blob and per-tree stores
// the synced path uses.

import { SyncSession } from './SyncSession.js';
import { SyncStore } from './SyncStore.js';
import { pendingGestures } from './pendingWrites.js';
import { HlcClock, TreeLattice, hlcText } from './lattice.js';
import { ProgressLattice } from './progressLattice.js';
import { LocalTreeRegistry, resolveDeviceOwner, deviceOwner, deviceOwnerAnswered } from '../persistence/LocalTreeRegistry.js';
import { PlaceStore } from '../persistence/PlaceStore.js';
import { ProgressStore } from '../persistence/ProgressStore.js';
import { WorkspaceStore } from '../persistence/WorkspaceStore.js';
import { LegendStore } from '../persistence/LegendStore.js';
import { ReturnLedger } from '../persistence/ReturnLedger.js';
import { MilestoneLedger } from '../persistence/MilestoneLedger.js';
import { DEFAULT_KINDS } from '../model/Legend.js';
import { OpenedTrees } from '../model/OpenedTrees.js';
import { InadmissibleGuide, admitsGuide } from '../guide/GuideDraft.js';
import { BoundaryFailure, reportRoadmapFailure } from '../reportFailure.js';

// A write for a device tree whose record this browser no longer holds: nothing took it.
export class MissingDeviceTree extends Error {
  constructor() {
    super('Device tree record missing');
    this.name = 'MissingDeviceTree';
  }
}

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

// Whether a tree planted here outlives this document: its index row and its lattice both have somewhere to stay.
export async function deviceKeepsTrees() {
  return new LocalTreeRegistry().keeps() && new SyncStore().holdsOnDevice();
}

// This browser will not keep a tree planted on it, the browser's own refusal: nothing was accepted, and no Issue is owed.
const deviceRefused = () => new DOMException('This device refuses to keep a roadmap', 'SecurityError');

// The index row, then the lattice seeded at genesis so it converges with the claim-create; a plant stands once kept, and a failed save takes its row back.
async function bear(title, plant) {
  if (!await deviceKeepsTrees()) throw deviceRefused();
  const treeId = mintTreeId();
  const registry = new LocalTreeRegistry();
  // The owner comes from the server or the restored bound replica, never a cached face.
  registry.record(treeId, title, await ownerForBirth());
  const session = new SyncSession({ treeId, title });
  session.seed({ id: treeId, title, nodes: [], kinds: DEFAULT_KINDS });
  plant(session);
  await session.persistNow();
  const kept = !session.durabilityAtRisk;
  session.close();
  if (kept) return treeId;
  registry.remove(treeId);
  throw deviceRefused();
}

// The named root as a stamped write.
export function bearLocalTree({ title }) {
  return bear(title, (session) => {
    const rootId = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    session.dispatch({ kind: 'CreateNode', id: rootId, label: title, icon: 'sparkles', color: DEFAULT_KINDS[0].hue });
  });
}

// The paste-import plant: the parsed legend arrives as stamped gestures, as a claim converges only on byte-equal genesis legends; [x] marks are status seeds.
export function bearImportedTree({ title, nodes, kinds }) {
  return bear(title, (session) => {
    // The legend diff must go first, while no node wears a hue: RecolorKind repaints as it lands.
    for (const gesture of legendGestures(kinds)) session.dispatch(gesture);
    session.dispatch({
      kind: 'ImportSubgraph',
      nodes: nodes.map((n) => ({ id: n.id, label: n.label, icon: n.icon, color: n.color, status: n.status, description: n.description, links: n.links, order: n.order })),
      edges: nodes.flatMap((n) => n.prerequisites.map((from) => ({ from, to: n.id }))),
    });
  });
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
// device row visible to the confirmed device holder opens the door.
export async function loadDeviceTree(treeId, { ownerResolved = false } = {}) {
  const registry = new LocalTreeRegistry();
  // A room that already resolved and waited still reads only the currently confirmed owner.
  if (!ownerResolved) {
    await resolveDeviceOwner();
    if (!registry.get(treeId)) await deviceOwnerAnswered();
  }
  const entry = registry.get(treeId);
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

// The trees that live only on this device, for the person who holds it, by id: each one's title, its steps and the marks
// its room shows, those of its private lane where the lane holds any and its steps' seeds otherwise, as a load reads
// them. A record this browser cannot read reports `roadmap-device-opens-read` and the read throws, judged.
export async function readDeviceTrees({ registry = new LocalTreeRegistry(), store = new SyncStore(), report = reportRoadmapFailure } = {}) {
  const trees = new Map();
  try {
    for (const row of registry.list().filter((entry) => !entry.claimed)) {
      const saved = await store.load(row.id);
      if (!saved) continue;
      const lattice = new TreeLattice(row.id, row.title);
      lattice.join(saved.frame);
      const marks = new ProgressLattice();
      marks.join(saved.progress);
      const { title, nodes } = lattice.toTreeData();
      const seeded = nodes.filter((step) => step.status === 'complete').map((step) => step.id);
      trees.set(row.id, { title, nodes, completed: marks.marks.size > 0 ? marks.overlay().completed : new Set(seeded) });
    }
  } catch (error) {
    report('roadmap-device-opens-read', error);
    throw new BoundaryFailure('Device trees not read', { cause: error });
  }
  return trees;
}

// The tree picker's list on a device whose trees live here: each device tree, newest first, with done of total worked
// out on the device. A read that fails is the list that could not be read, its failure already reported.
export async function listDeviceTrees(read = readDeviceTrees) {
  let trees;
  try {
    trees = await read();
  } catch (failure) {
    return { rows: [], authoritative: false, status: 0, failure };
  }
  const judged = new OpenedTrees(trees);
  return { rows: [...trees].map(([id, tree]) => ({ id, title: tree.title, ...judged.progressOf(id) })), authoritative: true };
}

// What an address the picker was given comes to on such a device: a tree of this device's is the person's own, and any
// other is none they can read here.
export async function readDeviceTreeCard(treeId, registry = new LocalTreeRegistry()) {
  const row = registry.onDevice(treeId);
  return row ? { id: treeId, title: row.title, author: null, steps: null, mine: true } : null;
}

// The registry keeps the listing title and the blob takes one stamped title write, so the name
// survives the claim's flush.
export async function renameLocalTree(treeId, title) {
  const next = title.trim();
  if (!next) return;
  await stampDeviceRegister(treeId, 'title', next);
  new LocalTreeRegistry().rename(treeId, next);
}

// The guide lives in the blob alone, and the claim's flush carries its stamped write to the server once the tree exists.
export async function setLocalGuide(treeId, guide) {
  if (!admitsGuide(guide)) throw new InadmissibleGuide();
  if (!await stampDeviceRegister(treeId, 'guide', guide)) throw new MissingDeviceTree();
}

// One stamped write to a device tree's title or guide. Answers whether a record took it.
async function stampDeviceRegister(treeId, name, value) {
  const store = new SyncStore();
  const saved = await store.load(treeId).catch(() => null);
  if (!saved?.frame) return false;
  await amendDeviceRecord(store, treeId, saved, (lattice, progress, clock) => {
    lattice.join({ nodes: [], edges: [], kinds: [], [name]: { v: value, at: hlcText(clock.tick(Date.now())) } });
    return ['structure'];
  });
  return true;
}

// One write to a device tree's stored record, as its room would make it: `change(lattice, progress, clock)` joins its
// stamped writes and answers the lanes it wrote, none for nothing to write. Read afresh and retried while another tab's
// discard moves the record.
async function amendDeviceRecord(store, treeId, saved, change) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lattice = new TreeLattice(treeId);
    lattice.join(saved.frame);
    const progress = new ProgressLattice();
    progress.join(saved.progress);
    const clock = new HlcClock(`r_${crypto.randomUUID?.().slice(0, 8) ?? `${Date.now()}`}`);
    lattice.seedClock(clock);
    progress.seedClock(clock);
    const lanes = change(lattice, progress, clock);
    if (lanes.length === 0) return;
    const value = { frame: lattice.toFrame(), lastSeq: saved.lastSeq ?? 0, epochs: saved.epochs,
      gestures: {
        structure: pendingGestures(lattice.toFrame(), saved.confirmed?.structure, saved.gestures?.structure),
        progress: saved.gestures?.progress ?? {},
      } };
    if (lanes.includes('progress')) {
      value.progress = progress.toFrame();
      value.gestures.progress = pendingGestures(value.progress, saved.confirmed?.progress, saved.gestures?.progress);
    }
    const result = await store.save(treeId, value);
    if (result.status === 'saved') return;
    saved = result.value;
  }
  throw new Error('local tree changed during a write');
}

// No server call, ever. The caller must close any live session first, or its pagehide flush
// resurrects the blob.
export async function deleteLocalTree(treeId) {
  clearShareResidue();
  await new SyncStore().clear(treeId).catch(() => {});
  new ProgressStore().clear(treeId);
  new WorkspaceStore().clear(treeId);
  new LegendStore().clear(treeId);
  new ReturnLedger().clear(treeId);
  new MilestoneLedger().clear(treeId);
  new LocalTreeRegistry().remove(treeId);
  new PlaceStore().forget(treeId); // a dead last-place dead-ends the next magic-link landing
}

// Removing a device tree takes with it the steps of the person's other device trees that open it, as the server's
// removal does: each tombstoned with every edge touching it, nothing respliced, and the person's mark on it cleared.
// Each tree takes its own write, so one that fails leaves the others' steps gone: the tree open in this tab through its
// session `live`, as a local write outside the undo journal, and every other through its stored record, as any device
// edit. A failure reports `roadmap-device-cascade` once; it never throws.
export async function removeDeviceOpeners(treeId, { live = null, registry = new LocalTreeRegistry(), store = new SyncStore(), report = reportRoadmapFailure } = {}) {
  let failure = null;
  for (const row of registry.list().filter((entry) => !entry.claimed && entry.id !== treeId)) {
    try {
      if (live?.treeId === row.id && live.ready && !live.closed) {
        const steps = stepsOpening(live.lattice, treeId);
        if (steps.length === 0) continue;
        live.apply(prunedSteps(live.lattice, steps, live.clock.tick(Date.now())));
        const marked = steps.filter((id) => live.progress.marks.get(id)?.status === 'complete');
        if (marked.length > 0) live.markProgress(marked, 'none');
        continue;
      }
      const saved = await store.load(row.id);
      if (!saved) continue;
      await amendDeviceRecord(store, row.id, saved, (lattice, progress, clock) => {
        const steps = stepsOpening(lattice, treeId);
        if (steps.length === 0) return [];
        const at = clock.tick(Date.now());
        lattice.join(prunedSteps(lattice, steps, at));
        progress.join({ marks: steps.filter((id) => progress.marks.get(id)?.status === 'complete').map((node) => ({ node, status: 'none', at: hlcText(at) })) });
        return ['structure', 'progress'];
      });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) report('roadmap-device-cascade', failure);
}

// The steps of a tree that open `treeId`.
function stepsOpening(lattice, treeId) {
  return lattice.toTreeData().nodes.filter((step) => step.opens === treeId).map((step) => step.id);
}

// What removing `steps` writes under one stamp: each one's tombstone and every edge touching it, as a delete with prune does.
function prunedSteps(lattice, steps, at) {
  const doomed = new Set(steps);
  const stamp = hlcText(at);
  return {
    nodes: steps.map((id) => ({ id, deletedAt: stamp })),
    edges: lattice.presentEdges().filter(({ from, to }) => doomed.has(from) || doomed.has(to)).map(({ from, to }) => ({ from, to, removedAt: stamp })),
    kinds: [],
  };
}

// When the account holding this device changes, everything not anonymous goes: stamped
// device-index rows, their per-tree stores and blobs, and residue whose index row is gone.
// Anonymous rows stay — that work follows whoever signs in next.
export async function forgetDeviceTrees() {
  clearShareResidue();
  const registry = new LocalTreeRegistry();
  const anonymous = new Set(registry.list(null).map((tree) => tree.id));
  if (!registry.keeps()) throw new Error('device-index-unavailable');
  const store = new SyncStore();
  const blobs = await store.treeIds({ durable: true });
  const owned = new Set([...Object.keys(registry.entries()), ...blobs]);
  for (const treeId of owned) if (!anonymous.has(treeId)) await store.clear(treeId, { durable: true });

  for (const PerTreeStore of [ProgressStore, WorkspaceStore, LegendStore, ReturnLedger, MilestoneLedger]) {
    const perTree = new PerTreeStore();
    for (const treeId of perTree.treeIds()) if (!anonymous.has(treeId)) perTree.clear(treeId);
  }

  const place = new PlaceStore();
  const stood = place.load()?.treeId;
  if (stood && !anonymous.has(stood)) place.forget(stood);
  for (const treeId of owned) if (!anonymous.has(treeId)) registry.remove(treeId);
  if (Object.keys(registry.entries()).some((treeId) => !anonymous.has(treeId))) throw new Error('device-index-cleanup');
}

// Everything the old id owned moves under the fresh one: the blob with seq reset to 0, the
// per-tree stores and the registry entry.
export async function moveLocalTree(fromId, toId) {
  const store = new SyncStore();
  const saved = await store.load(fromId).catch(() => null);
  if (saved?.frame) {
    const result = await store.save(toId, { frame: saved.frame, progress: saved.progress, lastSeq: 0,
      epochs: { structure: 0, progress: 0 }, ...(saved.gestures ? { gestures: saved.gestures } : {}) });
    if (result.status !== 'saved') throw new Error('local tree destination changed');
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

function clearShareResidue() {
  try {
    const storage = window.localStorage;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (key?.startsWith('windmill:shared:') || key === 'windmill:card:unit' || key === 'windmill:card:ledger') {
        storage.removeItem(key);
      }
    }
  } catch {}
}
