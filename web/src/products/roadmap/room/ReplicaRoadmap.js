// The room's edge on the device's copy (roadmap-on-the-engine.md §8.4): what the replica holds of the account's roadmaps,
// read through the domain, in the shapes the Graph, the Board, the step page, the layout and the scene read today.
// Nothing here is a rule. What a step follows, where a roadmap sits and whether it stands, what a step opens, what
// stands complete and when, the guides above a roadmap and which kind wears a hue are the domain's reads.

import { Fields } from '../../../platform/domain-kit/entities.js';
import { Reader, Views } from '../../../platform/domain-kit/reading.js';
import { FixedZone, Instant, Moment } from '../../../platform/domain-kit/time.js';
import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';
import { RoadmapAccount } from '../domain/account.js';
import { RoadmapKind } from '../domain/kinds.js';
import { StepMark, StepPointer } from '../domain/progress.js';
import { LegendRead } from '../domain/reads.js';
import { RoadmapTree } from '../domain/records.js';
import { Roadmap, RoadmapMeta, RoadmapMetaValue } from '../domain/roadmaps.js';
import { RoadmapScopes } from '../domain/roadmapRules.js';
import { readTree } from '../domain/steps.js';
import { StepLink, StepNote, Subtask } from '../domain/workspace.js';
import { Opening, TreePlace } from '../model/Opening.js';

// The domain's reads of a roadmap read no time.
const TIMELESS = new Moment(new Instant(0), new FixedZone(0));

const alive = (record) => record.life?.[0] === 'alive';

// The `{tree, step}` a subtree's record or meta names as its place, null for a root, as the domain's `Roadmap` reads it.
export const placeOf = (record) => (record ? Roadmap.decode(Fields.record({ ...record, t: Roadmap.type })).parent : null);

// What the replica holds of one roadmap: its record in the account's list (null for one someone else owns), its tree
// scope's records, its owner's overlay of it and the stamp of each mark there the server has received, and whether the
// device has read its tree scope (`read`): it holds records of it, or the server has answered for it.
export class HeldRoadmap {
  constructor({ id, record = null, tree = [], overlay = [], received = new Map(), read = true }) {
    this.id = id;
    this.record = record;
    this.records = tree;
    this.overlay = overlay;
    this.received = received;
    this.read = read || tree.length > 0;
    Object.freeze(this);
  }

  // Whether its tree scope holds anything at all: a roadmap the device has read and holds nothing of is no roadmap.
  get holds() { return this.records.length > 0; }

  // When the server last received any record of it: its record, its tree or its owner's overlay.
  get updatedAt() {
    const times = [this.record, ...this.records, ...this.overlay].flatMap((record) => (Number.isFinite(record?.ru) ? [record.ru] : []));
    return times.length ? Math.max(...times) : null;
  }

