// Today's reading of a roadmap, the room's default while the replica's waits behind its switch: the server's tree, or
// the device's copy where the server has none to give, then roadmap's own session for every change after. It works out
// what the trees a step opens come to: the server's read, or the device's own rule for a tree that lives only here.

import { DEMO_STAGED_COMPLETED } from '../demo/demoStage.js';
import { Openings } from '../model/Opening.js';
import { OpenedTrees } from '../model/OpenedTrees.js';
import { HttpTreeRepository } from '../persistence/HttpTreeRepository.js';
import { LocalTreeRegistry, deviceOwnerAnswered, resolveDeviceOwner } from '../persistence/LocalTreeRegistry.js';
import { SyncSession } from '../sync/SyncSession.js';
import { refusalReporter } from '../sync/refusals.js';
import { loadDeviceMarks, loadDeviceTree, readDeviceTrees } from '../sync/localTrees.js';

const deviceTrees = new LocalTreeRegistry();
// A read of what the trees steps open waits this long after the confirmation that asks for it, so a burst asks once,
// and is given this long.
const POINTER_READ_AFTER_MS = 600;
const POINTER_READ_LIMIT_MS = 10000;

// What the server or this device holds for the confirmed owner, with the marks its room shows: the server's, or those of
// the device's record its session restores. A tree neither has is an expected answer.
async function readRoadmap({ treeId, demo, signal }) {
  const repo = new HttpTreeRepository({ treeId });
  let seed = null;
  try { seed = await repo.loadTree({ signal }); } catch { /* fall through to the blob */ }
  if (signal.aborted) return null;
  const fromDevice = !seed;
  if (fromDevice) seed = await loadDeviceTree(treeId, { ownerResolved: true });
  if (!seed) return { unknown: true };
  const overlay = demo
    ? { completed: new Set(DEMO_STAGED_COMPLETED), completedAt: {}, server: false }
    : await (fromDevice ? loadDeviceMarks(seed) : repo.loadProgress(seed, { signal }));
  const serverActivity = await repo.loadActivity({ limit: 200, signal });
  return { seed, overlay, serverActivity };
}

// A roadmap's pointers in one word, so a change of any of them shows.
const pointersOf = (tree) => tree.nodes.flatMap((step) => (step.opens ? `${step.id}>${step.opens}` : [])).join(' ');

// What the trees a device tree's steps open come to, worked out on the device over its own trees, with `tree`'s steps as
// they stand now. A read the device could not make, already reported, leaves every pointer unread.
async function openingsOnDevice(tree) {
  let trees;
  try {
    trees = await readDeviceTrees();
  } catch {
    return new Openings();
  }
  trees.set(tree.id, { completed: new Set(), ...trees.get(tree.id), title: tree.title, nodes: tree.nodes });
  return new OpenedTrees(trees).openings(tree.id);
}

export class LatticeReading {
  // `known` holds what the picker knew of a tree chosen here, `<step>><tree>`, until the server's read; `room` the
  // handles the session takes its seat in.
  constructor({ treeId, demo, shared, demotion, known, room }) {
    this.treeId = treeId;
    this.demo = demo;
    this.shared = shared;
    this.demotion = demotion;
    this.known = known;
    this.room = room;
    this.session = null;
    this.closed = false;
  }

  // The room's status line reads roadmap's own session, once it is following.
  get status() { return this.session; }

  // Device reads wait for the holder the shell confirms: this document's server answer, or the replica it restores.
  async settleHolder() {
    await resolveDeviceOwner();
    await deviceOwnerAnswered();
  }

  // The roadmap with every step that opens a tree carrying its opening; null where neither the server nor this device
  // holds it. A step that owns a subtree opens it for anyone who reads the tree. Only its owner's room reads the tree a
  // step's pointer names: anyone else sees such a step as an ordinary one. A tree that lives only here, until a claim
  // takes it to the account, has its facts worked out on the device, and its projection is the device's own word, so its
  // pointers always decide. Any other copy from the device read none, so its pointers stand unread.
  async read({ signal }) {
    const read = await readRoadmap({ treeId: this.treeId, demo: this.demo, signal });
    if (!read || read.unknown) return null;
    this.loaded = read.seed;
    this.owner = read.seed.mine === true && !this.shared && !this.demo;
    this.openings = !this.owner ? read.seed.openings?.subtreesAlone() ?? null
      : this.onDevice() ? await openingsOnDevice(read.seed) : read.seed.openings ?? new Openings();
    this.shown = this.standing(read.seed, false);
    return { seed: this.shown, overlay: read.overlay, serverActivity: read.serverActivity };
  }

