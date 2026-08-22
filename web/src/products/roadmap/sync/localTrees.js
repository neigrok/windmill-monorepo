// Local-born trees (anon-first-tree F1/F3): the signed-out lifecycle of a tree that
// lives entirely on this device — bearing one, renaming or deleting one from the
// switcher's local rows, and moving one under a fresh id when a claim hits the
// (cryptographically unreachable) id-taken wall. Everything durable rides the same
// lattice blob + per-tree stores the synced path uses, so a later claim is a plain
// create + flush, never a migration.

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

// t_ + 16 lowercase hex — byte-identical to the server's own tree ids, so the id
// survives the claim (POST /v1/trees keeps a client-minted id).
export function mintTreeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `t_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const BIRTH_OWNER_WAIT_MS = 2000;

// Who to stamp a newborn tree for. The identity probe decides it, but a birth must never wait on
// the network: past a couple of seconds we plant with whatever this load has already confirmed,
// which on an unconfirmed device is "anonymous" — the honest reading of a tree planted by a browser
// that cannot prove an account, and the reading that keeps the claim door open for it. A dead
// network answers immediately (fetch rejects) and lands in the same place.
function ownerForBirth() {
  return Promise.race([
    resolveDeviceOwner(),
    new Promise((resolve) => { setTimeout(() => resolve(deviceOwner()), BIRTH_OWNER_WAIT_MS); }),
  ]);
}

// Signed-out ↵ on the birth canvas: the registry entry first (the claim's durable
// input), then the lattice — the default legend at genesis (so it converges with the
// server's claim-create, zero duplication) and the named root as a real stamped write
// (so the claim's flush carries it up) — persisted to IndexedDB before the caller
// navigates into the tree.
export async function bearLocalTree({ title }) {
  const treeId = mintTreeId();
  // Who this device is stamps the row (audit WEB-4), and it is asked of the server: a browser whose
  // last account never signed out remembers them, and stamping a stranger's birth with that would
  // hide the tree from the person planting it.
  new LocalTreeRegistry().record(treeId, title, await ownerForBirth());
  const session = new SyncSession({ treeId, title });
  session.seed({ id: treeId, title, nodes: [], kinds: DEFAULT_KINDS });
  const rootId = crypto.randomUUID?.() ?? `n-${Date.now()}`;
  session.dispatch({ kind: 'CreateNode', id: rootId, label: title, icon: 'sparkles', color: DEFAULT_KINDS[0].hue, x: 0, y: 0 });
  await session.persistNow();
  session.close();
  return treeId;
}

// The paste-import plant, signed out (F3): same soil as bearLocalTree — the registry
// entry, then the lattice seeded with the DEFAULT legend at genesis. NEVER the parsed
// kinds: the claim converges with the server's empty create only while both sides seed
// byte-equal legends (the vite.config.js pin). The parsed legend arrives as stamped
// gestures instead — the diff first, while no node yet wears a hue RecolorKind could
// repaint — and then the whole subgraph lands under ONE stamp, one undo entry. Imported
// [x] marks are status SEEDS on the document, not progress rows: loadProgress's seed
// fallback shows them everywhere, and the owner's reconcile promotes them.
export async function bearImportedTree({ title, nodes, kinds }) {
  const treeId = mintTreeId();
  new LocalTreeRegistry().record(treeId, title, await ownerForBirth());
  const session = new SyncSession({ treeId, title });
  session.seed({ id: treeId, title, nodes: [], kinds: DEFAULT_KINDS });
  // LOAD-BEARING ORDER: the legend diff goes first, while no node wears a hue yet.
  // RecolorKind repaints every node of the old hue as it lands, so a recolor after the
  // import would silently repaint imported nodes. Never swap these two lines.
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

// What separates the parsed legend from the genesis seed, as ordinary kind gestures —
// exactly what a user doing it by hand would have dispatched.
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

// This device's own answer for a tree the server did not give us — a local-born tree, or any
// tree while we are offline: the lattice blob replayed into the same TreeData shape a server
// seed has, or null when this browser has no standing to open it.
//
// The standing is the whole point (audit WEB-4). The blob is keyed by tree id alone, so before
// this gate a stranger typing #/app/<id> — or the next person on a shared browser landing there
// from a stale bare #/app — painted the previous account's private tree in full, title, node
// labels and all, while every server read for them 404'd. A device row visible to the account
// the SERVER says is here is the only thing that opens the door; the remembered marker is not
// asked, because a browser killed instead of signed out leaves it naming the person who left.
export async function loadDeviceTree(treeId) {
  const entry = new LocalTreeRegistry().get(treeId, await resolveDeviceOwner());
  if (!entry) return null;
  const saved = await new SyncStore().load(treeId).catch(() => null);
  if (!saved?.frame) return null;
  const lattice = new TreeLattice(treeId, entry.title ?? '');
  lattice.join(saved.frame);
  const seed = lattice.toTreeData();
  // The blob path carries no server `mine` bit, and a device row visible to this account IS this
  // account's (or its own anonymous work). Without it an anon's planted quest loads mine=false and,
  // on a phone, mobileEditable is false: a read-only dead end with no verb rail and no fork (it is
  // yours, so there is nothing to fork). Ownership gates editing, not width (M0).
  seed.mine = true;
  return seed;
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
  // The three per-tree ledgers are this device's memory of the tree too — the completed set the
  // last visit left, the milestones already offered, what the last share claimed. A tree that is
  // gone must not leave them behind for the next opener of this browser to inherit.
  new ReturnLedger().clear(treeId);
  new MilestoneLedger().clear(treeId);
  new ShareLedger().clear(treeId);
  new LocalTreeRegistry().remove(treeId);
  new PlaceStore().forget(treeId); // a dead last-place would dead-end the next magic-link landing
}

// The account hand-off (audit WEB-4): the roadmap gives this device up when the account holding
// it changes. Everything that is not anonymous goes — every device-index row stamped for an
// account, its workspace, progress, legend and ledgers, its lattice blob, and any per-tree residue
// whose index row was lost long ago (that orphan blob is what painted a signed-out browser the
// previous person's whole private tree).
//
// Dropping a signed-in account's local copy costs that account nothing: the server holds the tree
// and hands it back on their next sign-in — so this is not a leak to "restore" later. Anonymous
// rows stay: that work belongs to the device, and it is meant to follow whoever signs in next.
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
