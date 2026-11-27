// The domain's reads over the room's roadmap (roadmap-on-the-engine.md P-3). The room holds a roadmap as its tree, each
// step with the steps it follows and the roadmap it opens, and the person's marks as `progress`; here they become the
// domain's records, once for each tree and marks, and every state, need, debt, opening and effect the room shows is the
// domain's read of them. A held delete reads its steps as absent, so what follows them is read through them (D-5).
// Nothing here is a rule.

import { completedOf } from '../domain/account.js';
import { FollowGraph } from '../domain/graph.js';
import { BoardRead, EffectsRead } from '../domain/reads.js';
import { RoadmapTree } from '../domain/records.js';
import { DEFAULT_NODE_COLOR } from '../theme.js';
import { SkillTree } from './SkillTree.js';

// The Board column each of the domain's states stands in.
export const COLUMN_OF_STATE = { locked: 'locked', available: 'upNext', complete: 'done' };

// No step: none marked, none absent.
const NONE = new Set();
const UNDATED = {};

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

// One roadmap under one set of marks: the domain's graph, complete as each step's opening or mark makes it, and dated
// as `progress.completedAt` dates it.
class RoomReading {
  #states = null;
  #completed = null;

  constructor(tree, completed, completedAt) {
    const openings = new Map(tree.nodes.flatMap((step) => (step.opening ? [[step.id, step.opening]] : [])));
    const records = recordsOf(tree, completed);
    this.graph = new FollowGraph(records, completedOf(records, (id) => openings.get(id)), new Map(Object.entries(completedAt)));
    Object.freeze(this);
  }

  // Each step's state, by id.
  get states() {
    this.#states ??= new Map(this.graph.states);
    return this.#states;
  }

  // The steps that stand complete.
  get completed() {
    this.#completed ??= new Set(this.graph.ids.filter((_, slot) => this.graph.done[slot] === 1));
    return this.#completed;
  }
}

// tree → completed → completedAt → its reading, so each change of the roadmap or the marks reads it once.
const readings = new WeakMap();

function cached(map, key, make) {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
}

// The domain's reading of the room's roadmap under `progress` (`{completed, completedAt?}`), none marked where it is null.
export function domainReading(tree, progress = null) {
  const completed = progress?.completed ?? NONE;
  const completedAt = progress?.completedAt ?? UNDATED;
  const byMarks = cached(readings, tree, () => new WeakMap());
  const byDates = cached(byMarks, completed, () => new WeakMap());
  return cached(byDates, completedAt, () => new RoomReading(tree, completed, completedAt));
}

// The domain's `EffectsRead` of `ids` over the room's roadmap: what a delete, a Reset, an attach or a new link would do.
// `asked` names a draft's sides (`links`) or a roadmap attached (`attach: {complete}`).
export function readEffects(tree, ids, progress = null, asked = {}) {
  if (!tree) return null;
  return new EffectsRead(domainReading(tree, progress).graph, ids, asked);
}

// The domain's Board of the room's roadmap under `progress`, narrowed and ordered by `query`.
export function readBoard(tree, progress, query) {
  return new BoardRead(domainReading(tree, progress).graph, query);
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
