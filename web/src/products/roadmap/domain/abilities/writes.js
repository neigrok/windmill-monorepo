// @ts-check
// Roadmap Coach §6: the direct writes, each a pure function of the standing roadmap (D-2), the call's input, the roadmap
// the conversation is about (D-7, null for all of the person's) and the tool host's random source of a new step's id. Each
// answers the room's acts it is carried out as, the parts of one act, and what the call answers, by §6's table, or the
// refusal of the call (§6.1). A write changes one step and removes nothing. A call is checked in §6's order: the roadmap it names and whether this
// write may reach it (rules 1 to 3), the rules of its input, a text the domain cannot store among them, the caps the
// server keeps (4), the graph (5), the marks (7) and that it changes something (8); but `connect` asks whether the step
// already follows the step it names before it asks whether the link closes a loop, since a link that stands closes none.
// A new step's id is drawn last, once the call is taken (6).

import { JcsError, jcs } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { sameJson } from '../../../../platform/domain-kit/entities.js';
import { Path, Violation, precondition } from '../../../../platform/domain-kit/values.js';
import { registry } from '../../../../platform/sync/schema.js';
import { RoadmapSpecs, SAFE_URL } from '../roadmapRules.js';
import { RoadmapLink, RoadmapStep, firstLoop } from '../steps.js';
import { Subtask } from '../workspace.js';
import { AbilityCodes, refusal } from './answers.js';
import { StandingRoadmaps } from './standing.js';

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../platform/domain-kit/values.js').TextSpec} TextSpec */
/** @typedef {import('./standing.js').Standing} Standing */
/** @typedef {import('./standing.js').StandingRoadmap} StandingRoadmap */
/** @typedef {import('./answers.js').AbilityResponse} AbilityResponse */
/** @typedef {import('./answers.js').RoomAct} RoomAct */
/** @typedef {() => string} IdSource the tool host's random source, drawn once for each new step */
/** @typedef {{ treeId: string, nodeId: string, status: 'complete' | 'none' }} ProgressRequest */
/**
 * @typedef {{ treeId: string, nodeId: string, label?: string, description?: string, links?: { url: string, label?: string }[],
 *   subtasks?: string[] }} UpdateRequest
 */
/** @typedef {{ treeId: string, label: string, kind?: string, description?: string, prerequisites: string[] }} CreateRequest */
/** @typedef {{ treeId: string, nodeId: string, prerequisiteId: string }} ConnectRequest */

// §6.1, §6 rule 4: what the door would refuse of the texts a write sends, by the spec it applies to each, null where it
// takes every one. A text the domain cannot store at all, one that holds U+0000 or a lone surrogate, or one it takes no
// blank of, a subtask's, is `invalid-input`, before any cap; one past its cap, measured as its spec measures it, after the
// trim it applies, is `over-limit`. A blank address is the address rule's (rule 5).
/** @param {[string | undefined, TextSpec][]} texts @returns {string | null} */
function refusedText(texts) {
  const codes = texts.flatMap(([text, spec]) => {
    if (text === undefined) return [];
    try {
      jcs(text);
      spec.apply(text, new Path(spec.path));
      return [];
    } catch (error) {
      if (error instanceof JcsError) return [AbilityCodes.invalidInput];
      if (!(error instanceof Violation)) throw error;
      if (error.reason.kind === 'tooLong') return [AbilityCodes.overLimit];
      return error.reason.kind === 'nul' || spec !== RoadmapSpecs.linkUrl ? [AbilityCodes.invalidInput] : [];
    }
  });
  return codes.includes(AbilityCodes.invalidInput) ? AbilityCodes.invalidInput : codes[0] ?? null;
}

// §6 rule 4: the sync registry's caps of a roadmap's steps and links, and of the subtasks of its owner's checklists.
/** @param {string} type */
function capOf(type) {
  const cap = registry.type(type)?.cap;
  precondition(cap !== undefined, `the sync registry caps ${type}`);
  return cap;
}
const STEPS_CAP = capOf(RoadmapStep.type);
const LINKS_CAP = capOf(RoadmapLink.type);
const SUBTASKS_CAP = capOf(Subtask.type);

