// The domain's reads over the room's roadmap (roadmap-on-the-engine.md P-3). The room holds a roadmap as its tree, each
// step with the steps it follows and the roadmap it opens, and the person's marks as `progress`; here they become the
// domain's records, once for each tree and marks, and every state, need, debt, opening and effect the room shows is the
// domain's read of them. A held delete reads its steps as absent, so what follows them is read through them (D-5).
// Nothing here is a rule.

import { completedOf } from '../domain/account.js';
import { FollowGraph } from '../domain/graph.js';
import { BoardRead, EffectsRead, LegendRead } from '../domain/reads.js';
import { Kind, RoadmapTree } from '../domain/records.js';
import { DEFAULT_NODE_COLOR } from '../theme.js';
import { SkillTree } from './SkillTree.js';

// The Board column each of the domain's states stands in.
export const COLUMN_OF_STATE = { locked: 'locked', available: 'upNext', complete: 'done' };

// No step: none marked, none absent.
const NONE = new Set();

// The roadmap's records as the domain reads them: its steps in the room's order, `absent` ones deleted, each linked from
// the steps it follows, the person's complete marks, and a pointer for each step that opens a roadmap.
function recordsOf(tree, completed, absent = NONE) {
  const width = String(tree.nodes.length).length;
  return new RoadmapTree({
    id: tree.id ?? '',
    nodes: tree.nodes.map((step, place) => ({
      id: step.id, present: !absent.has(step.id), ord: String(place).padStart(width, '0'), rc: step.createdMs ?? null,
      label: step.label ?? '', color: step.color ?? DEFAULT_NODE_COLOR, description: step.description ?? '',
    })),
    edges: tree.nodes.flatMap((step) => step.prerequisites.map((from) => ({ from, to: step.id, present: true }))),
    marks: tree.nodes.filter((step) => completed.has(step.id)).map((step) => ({ node: step.id, status: 'complete' })),
    pointers: tree.nodes.filter((step) => step.opening).map((step) => ({ node: step.id, present: true, opens: step.opening.treeId })),
  });
}

// One roadmap under one set of marks, read once: its records, what stands complete as each step's opening or mark makes
// it, and the domain's graph of them for each set of dates the room gives, built when first asked.
class RoomReading {
  #graphs = new WeakMap();
  #undated = null;
  #states = null;

  constructor(tree, completed) {
    const openings = new Map(tree.nodes.flatMap((step) => (step.opening ? [[step.id, step.opening]] : [])));
    this.marks = completed;
    this.records = recordsOf(tree, completed);
    this.completed = completedOf(this.records, (id) => openings.get(id));
    Object.freeze(this);
  }

  // The graph dated as `completedAt` dates the marks; asked with no dates, the first already read, since only the dates
  // differ between them.
  graph(completedAt = null) {
    if (completedAt === null) {
      this.#undated ??= new FollowGraph(this.records, this.completed, new Map());
      return this.#undated;
    }
    if (!this.#graphs.has(completedAt)) {
      const graph = new FollowGraph(this.records, this.completed, new Map(Object.entries(completedAt)));
      this.#graphs.set(completedAt, graph);
      this.#undated ??= graph;
    }
    return this.#graphs.get(completedAt);
  }

  // Each step's state, by id, which no date changes.
  get states() {
    this.#states ??= new Map(this.graph().states);
    return this.#states;
  }
}

// tree → completed → its reading, so each change of the roadmap or the marks reads it once; and the latest reading of
// each tree, which marks the same as it hold read again, and whose structure answers what no mark changes.
const readings = new WeakMap();
const latest = new WeakMap();

