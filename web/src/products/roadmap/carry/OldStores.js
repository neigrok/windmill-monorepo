// What roadmap's old bundle kept in this browser (roadmap-on-the-engine.md §8.2), read for the carry-over and deleted once
// carried: each roadmap's record in the sync database (`SyncStore`), its row of the device index (`LocalTreeRegistry`),
// its workspaces (`WorkspaceStore`) and the marks left undrained from before roadmap's own sync (`ProgressStore`).
// `OldRoadmap` says what one roadmap's entries come to as the domain's acts; the carry-over decides where they go. The
// stores that are not sync's stay: the last place, the view, the legend and the ledgers, and the demo's own workspace.
// `CarryNotes` is what the carry-over remembers of them in this browser from one load to the next.

import { hashText } from '../../../platform/sync/core/encoding.js';
import { isOrderKey } from '../../../../../packages/api-contract/sync/reference/core/fracindex.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { CarriedIds, CarriedRoadmap, CarryLedger, CarryMark, CarryRoadmap, CarryStepNote, kept, withinBounds } from '../domain/carry.js';
import { ChangeKind, CreateKind, DeleteKind, MoveKind, RecolourKind } from '../domain/kinds.js';
import { ClearPointer, Complete, Reset, SetPointer } from '../domain/progress.js';
import { WriteRoadmap } from '../domain/roadmaps.js';
import { ChangePrerequisites, ChangeStep, CreateStep, DeleteStep } from '../domain/steps.js';
import { AddStepLink, AddSubtask, ChangeStepLink, ChangeSubtask } from '../domain/workspace.js';
import { DEMO_TREE_ID } from '../demo/demoStage.js';
import { cmpOrder } from '../model/TrunkTree.js';
import { localStorageOrNothing } from '../persistence/browserStorage.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { ProgressStore } from '../persistence/ProgressStore.js';
import { WorkspaceStore } from '../persistence/WorkspaceStore.js';
import { TreeLattice } from '../sync/lattice.js';
import { frameWrites, unconfirmedStamps, writeStamps } from '../sync/pendingWrites.js';
import { ProgressLattice } from '../sync/progressLattice.js';
import { CorruptDeviceRecord, SyncStore } from '../sync/SyncStore.js';

const STEP_FIELDS = ['label', 'icon', 'color', 'description', 'links'];

// One of the domain's acts the carry-over writes, with the record it would write, its words and the name of what it
// belongs to, which the one list keeps where the act cannot land, and what it counts as.
/** @param {'roadmap' | 'change' | 'mark' | 'item'} counted */
const part = (act, subject, values, counted, named = '') => Object.freeze({ act, subject, values, counted, named });

// What the old bundle kept of one roadmap: `index` its row of the device index, `record` its sync record as the store reads
// it, `workspace` its steps' workspaces and `marks` the marks left undrained, each null where its store holds none. A
// record that does not join as a lattice throws `CorruptDeviceRecord`.
export class OldRoadmap {
  constructor(id, { index = null, record = null, workspace = null, marks = null }) {
    this.id = id;
    this.index = index;
    this.record = record;
    this.workspace = workspace;
    this.marks = marks;
    this.lattice = new TreeLattice(id, index?.title ?? '');
    this.progress = new ProgressLattice();
    try {
      if (record) this.lattice.join(record.frame);
      if (record) this.progress.join(record.progress);
    } catch (error) {
      throw new CorruptDeviceRecord(error);
    }
  }

  // A roadmap made signed out: one no account has claimed.
  get madeSignedOut() { return this.index?.claimed === false; }

  // The account its row names: null for one made with nobody signed in, undefined where no row names one.
  get owner() { return this.index ? this.index.owner : undefined; }

  // A roadmap made signed out whose claim the server answered: its record holds what the server confirmed of it, so the
  // server keeps it for the account that claimed it.
  get claimBegan() { return this.madeSignedOut && this.record?.confirmed?.structure != null; }

