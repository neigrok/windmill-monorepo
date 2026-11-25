// @ts-check
// Roadmap Coach D-8, §5: the context, what Coach is told at the start of every turn before it calls anything, a pure
// function of the standing roadmap (D-2), what the conversation is about (D-7) and the step it started from. It answers
// as a read does: the context, or the refusal of the roadmap the conversation is about.

import limits from '../../../../../../packages/api-contract/roadmap/limits.json' with { type: 'json' };
import { jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { compareText } from '../../../../platform/domain-kit/entities.js';
import { precondition } from '../../../../platform/domain-kit/values.js';
import { STEP_LINE, StandingRoadmaps } from './standing.js';

/** @typedef {import('./standing.js').Standing} Standing */
/** @typedef {import('./standing.js').StandingRoadmap} StandingRoadmap */
/** @typedef {import('./standing.js').DiagnosticLists} DiagnosticLists */
/** @typedef {import('./answers.js').AbilityResponse} AbilityResponse */
/** @typedef {import('./pages.js').JsonObject} JsonObject */
/** @typedef {{ about: string | null, step?: string | null }} ContextRequest what the conversation is about, a roadmap's id, or null for all of the person's, and the step the conversation started from */

// §5 The context's bounds, limits.json's `context`: `bytes`, CONTEXT_BYTES, the canonical text of the whole context;
// `steps`, of a roadmap given whole; `recent`, the newest dated completions; `frontier`, the titles of a row about all
// roadmaps; `prerequisites`, the ids of the started step's.
export const ContextBounds = Object.freeze({
  bytes: limits.context.bytes.max,
  steps: limits.context.steps.max,
  recent: limits.context.recent.max,
  frontier: limits.context.frontier.max,
  prerequisites: limits.context.prerequisites.max,
});

// §5 A step-started conversation's step in full: every field §5.1 answers, the whole description in place of its summary.
const STEP_IN_FULL = Object.freeze(['id', 'label', 'kind', 'state', 'prerequisites', 'unlockCount', 'description', 'links', 'opens']);
// §5 The kind every step of which a roadmap past the bounds is given, and how many links from its frontier it reaches.
const MILESTONE = 'milestone';
const HOPS = 2;

// The context of a conversation: about all of the person's roadmaps, the rows list_trees answers, in its order, while
// they stay within `CONTEXT_BYTES`, each with the first titles of its frontier and `frontierOmitted` counting the rest
// where there are more, so no one roadmap's frontier crowds out the rows after it; about one, what Coach is told of it.
/** @param {Standing} standing @param {ContextRequest} conversation @returns {AbilityResponse} */
export function readContext(standing, { about, step = null }) {
  const roadmaps = StandingRoadmaps.of(standing);
  if (about === null) {
    precondition(step === null, 'a conversation started from a step is about that step\'s roadmap');
    const listed = roadmaps.list();
    if (!('rows' in listed)) return listed;
    const { rows } = listed;
    return { result: within({}, 'trees', rows.length, (index) => {
      const row = roadmaps.row(/** @type {{ id: string, title: string | null }} */ (rows[index]));
      const frontier = Array.isArray(row.frontier) ? row.frontier : [];
      if (frontier.length <= ContextBounds.frontier) return row;
      return { ...row, frontier: frontier.slice(0, ContextBounds.frontier), frontierOmitted: frontier.length - ContextBounds.frontier };
    }) };
  }
  const opened = roadmaps.open(about, about);
  if (!('roadmap' in opened)) return opened;
  return { result: roadmapContext(opened.roadmap, step === null || !opened.roadmap.graph.slot.has(step) ? null : started(opened.roadmap, step)) };
}

// §5 What Coach is told of one roadmap: its id, title, kinds and guides, a summary of its diagnostics and its newest
// dated completions, and the step the conversation started from; with every step's line and every completion where the
// roadmap is within the bounds, or else its counts by kind and state and the lines of the steps around where the person
// stands, which Coach pages beyond. The started step counts toward `CONTEXT_BYTES` and stays whole. Where the context
// with no line taken would pass them, its guides give way, the farthest first and the roadmap's own last, and
// `guidesOmitted` counts them.
/** @param {StandingRoadmap} roadmap @param {JsonObject | null} step @returns {JsonObject} */
function roadmapContext(roadmap, step) {
  const { title, kinds } = roadmap.header;
  const shown = guides(roadmap);
  const tree = (/** @type {number} */ left) => ({ id: roadmap.id, title, kinds, guides: shown.slice(left), ...(left ? { guidesOmitted: left } : {}) });
  const unbounded = { diagnostics: diagnosticCounts(roadmap.diagnostics()), recent: recent(roadmap), ...(step ? { step } : {}) };
  if (roadmap.graph.ids.length <= ContextBounds.steps) {
    const whole = { tree: tree(0), ...unbounded, steps: roadmap.order().map((id) => roadmap.step(id, STEP_LINE)), completed: roadmap.completions };
    if (jcsBytes(whole).length <= ContextBounds.bytes) return whole;
  }
  const ids = around(roadmap);
  const counted = { ...unbounded, counts: counts(roadmap) };
  let left = 0;
  while (left < shown.length && jcsBytes({ tree: tree(left), ...counted, steps: [], omitted: ids.length }).length > ContextBounds.bytes) left++;
  return within({ tree: tree(left), ...counted }, 'steps', ids.length, (index) => roadmap.step(ids[index] ?? '', STEP_LINE));
}

// §5 The step a conversation started from, in full, its prerequisites cut to their first ids and `prerequisitesOmitted`
// counting the rest where there are more, which Coach reads with get_nodes.
/** @param {StandingRoadmap} roadmap @param {string} id @returns {JsonObject} */
function started(roadmap, id) {
  const step = roadmap.step(id, STEP_IN_FULL);
  const prerequisites = Array.isArray(step.prerequisites) ? step.prerequisites : [];
  if (prerequisites.length <= ContextBounds.prerequisites) return step;
  return { ...step, prerequisites: prerequisites.slice(0, ContextBounds.prerequisites), prerequisitesOmitted: prerequisites.length - ContextBounds.prerequisites };
}

// §5 The entries of a list, taken in order while the context holding them stays within `CONTEXT_BYTES`, under `list`,
// and `omitted`, how many are left off. The context starts at its bytes with none taken and `omitted: 0`; each entry
// taken adds its own bytes and a comma after the first, and `omitted` costs a byte more for each digit past its first.
/** @param {JsonObject} context @param {string} list @param {number} count @param {(index: number) => JsonObject} entry @returns {JsonObject} */
function within(context, list, count, entry) {
  let bytes = jcsBytes({ ...context, [list]: [], omitted: 0 }).length;
  /** @type {JsonObject[]} */
  const taken = [];
  for (let index = 0; index < count; index++) {
    const value = entry(index);
    const next = bytes + jcsBytes(value).length + (index ? 1 : 0);
    if (next + String(count - index - 1).length - 1 > ContextBounds.bytes) break;
    bytes = next;
    taken.push(value);
  }
  return { ...context, [list]: taken, omitted: count - taken.length };
}

// §5 The guides Coach reads before it works the roadmap, as the server's get_tree gives them to an outside assistant: on
// a roadmap of the person's own, those of their roadmaps above it and its own, farthest first, the domain's `guides`
// read; on one they only read, its own alone. `yours` says the words are the person's own: written, not inherited, on a
// roadmap that is theirs.
/** @param {StandingRoadmap} roadmap @returns {JsonObject[]} */
function guides(roadmap) {
  const { title, guide } = roadmap.header;
  const { account } = roadmap.roadmaps;
  if (!roadmap.tree.own) return guide === '' ? [] : [{ treeId: roadmap.id, title, text: guide, yours: false }];
  return account.guides(roadmap.id).map(({ tree, title: above, text, own }) => ({ treeId: tree, title: above, text,
    yours: own && account.trees.get(tree)?.own === true }));
}

// §5 The diagnostics in summary: how many entries each list of get_diagnostics' report holds, and its smells, each
// without the steps it names.
/** @param {DiagnosticLists} lists @returns {JsonObject} */
function diagnosticCounts(lists) {
  return Object.fromEntries(Object.entries(lists).map(([name, { entries, omitted }]) => [name,
    name === 'smells' ? entries.map(({ nodes, ...smell }) => smell) : entries.length + omitted]));
}

// §5 The newest completions that carry a date, each with its step's label: newest first, and at one date in id byte order.
/** @param {StandingRoadmap} roadmap @returns {JsonObject[]} */
function recent(roadmap) {
  const dated = roadmap.completions.flatMap(({ id, at }) => (at === null ? [] : [{ id, at }]));
  return dated.sort((a, b) => b.at - a.at || compareText(a.id, b.id)).slice(0, ContextBounds.recent)
    .map(({ id, at }) => ({ id, label: roadmap.label(id), at }));
}

// §5 The steps counted by state as list_trees counts them, and again for each kind in the room's order, and for the steps
// no kind owns where there are any.
/** @param {StandingRoadmap} roadmap @returns {JsonObject} */
function counts(roadmap) {
  const kinds = roadmap.stateAt.map((_, slot) => roadmap.kindAt(slot));
  const byKind = [...roadmap.kinds.map(({ id }) => id), ...(kinds.includes(null) ? [null] : [])]
    .map((kind) => ({ kind, ...roadmap.counts((slot) => kinds[slot] === kind) }));
  return { ...roadmap.counts(), byKind };
}

// §5 The steps a roadmap past the bounds is given the lines of, in the order they are taken: the frontier, so it is never
// left off while a milestone is in; then every step of the kind `milestone`; then every step within two links of the
// frontier, a link read both ways; each group in get_tree's order, and a step in the first group it falls in.
/** @param {StandingRoadmap} roadmap */
function around(roadmap) {
  const frontier = roadmap.frontier();
  const follows = roadmap.follows();
  const waiting = roadmap.waiting();
  const near = new Uint8Array(roadmap.stateAt.length);
  let ring = frontier.map((id) => /** @type {number} */ (roadmap.graph.slot.get(id)));
  for (const slot of ring) near[slot] = 1;
  for (let hop = 0; hop < HOPS; hop++) {
    /** @type {number[]} */
    const reached = [];
    for (const slot of ring) {
      for (const linked of [...(follows[slot] ?? []), ...(waiting[slot] ?? [])]) {
        if (near[linked]) continue;
        near[linked] = 1;
        reached.push(linked);
      }
    }
    ring = reached;
  }
  const order = roadmap.order();
  const slot = (/** @type {string} */ id) => /** @type {number} */ (roadmap.graph.slot.get(id));
  const milestones = order.filter((id) => roadmap.kindAt(slot(id)) === MILESTONE);
  const neighbourhood = order.filter((id) => near[slot(id)] === 1);
  return [...new Set([...frontier, ...milestones, ...neighbourhood])];
}
