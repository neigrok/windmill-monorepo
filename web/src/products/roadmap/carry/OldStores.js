// What roadmap's old bundle kept in this browser (roadmap-on-the-engine.md §8.2), read for the carry-over and deleted once
// carried: each roadmap's record in the sync database (`SyncStore`), its row of the device index (`LocalTreeRegistry`),
// its workspaces (`WorkspaceStore`) and the marks left undrained from before roadmap's present sync (`ProgressStore`).
// `OldRoadmap` says what one roadmap's entries come to as the domain's acts; the carry-over decides where they go. The
// stores that are not sync's stay: the last place, the view, the legend and the ledgers.

import { hashText } from '../../../platform/sync/core/encoding.js';
import { isOrderKey } from '../../../../../packages/api-contract/sync/reference/core/fracindex.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { CarriedIds, CarriedRoadmap, CarryLedger, CarryMark, CarryRoadmap, CarryStepNote } from '../domain/carry.js';
import { ChangeKind, CreateKind, DeleteKind, MoveKind, RecolourKind } from '../domain/kinds.js';
import { ClearPointer, Complete, Reset, SetPointer } from '../domain/progress.js';
import { WriteRoadmap } from '../domain/roadmaps.js';
import { ChangePrerequisites, ChangeStep, CreateStep, DeleteStep } from '../domain/steps.js';
import { AddStepLink, AddSubtask, ChangeStepLink, ChangeSubtask } from '../domain/workspace.js';
import { cmpOrder } from '../model/TrunkTree.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { ProgressStore } from '../persistence/ProgressStore.js';
import { WorkspaceStore } from '../persistence/WorkspaceStore.js';
import { TreeLattice } from '../sync/lattice.js';
import { CorruptDeviceRecord } from '../sync/localTrees.js';
import { frameWrites, unconfirmedStamps, writeStamps } from '../sync/pendingWrites.js';
import { ProgressLattice } from '../sync/progressLattice.js';
import { SyncStore } from '../sync/SyncStore.js';

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

  // §8.2 The marks left undrained from before roadmap's present sync: each completed step, unless the person holds a mark
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
  // its step holds. What the ledger carried as it holds now writes nothing.
  workspaceParts(to, ledger) {
    return this.items().filter((item) => ledger.items[item.key] !== item.digest).map((item) => {
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

  // Every roadmap any old store names, and each store that could not be read: `{ store, error }`, the store `sync`,
  // `index`, `workspace` or `marks`. A roadmap whose record cannot be read is left out, every entry of it kept.
  async read() {
    const unread = [];
    let rows = {};
    try {
      rows = this.index.rows();
    } catch (error) {
      unread.push({ store: 'index', error });
    }
    let held = [];
    try {
      held = await this.store.treeIds({ durable: true });
    } catch (error) {
      unread.push({ store: 'sync', error });
      return { roadmaps: [], unread };
    }
    const workspaces = new Set(this.workspaces.treeIds());
    const marks = new Set(this.marks.treeIds());
    const roadmaps = [];
    for (const id of new Set([...Object.keys(rows), ...held, ...workspaces, ...marks])) {
      const workspace = workspaces.has(id) ? this.workspaces.load(id) : null;
      if (workspaces.has(id) && workspace === null) unread.push({ store: 'workspace', error: new SyntaxError('workspace does not read') });
      const legacy = marks.has(id) ? this.marks.load(id) : null;
      if (marks.has(id) && legacy === null) unread.push({ store: 'marks', error: new SyntaxError('marks do not read') });
      try {
        const record = held.includes(id) ? await this.store.load(id) : null;
        roadmaps.push(new OldRoadmap(id, { index: rows[id] ?? null, record, workspace, marks: legacy }));
      } catch (error) {
        unread.push({ store: 'sync', error });
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
}