  // Whether the roadmap goes to `account`'s replica, as that account's list holds it (`listed`: alive, spent or null): one
  // its row names, and one its row names nobody for that the list holds alive, a claim of it having landed.
  belongsTo(account, listed) {
    if (account === null) return false;
    return this.owner === account || (listed === 'alive' && (this.owner ?? null) === null);
  }

  // The roadmap's name as this browser last showed it.
  get name() { return this.lattice.title || this.index?.title || ''; }

  // What its entries hold now, as a digest: a question that counted the roadmap takes it only while they hold the same.
  get fingerprint() { return hashText(JSON.stringify([this.index, this.record, this.workspace, this.marks])).slice(0, 32); }

  // How many changes of the person's the roadmap holds that the ledger has not carried, counted as the room counts them:
  // a roadmap no server holds yet is one change, as making it is, and each of its marks another; a roadmap the server
  // keeps counts each change and mark the carry-over would write; and each workspace item counts, carried or set aside.
  unsentCount(ledger) {
    const items = this.items().filter((item) => ledger.items[item.key] !== item.digest).length;
    if (!this.madeSignedOut || this.claimBegan || ledger.to !== null) return this.changes(this.id, ledger, () => true, (tree) => tree).length + items;
    const marked = [...this.progress.marks].filter(([, mark]) => mark.status === 'complete').map(([step]) => step);
    return 1 + new Set([...marked, ...this.seeds(this.id).map((each) => each.subject.id), ...this.undrained(this.id).map((each) => each.subject.id)]).size + items;
  }

  // The roadmap as the old bundle showed it: its words, its kinds in their order, its present steps in the order its
  // Board drew them (`cmpOrder`), and the links among them.
  roadmap() {
    const { title, guide, nodes, kinds } = this.lattice.toTreeData();
    return {
      title, guide,
      kinds: kinds.map(({ id, hue, label, description }) => ({ id, hue, label, description })),
      steps: [...nodes].sort(cmpOrder).map((step) => ({ id: step.id, order: step.order, ...stepFields(step) })),
      links: this.lattice.liveEdges().map(({ from, to }) => [from, to]),
    };
  }

  // §8.2 A roadmap made signed out, as a creation under `to`: the roadmap with every id it held, then the marks it held
  // (its own lane's, or where the lane holds none its steps' seeds, as a claim would have marked them), the trees its
  // steps open (`opened` names a tree the carry-over moved under a fresh id) and the marks left undrained.
  creation(to, registry, moment, opened) {
    const carried = new CarriedRoadmap(this.id, this.roadmap(), registry, moment);
    const present = new Set(carried.units.map((unit) => String(unit.step.id.record)));
    const marks = [...this.progress.marks].filter(([step, mark]) => mark.status === 'complete' && present.has(step))
      .map(([step]) => part(Complete(to, step), { t: 'progress', id: step }, { mark: { status: 'complete' } }, 'mark'));
    const pointers = this.lattice.toTreeData().nodes.filter((step) => step.opens && present.has(step.id))
      .map((step) => part(SetPointer(to, step.id, opened(step.opens)), { t: 'pointer', id: step.id }, { opens: opened(step.opens) }, 'change'));
    return { kept: carried.kept, parts: [part(new CarryRoadmap(to, carried), { t: 'tree', id: to }, {}, 'roadmap'), ...marks, ...this.seeds(to),
      ...pointers, ...this.undrained(to)] };
  }

