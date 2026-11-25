// @ts-check
// Roadmap Coach §4, §5.1: the read abilities, each a pure function of the standing roadmap (D-2), the call's input and
// the roadmap the conversation is about (D-7, null for all of the person's), answering one page of what it read (§5.2)
// or the refusal of the call. The roadmap a call names is checked first, then the rules of its input, then its cursor.

import { compareText } from '../../../../platform/domain-kit/entities.js';
import { selectNodes } from '../reads.js';
import { AbilityCodes, refusal } from './answers.js';
import { Pages } from './pages.js';
import { STEP_LINE, StandingRoadmaps } from './standing.js';

/** @typedef {import('./standing.js').Standing} Standing */
/** @typedef {import('./answers.js').AbilityResponse} AbilityResponse */
/** @typedef {import('./standing.js').StandingRoadmap} StandingRoadmap */
/** @typedef {import('./pages.js').Entry} Entry */
/** @typedef {{ treeId: string, fields?: readonly string[], cursor?: string }} TreeRequest */
/** @typedef {{ treeId: string, nodeIds: readonly string[], fields?: readonly string[], cursor?: string }} NodesRequest */
/** @typedef {{ treeId: string, kind?: string, state?: 'locked' | 'available' | 'complete', query?: string, fields?: readonly string[], cursor?: string }} FindRequest */
/** @typedef {{ treeId: string, cursor?: string }} RoadmapRequest */
/** @typedef {{ cursor?: string }} TreesRequest */

/** @param {Pages} pages @param {string | undefined} cursor @param {string} [id] @returns {AbilityResponse} */
function paged(pages, cursor, id) {
  const page = pages.at(cursor);
  return 'page' in page ? { result: page.page } : refusal(page.refused, id);
}

/** @param {StandingRoadmap} roadmap @param {readonly string[]} ids @param {readonly string[]} fields @returns {Entry[]} */
function stepEntries(roadmap, ids, fields) {
  return ids.map((id) => ({ under: 'steps', make: () => roadmap.step(id, fields) }));
}

// `get_tree`: the roadmap's header, then its steps in get_tree's order, each with the fields asked for.
/** @param {Standing} standing @param {TreeRequest} input @param {string | null} about @returns {AbilityResponse} */
function getTree(standing, { treeId, fields = STEP_LINE, cursor }, about) {
  const opened = StandingRoadmaps.of(standing).open(treeId, about);
  if (!('roadmap' in opened)) return opened;
  const { roadmap } = opened;
  const order = roadmap.order();
  const header = { under: 'tree', make: () => roadmap.header };
  return paged(new Pages({ lists: ['steps'], entries: [header, ...stepEntries(roadmap, order, fields)], read: order }), cursor, treeId);
}

// `get_nodes`: the steps by exact id, in the order asked. An id asked twice is malformed, and one the roadmap does not
// show refuses the call, the first such in the order asked: a step under a delete the person can still undo among them.
/** @param {Standing} standing @param {NodesRequest} input @param {string | null} about @returns {AbilityResponse} */
function getNodes(standing, { treeId, nodeIds, fields = STEP_LINE, cursor }, about) {
  const opened = StandingRoadmaps.of(standing).open(treeId, about);
  if (!('roadmap' in opened)) return opened;
  const { roadmap } = opened;
  const asked = new Set();
  for (const id of nodeIds) {
    if (asked.has(id)) return refusal(AbilityCodes.invalidInput, id);
    asked.add(id);
  }
  const unknown = nodeIds.find((id) => !roadmap.graph.slot.has(id));
  if (unknown !== undefined) return refusal(AbilityCodes.unknownStep, unknown);
  const steps = nodeIds.map((id) => roadmap.step(id, fields));
  return paged(new Pages({ lists: ['steps'], entries: steps.map((step) => ({ under: 'steps', make: () => step })), read: steps }), cursor, treeId);
}

// `find_nodes`: the steps that match every filter sent, in the order of the domain's search: a kind the roadmap does not
// have matches none, and a step whose state is unknown matches no state.
/** @param {Standing} standing @param {FindRequest} input @param {string | null} about @returns {AbilityResponse} */
function findNodes(standing, { treeId, kind, state, query, fields = STEP_LINE, cursor }, about) {
  const opened = StandingRoadmaps.of(standing).open(treeId, about);
  if (!('roadmap' in opened)) return opened;
  const { roadmap } = opened;
  const found = selectNodes(roadmap.tree, { ...(query === undefined ? {} : { query }), ...(kind === undefined ? {} : { kind }) })
    .filter((id) => state === undefined || roadmap.state(id) === state);
  return paged(new Pages({ lists: ['steps'], entries: stepEntries(roadmap, found, fields), read: found }), cursor, treeId);
}

// `get_progress`: each step the person has completed as the room shows it, in id byte order, with the date the domain's
// `progress` read gives it, null where it gives none.
/** @param {Standing} standing @param {RoadmapRequest} input @param {string | null} about @returns {AbilityResponse} */
function getProgress(standing, { treeId, cursor }, about) {
  const opened = StandingRoadmaps.of(standing).open(treeId, about);
  if (!('roadmap' in opened)) return opened;
  const { completions } = opened.roadmap;
  return paged(new Pages({ lists: ['completed'], entries: completions.map((completion) => ({ under: 'completed', make: () => completion })),
    read: completions.map(({ id }) => id) }), cursor, treeId);
}

// `get_diagnostics`: the standing roadmap's report of what is wrong with its graph, each list its first 50, and the first
// page counting the rest of each.
/** @param {Standing} standing @param {RoadmapRequest} input @param {string | null} about @returns {AbilityResponse} */
function getDiagnostics(standing, { treeId, cursor }, about) {
  const opened = StandingRoadmaps.of(standing).open(treeId, about);
  if (!('roadmap' in opened)) return opened;
  const lists = opened.roadmap.diagnostics();
  const names = Object.keys(lists).sort(compareText);
  const entries = names.flatMap((name) => (lists[name]?.entries ?? []).map((entry) => ({ under: name, make: () => entry })));
  const first = Object.fromEntries(names.flatMap((name) => (lists[name]?.omitted ? [[`${name}Omitted`, lists[name]?.omitted ?? 0]] : [])));
  return paged(new Pages({ lists: names, entries, read: entries.map((entry) => entry.make()), first }), cursor, treeId);
}

// `list_trees`: one row for each roadmap the person owns that stands, in the order of the domain's `list` read, newest
// first. While the device does not hold the person's whole list the call is refused, so no roadmap of theirs goes
// unlisted.
/** @param {Standing} standing @param {TreesRequest} input @returns {AbilityResponse} */
function listTrees(standing, { cursor }) {
  const roadmaps = StandingRoadmaps.of(standing);
  const listed = roadmaps.list();
  if (!('rows' in listed)) return listed;
  const { rows } = listed;
  return paged(new Pages({ lists: ['trees'], entries: rows.map((row) => ({ under: 'trees', make: () => roadmaps.row(row) })), read: rows.map((row) => row.id) }), cursor);
}

// Every read ability of `../../../../../../packages/api-contract/roadmap/catalog.json`, by name.
export const ReadAbilities = Object.freeze({
  get_tree: getTree,
  get_nodes: getNodes,
  find_nodes: findNodes,
  get_progress: getProgress,
  get_diagnostics: getDiagnostics,
  list_trees: listTrees,
});