  // The domain's normalized roadmap: the steps and links as the domain reads its tree scope, absent ones included,
  // with its meta, its kinds, the owner's marks and pointers. A mark's date is the server's receipt where the server
  // holds that very mark, else the device's stamp.
  tree(registry) {
    const scope = RoadmapScopes.tree(this.id);
    const read = new Reader(Views.ofRecords(registry, { drawn: this.records, stored: this.records }), scope, TIMELESS);
    const steps = readTree(this.id, read);
    const nodeRecords = new Map(this.records.filter((record) => record.t === 'node').map((record) => [record.id, record]));
    const metaRecord = read.repository(RoadmapMeta).record('meta', 'drawn');
    const meta = metaRecord ? RoadmapMeta.decode(Fields.record(metaRecord)) : RoadmapMetaValue.blank();
    return new RoadmapTree({
      id: this.id,
      present: this.record === null || alive(this.record),
      read: this.read ? 'loaded' : 'unread',
      parent: placeOf(this.record ?? metaRecord),
      meta: { title: meta.title, guide: meta.guide, guideInherited: metaRecord ? Fields.record(metaRecord).bool('guideInherited', false) : false,
        root: meta.root ?? this.id, depth: meta.depth, visibility: meta.visibility, reach: meta.reach },
      nodes: steps.nodes.map((step) => ({ ...step, branchStamp: nodeRecords.get(step.id)?.f?.branch?.[1] ?? null })),
      edges: steps.edges,
      kinds: this.records.filter((record) => record.t === RoadmapKind.type).map((record) => {
        const kind = RoadmapKind.decode(Fields.record(record));
        return { id: String(record.id), present: alive(record), born: record.born ?? null, hue: kind.hue, label: kind.label,
          description: kind.description, ord: kind.ord ?? '' };
      }),
      marks: this.overlay.filter((record) => record.t === StepMark.type).map((record) => {
        const mark = StepMark.decode(Fields.record(record));
        const stamp = record.f?.mark?.[1] ?? null;
        const received = stamp !== null && this.received.get(record.id) === stamp;
        return { node: String(record.id), status: mark.status, outOfOrder: mark.outOfOrder, stamp,
          recordedAt: received ? record.ru ?? null : null, deviceAt: stamp === null ? null : Stamp.parse(stamp).ms };
      }),
      pointers: this.overlay.filter((record) => record.t === StepPointer.type).map((record) => ({
        node: String(record.id), present: alive(record), opens: StepPointer.decode(Fields.record(record)).opens, setAt: record.f?.opens?.[1] ?? null,
      })),
    });
  }

  // The owner's workspace of each step, as the step page reads it: subtasks and links in their own order, and the note.
  workspace(registry) {
    const read = new Reader(Views.ofRecords(registry, { drawn: this.overlay, stored: this.overlay }), RoadmapScopes.overlay(this.id), TIMELESS);
    const byNode = {};
    const of = (step) => (byNode[step] ??= { subtasks: [], note: '', links: [] });
    for (const subtask of read.repository(Subtask).all('drawn')) of(subtask.step).subtasks.push({ id: String(subtask.id.record), label: subtask.label, done: subtask.done });
    for (const link of read.repository(StepLink).all('drawn')) {
      let domain = '';
      try { domain = new URL(link.url).hostname.replace(/^www\./, ''); } catch { domain = ''; }
      of(link.step).links.push({ id: String(link.id.record), url: link.url, title: link.title || domain, domain });
    }
    for (const note of read.repository(StepNote).all('drawn')) of(String(note.id.record)).note = note.text;
    return byNode;
  }
}

// A step's opening as the room's surfaces read it (`model/Opening.js`), from what the domain says the roadmap it opens
// comes to; `title` is that roadmap's name where it stands.
function openingOf(opening, title) {
  const counted = opening.status === 'loaded' && opening.counts !== null;
  if (opening.kind === 'subtree') {
    if (counted) return Opening.owned({ id: opening.tree, ...opening.counts, state: opening.complete ? 'complete' : 'open' });
    return opening.status === 'dangling' ? new Opening({ treeId: opening.tree, read: true, owned: true }) : Opening.owned({ id: opening.tree });
  }
  if (opening.status === 'dangling') return new Opening({ treeId: opening.tree, read: true });
  if (!counted) return Opening.unread(opening.tree);
  return new Opening({ treeId: opening.tree, read: true, valid: true, complete: opening.complete, title: title ?? '',
    done: opening.counts.done, total: opening.counts.total, loop: opening.loop });
}

// The roadmaps the replica holds, as the domain's account reads them, and the open one in the room's shapes. `held` is
// every roadmap of the account's list and every other roadmap the room reads (the open one, and the roadmaps above it);
// `listRead` says the device has read the account's list, so a roadmap missing from it is someone else's.
export class ReplicaRoadmap {
  constructor(registry, treeId, held, { listRead = true } = {}) {
    this.registry = registry;
    this.treeId = treeId;
    this.held = new Map(held.map((roadmap) => [roadmap.id, roadmap]));
    this.listRead = listRead;
    this.account = new RoadmapAccount(held.map((roadmap) => roadmap.tree(registry)));
    Object.freeze(this);
  }

  get open() { return this.held.get(this.treeId); }