  // §8.2 What the old bundle had not sent, as new gestures on `to`: every register above what the server confirmed that
  // the ledger has not carried. `knows(type, id)` says whether the replica knows a step or a kind, present or deleted.
  changes(to, ledger, knows, opened) {
    const { structure, progress } = this.unsent(ledger);
    const steps = new Map(this.lattice.toTreeData().nodes.map((step) => [step.id, step]));
    const kinds = this.lattice.orderedKinds();
    const parts = [];
    const words = Object.fromEntries(['title', 'guide'].filter((name) => structure[name]).map((name) => [name, structure[name].v]));
    if (Object.keys(words).length) parts.push(part(new WriteRoadmap(to, words), { t: 'meta', id: 'meta' }, words, 'change', this.lattice.title));
    for (const row of structure.kinds ?? []) {
      const index = kinds.findIndex((kind) => kind.id === row.id);
      const kind = kinds[index];
      const subject = { t: 'kind', id: row.id };
      if (!kind) {
        if (row.deletedAt && knows('kind', row.id)) parts.push(part(new DeleteKind(to, row.id), subject, {}, 'change'));
        continue;
      }
      const values = { hue: kind.hue, label: kind.label, description: kind.description };
      if (!knows('kind', row.id)) {
        parts.push(part(new CreateKind(to, values), subject, values, 'change'));
        continue;
      }
      const changed = Object.fromEntries(['label', 'description'].filter((name) => row.createdAt || `${name}At` in row).map((name) => [name, kind[name]]));
      if (Object.keys(changed).length) parts.push(part(new ChangeKind(to, row.id, changed), subject, changed, 'change'));
      if (row.createdAt || 'hueAt' in row) parts.push(part(new RecolourKind(to, row.id, kind.hue), subject, { hue: kind.hue }, 'change'));
      if ('rankAt' in row) parts.push(part(new MoveKind(to, row.id, kinds[index - 1]?.id ?? null), subject, {}, 'change'));
    }
    for (const row of structure.nodes ?? []) {
      const step = steps.get(row.id);
      const subject = { t: 'node', id: row.id };
      if (!step) {
        if (row.deletedAt && knows('node', row.id)) parts.push(part(new DeleteStep(to, row.id), subject, {}, 'change', this.nameOf(row.id)));
        continue;
      }
      const fields = stepFields(step);
      if (!knows('node', row.id)) parts.push(part(new CreateStep(to, fields, [], row.id), subject, fields, 'change'));
      else {
        const changed = Object.fromEntries(STEP_FIELDS.filter((name) => row.createdAt || `${name}At` in row).map((name) => [name, fields[name]]));
        if ('orderAt' in row && isOrderKey(step.order)) changed.ord = step.order;
        if (Object.keys(changed).length) parts.push(part(new ChangeStep(to, row.id, changed), subject, changed, 'change', step.label));
      }
      if ('opensAt' in row) {
        const opens = step.opens ? opened(step.opens) : null;
        parts.push(part(opens ? SetPointer(to, row.id, opens) : ClearPointer(to, row.id), { t: 'pointer', id: row.id }, { opens }, 'change'));
      }
    }
    const linking = new Map();
    for (const row of structure.edges ?? []) {
      const live = this.lattice.edgePresent(row.from, row.to);
      const change = linking.get(row.to) ?? { add: [], remove: [] };
      if (live && row.addedAt) change.add.push(row.from);
      else if (!live && row.removedAt) change.remove.push(row.from);
      else continue;
      linking.set(row.to, change);
    }
    for (const [step, change] of linking) parts.push(part(new ChangePrerequisites(to, step, change), { t: 'edge', id: step }, {}, 'change'));
    for (const row of progress.marks ?? []) {
      const act = row.status === 'complete' ? Complete(to, row.node) : Reset(to, row.node);
      parts.push(part(act, { t: 'progress', id: row.node }, { mark: { status: row.status } }, 'mark'));
    }
    return [...parts, ...(this.madeSignedOut ? this.seeds(to) : []), ...(ledger.marks === this.marksDigest ? [] : this.undrained(to))];
  }

  // The registers above what the server confirmed, less those the ledger carried: of the structure, and of the person's
  // marks.
  unsent(ledger) {
    const pending = (frame, confirmed) => {
      const unconfirmed = unconfirmedStamps(writeStamps(frame), writeStamps(confirmed ?? {}));
      return frameWrites(frame, (key, stamp) => unconfirmed[key] === stamp && !ledger.carried(stamp));
    };
    return { structure: pending(this.lattice.toFrame(), this.record?.confirmed?.structure), progress: pending(this.progress.toFrame(), this.record?.confirmed?.progress) };
  }