// §6 rule 4: whether more steps, links or subtasks would pass the caps of a roadmap, which counts what it holds alive as
// the engine does: each step the room shows and each under a delete the person can still undo, until its hold ends, each
// link, and each subtask of its checklists, a removed step's included.
/** @param {StandingRoadmap} roadmap @param {{ steps?: number, links?: number, subtasks?: number }} adding */
function pastCaps(roadmap, { steps = 0, links = 0, subtasks = 0 }) {
  return roadmap.graph.ids.length + roadmap.held.size + steps > STEPS_CAP || roadmap.graph.edges.length + links > LINKS_CAP
    || roadmap.subtaskCount + subtasks > SUBTASKS_CAP;
}

/** @param {RoomAct[]} acts @param {{ [key: string]: Json }} [result] @returns {AbilityResponse} */
function written(acts, result = {}) {
  return { writes: acts, result };
}

// §6 rules 1 to 3: the roadmap a call names, where the device holds it whole and the person may write it in this
// conversation; else the refusal of the call. A step the call names under a delete the person can still undo is not
// ready, the first in the order named; a roadmap the person only reads takes no write; and a direct write names the
// roadmap the conversation is about.
/** @param {Standing} standing @param {string} treeId @param {string | null} about @param {readonly string[]} named @returns {{ roadmap: StandingRoadmap } | AbilityResponse} */
function writable(standing, treeId, about, named) {
  const opened = StandingRoadmaps.of(standing).open(treeId, about);
  if (!('roadmap' in opened)) return opened;
  const { roadmap } = opened;
  const held = named.find((id) => roadmap.held.has(id));
  if (held !== undefined) return refusal(AbilityCodes.roadmapNotReady, held);
  if (!roadmap.tree.own) return refusal(AbilityCodes.notOwner, treeId);
  if (treeId !== about) return refusal(AbilityCodes.outOfScope, treeId);
  return opened;
}

// `set_progress`: the room's Complete or Reset. A step that opens a roadmap is complete when that roadmap is, and takes no
// mark either way; a locked step is not marked complete, as the room offers no Complete on it.
/** @param {Standing} standing @param {ProgressRequest} input @param {string | null} about @returns {AbilityResponse} */
function setProgress(standing, { treeId, nodeId, status }, about) {
  const opened = writable(standing, treeId, about, [nodeId]);
  if (!('roadmap' in opened)) return opened;
  const { roadmap } = opened;
  if (roadmap.shown(nodeId) === undefined) return refusal(AbilityCodes.unknownStep, nodeId);
  if (roadmap.openings.has(nodeId)) return refusal(AbilityCodes.opensRoadmap, nodeId);
  const state = roadmap.graph.states.get(nodeId);
  if (status === 'complete' && state === 'locked') return refusal(AbilityCodes.stepLocked, nodeId);
  if ((state === 'complete') === (status === 'complete')) return refusal(AbilityCodes.noChange, nodeId);
  return written([{ action: status === 'complete' ? 'Complete' : 'Reset', input: { tree: treeId, step: nodeId } }]);
}

// `update_node`: the room's change of the step's label, description and web links, each sent replaced whole and written as
// the domain stores it (an address trimmed, a label left out empty), and the room's new subtask for each item it adds to
// the end of the step's checklist, the person's own: one act. It never edits, checks or removes an item. A call that
// names no field is malformed, every address must be one the room shows, and a call whose every field the step already
// holds, adding no subtask, changes nothing.
/** @param {Standing} standing @param {UpdateRequest} input @param {string | null} about @returns {AbilityResponse} */
function updateNode(standing, { treeId, nodeId, label, description, links, subtasks }, about) {
  const opened = writable(standing, treeId, about, [nodeId]);
  if (!('roadmap' in opened)) return opened;
  const { roadmap } = opened;
  if ([label, description, links, subtasks].every((field) => field === undefined)) return refusal(AbilityCodes.invalidInput, nodeId);
  const adding = subtasks ?? [];
  const text = refusedText([[label, RoadmapSpecs.label], [description, RoadmapSpecs.description],
    ...(links ?? []).flatMap(({ url, label: title }) => /** @type {[string | undefined, TextSpec][]} */ ([[url, RoadmapSpecs.linkUrl], [title, RoadmapSpecs.linkLabel]])),
    ...adding.map((item) => /** @type {[string, TextSpec]} */ ([item, RoadmapSpecs.subtask]))])
    ?? ((links ?? []).length > RoadmapSpecs.links.max ? AbilityCodes.overLimit : null);
  if (text !== null) return refusal(text, nodeId);
  if (pastCaps(roadmap, { subtasks: adding.length })) return refusal(AbilityCodes.overLimit, treeId);
  const step = roadmap.shown(nodeId);
  if (step === undefined) return refusal(AbilityCodes.unknownStep, nodeId);
  const carried = links?.map(({ url, label: title = '' }) => ({ url: RoadmapSpecs.linkUrl.normalised(url), label: title }));
  if (carried?.some(({ url }) => !SAFE_URL.test(url))) return refusal(AbilityCodes.addressNotAllowed, nodeId);
  const changes = { ...(label === undefined ? {} : { label }), ...(description === undefined ? {} : { description }),
    ...(carried === undefined ? {} : { links: carried }) };
  const holds = { label: step.label, description: step.description, links: step.links.map(({ url, label: title }) => ({ url, label: title })) };
  const changed = !sameJson({ ...holds, ...changes }, holds);
  if (!changed && adding.length === 0) return refusal(AbilityCodes.noChange, nodeId);
  return written([...(changed ? [{ action: 'ChangeStep', input: { tree: treeId, step: nodeId, changes } }] : []),
    ...adding.map((item) => ({ action: 'AddSubtask', input: { tree: treeId, step: nodeId, label: item } }))]);
}