  // `waiting` while the device has not read the roadmap, a roadmap above it or, for one not in it, the account's list;
  // `missing` where it holds no such roadmap, or the roadmap is hidden, so it is in no address (§5); else `open`.
  get state() {
    const open = this.open;
    if (!open?.read || (!this.mine && !this.listRead)) return 'waiting';
    if (!open.holds) return 'missing';
    const { standing } = this.account.locate(this.treeId);
    if (standing === 'hidden') return 'missing';
    return standing === 'standing' ? 'open' : 'waiting';
  }

  // The open roadmap is the person's own: it is in their account's list.
  get mine() { return this.open?.record != null; }

  // The open roadmap as the room's tree data: its present steps in authored order, each following what the domain
  // reads it follows through absent steps (D-5) and carrying the roadmap it opens; the kinds that own their hue; its
  // name, guide, place and the visibility its share reads.
  get seed() {
    const tree = this.account.trees.get(this.treeId);
    const location = this.account.locate(this.treeId);
    const graph = this.account.graph(this.treeId);
    const entry = this.account.result().trees.find((candidate) => candidate.id === this.treeId);
    const openings = new Map(entry.openings.map((opening) => {
      const shown = openingOf(opening, this.account.locate(opening.tree).title);
      return [opening.node, opening.tree === this.treeId ? shown.inItsOwnTree() : shown];
    }));
    const owners = new Set(new LegendRead(tree).result().owners.map((owner) => owner.id));
    const place = new TreePlace(location.place);
    return {
      id: this.treeId, title: location.title ?? '', guide: tree.meta.guide, author: null,
      visibility: place.subtree ? tree.meta.reach : tree.meta.visibility, mine: this.mine, place,
      kinds: tree.kinds.filter((kind) => kind.present && owners.has(kind.id))
        .map((kind) => ({ id: kind.id, hue: kind.hue, label: kind.label, description: kind.description })),
      nodes: graph.nodes.map((step) => {
        const pointer = tree.pointers.get(step.id);
        return {
          id: step.id, label: step.label, icon: step.icon, color: step.color, order: step.ord,
          createdAt: Stamp.parse(step.born), createdMs: step.rc,
          prerequisites: graph.followed(step.id).map((followed) => followed.id),
          status: step.status === 'none' ? undefined : step.status,
          description: step.description || undefined, links: step.links.length ? step.links : undefined,
          opens: pointer?.present ? pointer.opens : undefined,
          ...(openings.has(step.id) ? { opening: openings.get(step.id) } : {}),
        };
      }),
    };
  }

  // The owner's marks as the room holds them: the steps they marked complete, and the date each step that stands
  // complete reads, its mark's or the roadmap's it opens.
  get marks() {
    const tree = this.account.trees.get(this.treeId);
    const progress = this.account.progress(this.treeId);
    return {
      completed: new Set([...tree.marks.values()].filter((mark) => mark.status === 'complete' && tree.nodesById.get(mark.node)?.present)
        .map((mark) => mark.node)),
      completedAt: Object.fromEntries((progress?.dates ?? []).flatMap((date) => (date.at === null ? [] : [[date.node, date.at]]))),
      server: true,
    };
  }

  get workspace() { return this.open.workspace(this.registry); }

  // The guides above the open roadmap and its own, farthest first, in the shape the guide's read answers.
  get guides() {
    return { guides: this.account.guides(this.treeId).map((guide) => ({ treeId: guide.tree, title: guide.title, text: guide.text })) };
  }

  // The account's roadmaps as the switcher lists them: each root that stands, newest first, with how far it is. `place`
  // says where they live: `account` for a replica bound to an account, else this device.
  list(place) {
    return this.account.result().trees
      .filter((tree) => this.held.get(tree.id)?.record && tree.standing === 'standing' && tree.place.parent === null)
      .map((tree) => ({ id: tree.id, title: tree.title ?? '', done: tree.counts?.done, total: tree.counts?.total,
        updatedAt: this.held.get(tree.id).updatedAt, ...(place === 'account' ? { origin: 'server' } : { origin: 'device', claimed: false }) }))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
}