  // Whether the record holds a change the server has not confirmed.
  get changed() {
    const { structure, progress } = this.unsent(new CarryLedger());
    return [structure.nodes, structure.edges, structure.kinds, progress.marks].some((rows) => rows?.length) || !!structure.title || !!structure.guide;
  }

  // The newest stamp of each writer of the record: what a carry of all of it covers, or of the registers `unsent` reads.
  frontier(ledger = null) {
    const frames = ledger === null ? { structure: this.lattice.toFrame(), progress: this.progress.toFrame() } : this.unsent(ledger);
    const vector = new TreeLattice().join(frames.structure);
    vector.join(new ProgressLattice().join(frames.progress));
    return vector.toJSON();
  }

  // §8.2 A step a claim would have marked from its seed is marked: where the roadmap's own lane holds no mark, each present
  // step whose seed is complete, unless the person holds a mark of it.
  seeds(to) {
    if (this.progress.marks.size > 0) return [];
    return this.lattice.toTreeData().nodes.filter((step) => step.status === 'complete')
      .map((step) => part(new CarryMark(to, step.id), { t: 'progress', id: step.id }, { mark: { status: 'complete' } }, 'mark'));
  }

  // §8.2 The marks left undrained from before roadmap's own sync: each completed step, unless the person holds a mark
  // of it.
  undrained(to) {
    return ProgressStore.marksOf(this.marks).filter((mark) => mark.status === 'complete')
      .map((mark) => part(new CarryMark(to, mark.node), { t: 'progress', id: mark.node }, { mark: { status: 'complete' } }, 'mark'));
  }

  // A digest of the marks left undrained, for the ledger.
  get marksDigest() { return this.marks === null ? null : hashText(jcs(this.marks)).slice(0, 16); }

  // Each workspace item, by the key the ledger keeps it under (its step, its kind and its old id) with a digest of what it
  // holds. An entry that does not read as an item is none.
  items() {
    const entries = (list) => (Array.isArray(list) ? list.filter((each) => each !== null && typeof each === 'object' && each.id !== undefined) : []);
    const workspaces = this.workspace !== null && typeof this.workspace === 'object' ? Object.entries(this.workspace) : [];
    return workspaces.flatMap(([step, workspace]) => [
      ...entries(workspace?.subtasks).map((subtask) => ({ step, type: 'subtask', old: String(subtask.id), values: { label: String(subtask.label ?? ''), done: subtask.done === true } })),
      ...entries(workspace?.links).map((link) => ({ step, type: 'stepLink', old: String(link.id), values: { url: String(link.url ?? ''), title: String(link.title ?? '') } })),
      ...(typeof workspace?.note === 'string' && workspace.note !== '' ? [{ step, type: 'stepNote', old: step, values: { text: workspace.note } }] : []),
    ]).map((item) => ({ ...item, key: jcs([item.step, item.type, item.old]), digest: hashText(jcs(item.values)).slice(0, 16) }));
  }