/** @param {Set<string>} a @param {Set<string>} b */
function sameMarks(a, b) {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function cached(map, key, make) {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
}

function readingOf(tree, completed) {
  const last = latest.get(tree);
  const reading = last && sameMarks(last.marks, completed) ? last
    : cached(cached(readings, tree, () => new WeakMap()), completed, () => new RoomReading(tree, completed));
  latest.set(tree, reading);
  return reading;
}

// The domain's graph of what no mark changes, what each step follows and what follows it, its kind and its words: the
// room's latest reading of the roadmap, else one unmarked.
function structureOf(tree) {
  return (latest.get(tree) ?? readingOf(tree, NONE)).graph();
}

// The domain's reading of the room's roadmap under `progress` (`{completed, completedAt?}`), none marked where it is
// null: its graph dated as the progress dates it, each step's state and the steps that stand complete.
export function domainReading(tree, progress = null) {
  const reading = readingOf(tree, progress?.completed ?? NONE);
  const graph = reading.graph(progress?.completedAt ?? null);
  return { graph, get states() { return reading.states; }, completed: reading.completed };
}

// The domain's `EffectsRead` of `ids` over the room's roadmap: what a delete, a Reset, an attach or a new link would do.
// `asked` names a draft's sides (`links`) or a roadmap attached (`attach: {complete}`). With no `progress`, only what no
// mark changes is asked, read from the room's latest reading: what follows, the starting steps, the loops.
export function readEffects(tree, ids, progress = null, asked = {}) {
  if (!tree) return null;
  return new EffectsRead(progress === null ? structureOf(tree) : domainReading(tree, progress).graph, ids, asked);
}

// The domain's Board of the room's roadmap under `progress`, narrowed and ordered by `query`.
export function readBoard(tree, progress, query) {
  return new BoardRead(domainReading(tree, progress).graph, query);
}

// The parts of a Board's query that alone hide the step it reveals (`query.reveal`): what a step follows, its kind and its
// words, which no mark changes, read from the room's latest reading of the roadmap.
export function readRevealing(tree, query) {
  return BoardRead.revealing(structureOf(tree), query);
}

// What a step follows, as the domain reads it: present steps, in authored order, which no mark changes.
export function readFollowed(tree, id) {
  return structureOf(tree).followed(id).map((followed) => followed.id);
}

// The domain's legend of the room's kinds (`{id?, hue, label?, description?}`, in the room's order, each born in it, one
// with no id known by its hue) and of the steps wearing their colours: what it shows, the kinds a step may wear, the
// free hue, the Board's filter and the kinds that may be removed. One read for each legend and set of steps the room
// holds, which every surface that asks shares.
const legends = new WeakMap();
const NO_STEPS = Object.freeze([]);
// steps → the colours they wear, as the legend reads them, once for each set of steps.
const wearing = new WeakMap();

export function readLegend(legend, nodes = NO_STEPS) {
  return cached(cached(legends, legend, () => new WeakMap()), nodes, () => {
    const idOf = (kind) => kind.id ?? kind.hue;
    const kinds = legend.filter((kind, place) => legend.findIndex((other) => idOf(other) === idOf(kind)) === place);
    const ord = (place) => String(place).padStart(String(kinds.length).length, '0');
    return new LegendRead({
      kinds: kinds.map((kind, place) => new Kind({ id: idOf(kind), hue: kind.hue, label: kind.label ?? '', description: kind.description ?? '', ord: ord(place), born: `${place + 1}:0:room` })),
      nodes: cached(wearing, nodes, () => nodes.map((step) => ({ present: true, color: step.color ?? DEFAULT_NODE_COLOR }))),
    });
  });
}

// tree → the ids a hold names → the roadmap it leaves standing.
const standings = new WeakMap();

// The roadmap a held delete of `ids` leaves standing: every other step, each following what the domain reads it to
// follow with `ids` absent, so a step that followed a held one follows what that one followed (D-5).
export function standingWithout(tree, ids) {
  const absent = new Set(ids);
  const byHold = cached(standings, tree, () => new Map());
  return cached(byHold, [...absent].sort().join('\n'), () => {
    const graph = new FollowGraph(recordsOf(tree, NONE, absent));
    return new SkillTree({
      id: tree.id, title: tree.title, guide: tree.guide, author: tree.author,
      nodes: tree.nodes.filter((step) => !absent.has(step.id)).map((step) => ({ ...step, prerequisites: graph.followed(step.id).map((followed) => followed.id) })),
    });
  });
}
