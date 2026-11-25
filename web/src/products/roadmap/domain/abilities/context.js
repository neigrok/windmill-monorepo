// @ts-check
// Roadmap Coach D-8, §5: the context, what Coach is told at the start of every turn before it calls anything, a pure
// function of the standing roadmap (D-2), what the conversation is about (D-7) and the step it started from. It answers
// as a read does: the context, or the refusal of the roadmap the conversation is about.

import { jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { compareText } from '../../../../platform/domain-kit/entities.js';
import { precondition } from '../../../../platform/domain-kit/values.js';
import { AbilityCodes, refusal } from './answers.js';
import { STEP_LINE, StandingRoadmaps } from './standing.js';

/** @typedef {import('./standing.js').Standing} Standing */
/** @typedef {import('./standing.js').StandingRoadmap} StandingRoadmap */
/** @typedef {import('./standing.js').DiagnosticLists} DiagnosticLists */
/** @typedef {import('./answers.js').AbilityResponse} AbilityResponse */
/** @typedef {import('./pages.js').JsonObject} JsonObject */
/** @typedef {{ about: string | null, step?: string | null }} ContextRequest what the conversation is about, a roadmap's id, or null for all of the person's, and the step the conversation started from */

export const ContextBounds = Object.freeze({
  // §5 A roadmap of more steps is given around where the person stands.
  steps: 300,
  // §8 `CONTEXT_BYTES`: so is one whose context, given whole, would pass this many bytes of canonical text.
  bytes: 64 * 1024,
  // §5 How many of the newest completions that carry a date the context holds.
  recent: 10,
});

// §5 A step-started conversation's step in full: every field §5.1 answers, the whole description in place of its summary.
const STEP_IN_FULL = Object.freeze(['id', 'label', 'kind', 'state', 'prerequisites', 'unlockCount', 'description', 'links', 'opens']);
// §5 The kind every step of which a roadmap past the bounds is given, and how many links from its frontier it reaches.
const MILESTONE = 'milestone';
const HOPS = 2;

// The context of a conversation: about all of the person's roadmaps, what list_trees answers; about one, what Coach is
// told of it, with the step the conversation started from in full where the roadmap shows that step.
/** @param {Standing} standing @param {ContextRequest} conversation @returns {AbilityResponse} */
export function readContext(standing, { about, step = null }) {
  const roadmaps = StandingRoadmaps.of(standing);
  if (about === null) {
    precondition(step === null, 'a conversation started from a step is about that step\'s roadmap');
    if (!roadmaps.listRead) return refusal(AbilityCodes.roadmapUnavailable);
    return { result: { trees: roadmaps.account.list().map((row) => roadmaps.row(row)) } };
  }
  const opened = roadmaps.open(about, about);
  if (!('roadmap' in opened)) return opened;
  const told = roadmapContext(opened.roadmap);
  if (step === null || !opened.roadmap.graph.slot.has(step)) return { result: told };
  return { result: { ...told, step: opened.roadmap.step(step, STEP_IN_FULL) } };
}

// §5 What Coach is told of one roadmap: its id, title and kinds, a summary of its diagnostics and its newest dated
// completions; with every step's line and every completion where the roadmap is within the bounds, or else its counts by
// kind and state and the lines of the steps around where the person stands, which Coach pages beyond.
/** @param {StandingRoadmap} roadmap @returns {JsonObject} */
function roadmapContext(roadmap) {
  const { title, kinds } = roadmap.header;
  const lines = (/** @type {string[]} */ ids) => ids.map((id) => roadmap.step(id, STEP_LINE));
  const told = { tree: { id: roadmap.id, title, kinds }, diagnostics: summary(roadmap.diagnostics), recent: recent(roadmap) };
  if (roadmap.graph.ids.length <= ContextBounds.steps) {
    const whole = { ...told, steps: lines(roadmap.order()), completed: roadmap.completions };
    if (jcsBytes(whole).length <= ContextBounds.bytes) return whole;
  }
  return { ...told, counts: counts(roadmap), steps: lines(around(roadmap)) };
}

// §5 A summary of the diagnostics: how many entries each list of get_diagnostics' report holds, and its smells, each
// without the steps it names.
/** @param {DiagnosticLists} lists @returns {JsonObject} */
function summary(lists) {
  return Object.fromEntries(Object.entries(lists).map(([name, { entries, omitted }]) => [name,
    name === 'smells' ? entries.map(({ nodes, ...smell }) => smell) : entries.length + omitted]));
}

// §5 The newest completions that carry a date, each with its step's label: newest first, and at one date in id byte order.
/** @param {StandingRoadmap} roadmap @returns {JsonObject[]} */
function recent(roadmap) {
  const dated = roadmap.completions.flatMap(({ id, at }) => (at === null ? [] : [{ id, at }]));
  return dated.sort((a, b) => b.at - a.at || compareText(a.id, b.id)).slice(0, ContextBounds.recent)
    .map(({ id, at }) => ({ id, label: roadmap.tree.nodesById.get(id)?.label ?? '', at }));
}

// §5 The steps counted by state as list_trees counts them, and again for each kind in the room's order, and for the steps
// no kind owns where there are any.
/** @param {StandingRoadmap} roadmap @returns {JsonObject} */
function counts(roadmap) {
  const kinds = roadmap.stateAt.map((_, slot) => roadmap.kindAt(slot));
  const byKind = [...roadmap.kinds.map(({ id }) => id), ...(kinds.includes(null) ? [null] : [])].map((kind) => {
    const row = { kind, total: 0, done: 0, available: 0, locked: 0, unknown: 0 };
    for (const [slot, state] of roadmap.stateAt.entries()) {
      if (kinds[slot] !== kind) continue;
      row.total++;
      row[state === 'complete' ? 'done' : state]++;
    }
    return row;
  });
  return { ...roadmap.counts, byKind };
}

// §5 The steps a roadmap past the bounds is given the lines of, in get_tree's order: every step of the kind `milestone`,
// the frontier, which is the available steps, and every step within two links of the frontier, a link read either way.
/** @param {StandingRoadmap} roadmap */
function around(roadmap) {
  const follows = roadmap.follows();
  const waiting = roadmap.waiting();
  const near = new Uint8Array(roadmap.stateAt.length);
  let ring = roadmap.stateAt.flatMap((state, slot) => (state === 'available' ? [slot] : []));
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
  for (const slot of near.keys()) if (roadmap.kindAt(slot) === MILESTONE) near[slot] = 1;
  return roadmap.order().filter((id) => near[roadmap.graph.slot.get(id) ?? -1] === 1);
}