  // §8.2 The workspaces kept on this device, on the steps of `to`: each subtask and link under an id derived from its old
  // one, made once, or changed where the old bundle changed it after it was carried, and each note written after the one
  // its step holds. What the ledger carried as it holds now writes nothing. An item past a bound of §4 is no part: it is
  // set aside whole for the one list (`kept`), before any act is tried.
  carriedWorkspace(to, ledger) {
    const parts = this.items().filter((item) => ledger.items[item.key] !== item.digest).map((item) => {
      const id = CarriedIds.item(item.type, this.id, item.step, item.old);
      const known = ledger.items[item.key] !== undefined;
      const named = this.nameOf(item.step);
      if (item.type === 'stepNote') return part(new CarryStepNote(to, item.step, item.values.text), { t: 'stepNote', id: item.step }, item.values, 'item', named);
      const values = { step: item.step, ...item.values };
      if (item.type === 'subtask') {
        const act = known ? ChangeSubtask(to, id, item.values) : AddSubtask(to, item.step, item.values.label, { id, done: item.values.done });
        return part(act, { t: 'subtask', id }, values, 'item', named);
      }
      const act = known ? ChangeStepLink(to, id, item.values) : AddStepLink(to, item.step, item.values, { id });
      return part(act, { t: 'stepLink', id }, values, 'item', named);
    });
    const bounded = (each) => withinBounds(each.subject.t, each.values);
    return { parts: parts.filter(bounded), kept: parts.filter((each) => !bounded(each)).map((each) => kept(this.id, 'pastBound', each.subject, each.values, each.named)) };
  }

  // A step's name as the old bundle last held it, present or deleted.
  nameOf(step) { return this.lattice.nodes.get(step)?.label.v ?? ''; }

  // The ledger's record of every workspace item, as the carry-over carries or sets each aside.
  get itemDigests() { return Object.fromEntries(this.items().map((item) => [item.key, item.digest])); }
}

// A present step's fields as the old server read them for the engine: a link with no address carries nothing.
function stepFields(step) {
  return { label: step.label ?? '', icon: step.icon ?? '', color: step.color ?? 'terracotta', description: step.description ?? '',
    links: (step.links ?? []).filter((link) => link.url.trim() !== '').map((link) => ({ url: link.url, label: link.label ?? '' })) };
}

// The old bundle's stores, each reached through the class that kept it.
export class OldStores {
  constructor({ store = new SyncStore(), index = new LocalTreeRegistry(), workspaces = new WorkspaceStore(), marks = new ProgressStore() } = {}) {
    this.store = store;
    this.index = index;
    this.workspaces = workspaces;
    this.marks = marks;
  }

  // Every roadmap any old store names, and each entry that could not be read: `{ store, entry, error }`, the store
  // `sync`, `index`, `workspace` or `marks` and the roadmap whose entry it is (null for the whole index). A roadmap whose
  // record or index row cannot be read is left out, every entry of it kept; a row that does not read leaves every other
  // row read. The demo's workspace is the demo's, no old store's.
  async read() {
    const unread = [];
    let rows = {};
    try {
      const index = this.index.readRows();
      rows = index.rows;
      for (const id of index.malformed) unread.push({ store: 'index', entry: id, error: new TypeError('device index row does not read') });
    } catch (error) {
      unread.push({ store: 'index', entry: null, error });
    }
    let held = [];
    try {
      held = await this.store.treeIds({ durable: true });
    } catch (error) {
      unread.push({ store: 'sync', entry: null, error });
      return { roadmaps: [], unread };
    }
    const workspaces = new Set(this.workspaces.treeIds());
    const marks = new Set(this.marks.treeIds());
    const left = new Set([DEMO_TREE_ID, ...unread.map(({ entry }) => entry)]);
    const roadmaps = [];
    for (const id of new Set([...Object.keys(rows), ...held, ...workspaces, ...marks])) {
      if (left.has(id)) continue;
      const workspace = workspaces.has(id) ? this.workspaces.load(id) : null;
      if (workspaces.has(id) && workspace === null) unread.push({ store: 'workspace', entry: id, error: new SyntaxError('workspace does not read') });
      const legacy = marks.has(id) ? this.marks.load(id) : null;
      if (marks.has(id) && legacy === null) unread.push({ store: 'marks', entry: id, error: new SyntaxError('marks do not read') });
      try {
        const record = held.includes(id) ? await this.store.load(id) : null;
        roadmaps.push(new OldRoadmap(id, { index: rows[id] ?? null, record, workspace, marks: legacy }));
      } catch (error) {
        unread.push({ store: 'sync', entry: id, error });
      }
    }
    return { roadmaps, unread };
  }