  onDevice() { return this.owner && new LocalTreeRegistry().onDevice(this.loaded.id) !== null; }

  standing(projection, joined, own = new Set(), subtrees = new Map()) {
    return this.openings
      ? this.openings.onto(projection, { joined: joined || this.onDevice(), own, known: this.known.current, subtrees })
      : projection;
  }

  // Roadmap's own session for every change after the load. Only owned trees enter the device index, so a visited share
  // cannot be claimed.
  follow({ onTree, onProgress }) {
    const { sessionRef, peersRef } = this.room;
    const { treeId } = this;
    sessionRef.current?.close();
    peersRef.current.clear();
    let projected = this.loaded;
    let shown = this.shown;
    // What the room stands shows its pointers' facts, and tells the session which lead to no tree: a mark there is an
    // ordinary mark and is owed, as the server records it.
    const stand = () => {
      shown = this.standing(projected, session.joinedServer, session.ownPointers(), session.subtrees());
      session.pointersLeadNowhere(shown.nodes.flatMap((step) => (step.opening?.dangling ? [[step.id, step.opening.treeId]] : [])));
      onTree(shown);
      return shown;
    };
    // The facts follow the pointers the server holds. A pointer the room has no read facts of (unread, or as the picker
    // knew it) is read once the server has confirmed it: this device's own on its ack, a peer's with its frame. A read
    // that fails, or still says nothing of it, waits for the next confirmation or reconnect. Only a writer's read says
    // more than its load: a reader's room fills its subtrees from the load and the subtree frames, and reads no more.
    let asked = '';
    const followPointers = () => {
      if (this.onDevice() || !this.openings?.read || this.loaded.mine !== true) return;
      const own = session.ownPointers();
      const lacking = shown.nodes.flatMap((step) => (step.opening && (!step.opening.read || step.opening.provisional) && !own.has(step.id)
        ? `${step.id}>${step.opening.treeId}` : [])).join(' ');
      const ask = `${session.confirmations} ${lacking}`;
      if (lacking === '' || ask === asked) return;
      asked = ask;
      setTimeout(async () => {
        if (this.closed || asked !== ask) return;
        const fresh = await new HttpTreeRepository({ treeId }).loadTree({ signal: AbortSignal.timeout(POINTER_READ_LIMIT_MS) }).catch(() => null);
        if (this.closed || fresh?.mine !== true) return;
        this.openings = this.owner ? fresh.openings : fresh.openings.subtreesAlone();
        stand();
      }, POINTER_READ_AFTER_MS);
    };
    // On the device the facts are worked out again whenever a pointer changes, and the last read asked stands.
    let pointersRead = pointersOf(this.loaded);
    const followOnDevice = () => {
      const pointers = pointersOf(projected);
      if (pointers === pointersRead) return;
      pointersRead = pointers;
      openingsOnDevice(projected).then((fresh) => {
        if (this.closed || pointersRead !== pointers || !this.onDevice()) return;
        this.openings = fresh;
        stand();
      });
    };
    // A subtree is no row of this device's index: the switcher lists roots alone.
    const subtree = this.shown.place?.subtree === true;
    const session = new SyncSession({
      treeId: this.shown.id, title: this.shown.title, guide: this.shown.guide ?? '', subtree,
      registry: this.shown.mine && !this.shared && !this.demo && !this.demotion && !subtree ? deviceTrees : null,
    })
      .onTreeChanged((data) => {
        projected = data;
        stand();
        if (this.onDevice()) followOnDevice();
        else followPointers();
      })
      .onConfirmed(followPointers)
      .onPresence((frame) => peersRef.current.set(frame.actor, {
        name: frame.profile?.name, color: frame.profile?.color,
        cursor: frame.cursor ?? null, selection: frame.selection ?? null,
      }))
      .onPeer((frame) => {
        if (frame.event === 'leave') { peersRef.current.delete(frame.actor); return; }
        if (!peersRef.current.has(frame.actor)) {
          peersRef.current.set(frame.actor, { name: frame.profile?.name, color: frame.profile?.color, cursor: null, selection: null });
        }
      })
      .onProgress(onProgress);
    sessionRef.current = session;
    session.subscribeRefusals(refusalReporter());
    this.session = session;
    session.start();
  }

  close() { this.closed = true; }
}