// `create_node`: the room's new step after the prerequisites named, wearing the hue of a kind its legend shows, as the
// room's New step offers them, terracotta where it names none, under the id the tool host draws; it answers that id. A
// new step's links close no loop: nothing follows it yet.
/** @param {Standing} standing @param {CreateRequest} input @param {string | null} about @param {IdSource} ids @returns {AbilityResponse} */
function createNode(standing, { treeId, label, kind, description, prerequisites }, about, ids) {
  const after = [...new Set(prerequisites)];
  const opened = writable(standing, treeId, about, after);
  if (!('roadmap' in opened)) return opened;
  const { roadmap } = opened;
  const text = refusedText([[label, RoadmapSpecs.label], [description, RoadmapSpecs.description]]);
  if (text !== null) return refusal(text);
  if (pastCaps(roadmap, { steps: 1, links: after.length })) return refusal(AbilityCodes.overLimit, treeId);
  const unknown = after.find((id) => roadmap.shown(id) === undefined);
  if (unknown !== undefined) return refusal(AbilityCodes.unknownStep, unknown);
  const hue = kind === undefined ? 'terracotta' : roadmap.kinds.find((each) => each.id === kind)?.hue;
  if (hue === undefined) return refusal(AbilityCodes.unknownKind, kind);
  const nodeId = ids();
  return written([{ action: 'CreateStep', input: { tree: treeId, step: { label, color: hue, ...(description ? { description } : {}) },
    prerequisites: after, id: nodeId } }], { nodeId });
}

// `connect`: the room's one link added, the step `nodeId` coming to wait on `prerequisiteId`. A link the step already
// follows, through removed steps too, changes nothing and so closes nothing; a new one that would close a loop among what
// steps follow is refused as the room's own link is.
/** @param {Standing} standing @param {ConnectRequest} input @param {string | null} about @returns {AbilityResponse} */
function connect(standing, { treeId, nodeId, prerequisiteId }, about) {
  const opened = writable(standing, treeId, about, [nodeId, prerequisiteId]);
  if (!('roadmap' in opened)) return opened;
  const { roadmap } = opened;
  if (pastCaps(roadmap, { links: 1 })) return refusal(AbilityCodes.overLimit, treeId);
  const unknown = [nodeId, prerequisiteId].find((id) => roadmap.shown(id) === undefined);
  if (unknown !== undefined) return refusal(AbilityCodes.unknownStep, unknown);
  if (roadmap.graph.followed(nodeId).some((entry) => entry.id === prerequisiteId)) return refusal(AbilityCodes.noChange, nodeId);
  if (firstLoop(roadmap.tree, [[prerequisiteId, nodeId]], new Set()) === 0) return refusal(AbilityCodes.closesCycle, nodeId);
  return written([{ action: 'ChangePrerequisites', input: { tree: treeId, step: nodeId, add: [prerequisiteId], remove: [] } }]);
}

// Every direct write of `../../../../../../packages/api-contract/roadmap/catalog.json`, by name.
export const WriteAbilities = Object.freeze({
  set_progress: setProgress,
  update_node: updateNode,
  create_node: createNode,
  connect,
});
