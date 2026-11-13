// The signed-out lifecycle of a tree that lives entirely on this device: bearing, reading, renaming,
// deleting and remapping one. Everything durable rides the same lattice blob and per-tree stores
// the synced path uses.

import { SyncSession } from './SyncSession.js';
import { SyncStore } from './SyncStore.js';
import { pendingGestures } from './pendingWrites.js';
import { materialize } from './materialize.js';
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

// What a device copy's room shows done as it opens: the marks of the record its session restores, before the session
// has started. A record that cannot be read leaves the steps' seeds, and the session's own restore reports it.
export async function loadDeviceMarks(seed) {
  const saved = await new SyncStore().load(seed.id).catch(() => null);
  return marksShown(saved, seed.nodes);
}

// The marks a device copy's room shows, as its session projects them: those of its private lane where the lane holds
// any, and its steps' seeds otherwise.
function marksShown(saved, nodes) {
  const marks = new ProgressLattice();
  marks.join(saved?.progress);
  if (marks.marks.size > 0) return marks.overlay();
  return { completed: new Set(nodes.filter((step) => step.status === 'complete').map((step) => step.id)), completedAt: {} };
}

// A device record that does not join as a lattice: its steps cannot be known.
class CorruptDeviceRecord extends Error {
  constructor(cause) {
    super('Device record does not join', { cause });
    this.name = 'CorruptDeviceRecord';
  }
}

// The one bounded tag a device failure reports under: the browser's own name for what failed, `corrupt` for a record that
// does not join, `other` for anything else. Never a message.
const DEVICE_FAILURES = new Set(['QuotaExceededError', 'AbortError', 'UnknownError', 'ConstraintError', 'DataError', 'DataCloneError',
  'InvalidStateError', 'NotFoundError', 'ReadOnlyError', 'TransactionInactiveError', 'VersionError', 'SecurityError', 'TimeoutError']);
function failureTags(error) {
  if (error instanceof CorruptDeviceRecord) return { name: 'corrupt' };
  return { name: error instanceof DOMException && DEVICE_FAILURES.has(error.name) ? error.name : 'other' };
}

// The steps of a stored record as a lattice, or why they cannot be known.
function joinedRecord(treeId, title, saved) {
  const lattice = new TreeLattice(treeId, title);
  try {
    lattice.join(saved.frame);
  } catch (error) {
    throw new CorruptDeviceRecord(error);
  }
  return lattice;
}

// The trees that live only on this device, for the person who holds it, by id: each one's title, its steps and the marks
// its room shows (`marksShown`). A record that does not join reports `roadmap-device-opens-read` (`corrupt`) and stands
// `unread`, its steps unknown, while the rest are read. A device that cannot read its trees at all (its database will not
// open, or a record cannot be read) reports the same and the read throws, judged.
export async function readDeviceTrees({ registry = new LocalTreeRegistry(), store = new SyncStore(), report = reportRoadmapFailure } = {}) {
  const trees = new Map();
  try {
    const held = new Set(await store.treeIds({ durable: true }));
    for (const row of registry.list().filter((entry) => !entry.claimed && held.has(entry.id))) {
      const saved = await store.load(row.id);
      if (!saved) continue;
      try {
        const { title, nodes } = joinedRecord(row.id, row.title, saved).toTreeData();
        trees.set(row.id, { title, nodes, completed: marksShown(saved, nodes).completed });
      } catch (error) {
        if (!(error instanceof CorruptDeviceRecord)) throw error;
        report('roadmap-device-opens-read', error, failureTags(error));
        trees.set(row.id, { title: row.title, unread: true, nodes: [], completed: new Set() });
      }
    }
  } catch (error) {
    report('roadmap-device-opens-read', error, failureTags(error));
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
  const rows = [...trees].filter(([, tree]) => !tree.unread).map(([id, tree]) => ({ id, title: tree.title, ...judged.progressOf(id) }));
  return { rows, authoritative: true };
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
    const lattice = joinedRecord(treeId, '', saved);
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

// Removing a tree that lives only on this device, with the steps of the person's other trees here that open it, as the
// server's removal does: each tombstoned with every edge touching it, nothing respliced, and the person's mark on it
// cleared. The device's trees are read first, and a device that cannot read them refuses the delete with nothing removed
// (the read's failure, judged, is the delete's). Then the tree goes, its session `live` closed first where this tab has it
// open. A tree whose record does not join was neither counted nor is taken from. Each other tree takes its own write, so
// one that fails leaves the others' steps gone: the tree open in this tab through `live`, as a local write outside the undo
// journal, and every other through its stored record, as any device edit. A write that fails reports
// `roadmap-device-cascade` once, under the name of what failed.
export async function deleteDeviceTree(treeId, { live = null, registry = new LocalTreeRegistry(), store = new SyncStore(), report = reportRoadmapFailure } = {}) {
  const trees = await readDeviceTrees({ registry, store, report });
  if (live?.treeId === treeId) live.close();
  await deleteLocalTree(treeId);
  let failed = false;
  let failure = null;
  for (const [id, tree] of trees) {
    if (id === treeId || tree.unread) continue;
    try {
      if (live?.treeId === id && live.ready && !live.closed) {
        const unsaved = await live.removeSteps(stepsOpening(live.lattice, treeId));
        if (unsaved) throw unsaved;
      } else {
        await removeStoredSteps(store, id, treeId);
      }
    } catch (error) {
      failed = true;
      failure ??= error;
    }
  }
  if (failed) report('roadmap-device-cascade', failure, failureTags(failure));
}

// The stored record's steps that open `treeId`, pruned under one stamp with the person's marks on them cleared.
async function removeStoredSteps(store, id, treeId) {
  const saved = await store.load(id);
  if (!saved) return;
  await amendDeviceRecord(store, id, saved, (lattice, progress, clock) => {
    const writes = materialize({ kind: 'PruneNodes', nodeIds: stepsOpening(lattice, treeId) }, lattice, clock);
    if (writes.nodes.length === 0) return [];
    lattice.join(writes);
    const at = writes.nodes[0].deletedAt;
    progress.join({ marks: writes.nodes.filter(({ id: step }) => progress.marks.get(step)?.status === 'complete').map(({ id: node }) => ({ node, status: 'none', at })) });
    return ['structure', 'progress'];
  });
}

// Every step on this device that opens `fromId` opens `toId` instead, as when a claim must give that tree a fresh id: an
// ordinary pointer write, through the open tab's session `live` where it holds the tree and through the stored record
// otherwise. Answers the trees whose steps it wrote.
export async function repointDeviceSteps(fromId, toId, { live = null, registry = new LocalTreeRegistry(), store = new SyncStore() } = {}) {
  const written = [];
  for (const row of registry.list()) {
    if (live?.treeId === row.id && live.ready && !live.closed) {
      if (live.repoint(fromId, toId)) written.push(row.id);
      continue;
    }
    const saved = await store.load(row.id);
    if (!saved) continue;
    let wrote = false;
    await amendDeviceRecord(store, row.id, saved, (lattice, progress, clock) => {
      const writes = materialize({ kind: 'Repoint', from: fromId, to: toId }, lattice, clock);
      wrote = writes.nodes.length > 0;
      if (!wrote) return [];
      lattice.join(writes);
      return ['structure'];
    });
    if (wrote) written.push(row.id);
  }
  return written;
}

// The steps of a tree that open `treeId`.
function stepsOpening(lattice, treeId) {
  return lattice.toTreeData().nodes.filter((step) => step.opens === treeId).map((step) => step.id);
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