  // §8.2 INV-4: once the ledger shows a roadmap carried, each of its entries goes, and only while it still holds what the
  // carry-over read, so what an old tab wrote since stays for the next load. Its row of the device index goes once its
  // record has. Answers how many entries went.
  async forget(roadmap) {
    const record = roadmap.record === null || await this.store.clearIfStill(roadmap.id, roadmap.record);
    const gone = [
      roadmap.record !== null && record,
      roadmap.workspace !== null && this.workspaces.clearIfStill(roadmap.id, roadmap.workspace),
      roadmap.marks !== null && this.marks.clearIfStill(roadmap.id, roadmap.marks),
      roadmap.index !== null && record && this.index.removeIfStill(roadmap.id, roadmap.index),
    ];
    return gone.filter(Boolean).length;
  }

  // An account's Discard (§5 Signed out, §8.2): each old roadmap `taken` names goes uncarried, its entries only while
  // they hold what was read. Answers how many roadmaps it took.
  async discard(taken) {
    const { roadmaps } = await this.read();
    let discarded = 0;
    for (const roadmap of roadmaps.filter(taken)) if (await this.forget(roadmap) > 0) discarded += 1;
    return discarded;
  }
}

const NOTES = 'windmill:roadmap:carry-notes';

// How many digests each list of the notes keeps, the newest last.
const NOTED = 100;

const digest = (value) => hashText(jcs(value)).slice(0, 16);

const noNotes = () => ({ reported: [], waiting: null, recordless: [], counted: null });

let pageNotes = noNotes();

// What the carry-over remembers in this browser from one load to the next, in `localStorage` and never sent: digests of
// the unread entries it reported, so each is reported once; a digest of the roadmaps a run left waiting, so a run that
// leaves the same ones says nothing; digests of the index rows it found with no record, each forgotten as empty only once
// a later load finds it so too; and the old roadmaps a sign-out question counted (`counted`), which its Discard takes. A
// browser that refuses storage remembers for the page alone.
export class CarryNotes {
  constructor(storage = localStorageOrNothing()) {
    this.storage = storage;
  }

  get notes() {
    try {
      const stored = JSON.parse(this.storage.getItem(NOTES) ?? 'null');
      if (stored === null) return noNotes();
      return { ...noNotes(), ...stored };
    } catch {
      return pageNotes;
    }
  }

  save(notes) {
    pageNotes = notes;
    try { this.storage.setItem(NOTES, JSON.stringify(notes)); } catch { /* the page keeps them */ }
  }

  // Of the unread entries (`{ store, entry }`), those this browser has not reported, which count as reported from here on.
  unreported(unread) {
    const notes = this.notes;
    const fresh = unread.filter(({ store, entry }) => !notes.reported.includes(digest([store, entry])));
    if (fresh.length > 0) this.save({ ...notes, reported: [...notes.reported, ...fresh.map(({ store, entry }) => digest([store, entry]))].slice(-NOTED) });
    return fresh;
  }

  // Whether the roadmaps a run leaves waiting, by id, are others than the last run left; remembers them.
  waitingChanged(ids) {
    const notes = this.notes;
    const waiting = ids.length === 0 ? null : digest([...ids].sort());
    if (waiting === notes.waiting) return false;
    this.save({ ...notes, waiting });
    return true;
  }

  // Whether an earlier load found this roadmap's index row, as it is now, with no record; remembers it found so now.
  recordlessBefore(roadmap) {
    const notes = this.notes;
    const seen = digest([roadmap.id, roadmap.index]);
    if (notes.recordless.includes(seen)) return true;
    this.save({ ...notes, recordless: [...notes.recordless, seen].slice(-NOTED) });
    return false;
  }

  // The old roadmaps a sign-out question counted: `{ account, roadmaps }`, each roadmap's id with its fingerprint, or null.
  get counted() { return this.notes.counted; }

  set counted(counted) { this.save({ ...this.notes, counted }); }
}
