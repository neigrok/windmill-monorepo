// @ts-check
// Roadmap Coach §7: a proposal's changes (D-6), their fold over a scratch copy of the standing roadmap (D-2), and the
// ability that mints a proposal of them, `propose_roadmap_change`. A change is one flat object, its `op` and the fields
// its row names. The fold reads a change in a record's form, each new step or kind under the id it is to have, so it
// folds a set as the call sends it, each `ref` standing for its id, and as a record holds it, each ref under its minted
// id, alike: the review and Apply fold a record again. It validates each change over the copy as the changes before it
// left it and names every register each writes, the proposal's base. Nothing here is written: a proposal is written by
// nobody until the person applies it.

import limits from '../../../../../../packages/api-contract/roadmap/limits.json' with { type: 'json' };
import { between, isOrderKey } from '../../../../../../packages/api-contract/sync/reference/core/fracindex.js';
import { jcs, jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { compareText, sameJson } from '../../../../platform/domain-kit/entities.js';
import { precondition } from '../../../../platform/domain-kit/values.js';
import { RoadmapTree } from '../records.js';
import { EffectsRead, LegendRead } from '../reads.js';
import { HUES, RoadmapScopes, RoadmapSpecs, SAFE_URL, UNSET } from '../roadmapRules.js';
import { firstLoop, newStepOrd } from '../steps.js';
import { AbilityCodes, refusal, textRefusal } from './answers.js';
import { RoadmapCaps, StandingRoadmaps } from './standing.js';

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../platform/domain-kit/values.js').TextSpec} TextSpec */
/** @typedef {import('../records.js').StepInput} StepInput */
/** @typedef {import('../records.js').KindInput} KindInput */
/** @typedef {import('../records.js').MarkInput} MarkInput */
/** @typedef {import('../records.js').Edge} Edge */
/** @typedef {import('./standing.js').Standing} Standing */
/** @typedef {import('./standing.js').StandingRoadmap} StandingRoadmap */
/** @typedef {import('./standing.js').RecordStamps} RecordStamps */
/** @typedef {import('./answers.js').AbilityResponse} AbilityResponse */
/** @typedef {{ refused: import('./answers.js').AbilityRefusal }} Refused */
/** @typedef {Record<string, any>} Change a change as the call sends it or a record holds it: its `op` and the fields its row names */
/** @typedef {'coachProposal' | 'node' | 'kind'} Minted the types of record a proposal mints an id for */
/** @typedef {(type: Minted) => string} IdSource the tool host's random source, drawn once for the proposal and once for each ref */
/** @typedef {{ t: string, id: string | string[], register: string, stamp: string | null }} BaseRegister */
/** @typedef {{ t: string, id: string | string[], register: string, value: Json, base?: false }} Write one register a change writes; a write the room's own command makes is no part of the base */
/** @typedef {{ nodeId: string, label: string, descriptionChars: number, links: number, done: boolean }} Removal */
/**
 * What folding one change writes, and what it asks of the copy before it writes: the registers it names without writing
 * them, which the turn may have read; the check that is the op's own, of its links or hues; the marks it keeps; whether it
 * changes nothing; and the step it removes.
 * @typedef {{ writes: Write[], names?: Write[], check?: () => Refused | null, marks?: () => Refused | null, unchanged?: boolean, removes?: string }} Folding
 */

// §7 Each op of a change, by the fields its row names, required and then optional.
/** @type {Readonly<Record<string, { required: readonly string[], optional: readonly string[] }>>} */
export const ProposalOps = Object.freeze({
  add_step: { required: ['ref', 'label'], optional: ['description', 'kind', 'prerequisites', 'links'] },
  remove_step: { required: ['nodeId'], optional: [] },
  rename: { required: ['nodeId', 'label'], optional: [] },
  describe: { required: ['nodeId'], optional: ['description', 'links'] },
  set_kind: { required: ['nodeId', 'kind'], optional: [] },
  connect: { required: ['nodeId', 'prerequisiteId'], optional: [] },
  disconnect: { required: ['nodeId', 'prerequisiteId'], optional: [] },
  merge: { required: ['nodeId', 'removeId'], optional: ['label', 'description'] },
  split: { required: ['nodeId', 'parts'], optional: [] },
  set_progress: { required: ['nodeId', 'status'], optional: [] },
  add_kind: { required: ['ref', 'label', 'hue'], optional: ['description'] },
  rename_kind: { required: ['kind', 'label'], optional: [] },
  recolor_kind: { required: ['kind', 'hue'], optional: [] },
});

// §7 A ref, which names a new step or kind within a proposal; a name of its form is a ref, never a step's or a kind's id.
const REF = /^new:[a-z0-9][a-z0-9-]{0,31}$/u;
const TREE_ID = /^t_[0-9a-f]{16}$/u;

/** @param {unknown} value @returns {value is string} */
const isText = (value) => typeof value === 'string';

// An object holding the members `required` names and no member `members` does not take, each of the shape it takes.
/** @param {unknown} value @param {Record<string, (member: unknown) => boolean>} members @param {string[]} required @returns {value is Record<string, unknown>} */
function isObjectOf(value, members, required) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return required.every((name) => Object.hasOwn(value, name)) && Object.entries(value).every(([name, member]) => members[name]?.(member) === true);
}

const WEB_LINK = Object.freeze({ url: isText, label: isText });
/** @param {unknown} value */
const isWebLinks = (value) => Array.isArray(value) && value.every((link) => isObjectOf(link, WEB_LINK, ['url']));
/** @param {unknown} value */
const isRef = (value) => isText(value) && REF.test(value);
const PART = Object.freeze({ ref: isRef, label: isText, description: isText, kind: isText, links: isWebLinks });

// The catalog's schema of a change (`propose_roadmap_change`'s `changes.items`), member by member, which the Shape rule
// holds every change to.
const SHAPES = Object.freeze({
  op: (/** @type {unknown} */ value) => isText(value) && Object.hasOwn(ProposalOps, value),
  nodeId: isText,
  ref: isRef,
  label: isText,
  description: isText,
  links: isWebLinks,
  kind: isText,
  hue: (/** @type {unknown} */ value) => HUES.some((hue) => hue === value),
  prerequisites: (/** @type {unknown} */ value) => Array.isArray(value) && value.every(isText),
  prerequisiteId: isText,
  removeId: isText,
  status: (/** @type {unknown} */ value) => value === 'complete' || value === 'none',
  parts: (/** @type {unknown} */ value) => Array.isArray(value) && value.every((part) => isObjectOf(part, PART, ['ref', 'label'])),
});

// §6.1 What a refusal of a change names: its step, else the ref it gives, else its kind.
/** @param {unknown} change @returns {string | undefined} */
function subjectOf(change) {
  if (change === null || typeof change !== 'object') return undefined;
  const { nodeId, ref, kind } = /** @type {Change} */ (change);
  return [nodeId, ref, kind].find(isText);
}

// The steps of the roadmap a change names, in its fields' order: a new step's own id is what it gives, not a name.
/** @param {Change} change @returns {string[]} */
function stepsNamed(change) {
  return [change.op === 'add_step' ? undefined : change.nodeId, change.removeId, change.prerequisiteId, ...(change.prerequisites ?? [])].filter(isText);
}

// The kinds a change names: a new step's, a part's, or the kind it changes; a new kind's own id is what it gives.
/** @param {Change} change @returns {string[]} */
function kindsNamed(change) {
  return [change.op === 'add_kind' ? undefined : change.kind, ...(change.parts ?? []).map((/** @type {Change} */ part) => part.kind)].filter(isText);
}

// The new steps and kinds a change gives, in order, by the id the form it is in gives each.
/** @param {Change} change @returns {{ type: 'node' | 'kind', id: string }[]} */
function givenBy(change) {
  if (change.op === 'add_step') return [{ type: 'node', id: change.nodeId ?? change.ref }];
  if (change.op === 'add_kind') return [{ type: 'kind', id: change.kind ?? change.ref }];
  if (change.op === 'split') return change.parts.map((/** @type {Change} */ part) => ({ type: 'node', id: part.nodeId ?? part.ref }));
  return [];
}

// A change in the record's form, each new step or kind under the id `idOf` gives its ref, and every field that names a
// ref naming that id. Every other value stays as the call sent it.
/** @param {Change} change @param {(ref: string) => string} idOf @returns {Change} */
function recorded(change, idOf) {
  /** @param {unknown} value */
  const name = (value) => (isText(value) ? idOf(value) : value);
  return Object.fromEntries(Object.entries(change).map(([key, value]) => {
    if (key === 'ref') return [change.op === 'add_kind' ? 'kind' : 'nodeId', name(value)];
    if (['nodeId', 'prerequisiteId', 'removeId', 'kind'].includes(key)) return [key, name(value)];
    if (key === 'prerequisites') return [key, value.map(name)];
    if (key === 'parts') return [key, value.map((/** @type {Change} */ part) => recorded(part, idOf))];
    return [key, value];
  }));
}

// The web links a change carries, as the domain stores them: each address trimmed, a label left out empty.
/** @param {{ url: string, label?: string }[] | undefined} links */
function webLinks(links) {
  return (links ?? []).map(({ url, label = '' }) => ({ url: RoadmapSpecs.linkUrl.normalised(url), label }));
}

// The texts and web links of a change and of each of its parts, each with what a refusal of them names: the change's
// subject, or the part's ref. A kind's words are measured as a kind's.
/** @param {Change} change @returns {{ about: string | undefined, texts: [string | undefined, TextSpec][], links: { url: string, label?: string }[] }[]} */
function wordsOf(change) {
  const kind = change.op === 'add_kind' || change.op === 'rename_kind';
  /** @param {Change} words @param {string | undefined} about */
  const of = (words, about) => ({
    about,
    texts: /** @type {[string | undefined, TextSpec][]} */ ([[words.label, kind ? RoadmapSpecs.kindLabel : RoadmapSpecs.label],
      [words.description, kind ? RoadmapSpecs.kindDescription : RoadmapSpecs.description],
      ...(words.links ?? []).flatMap((/** @type {{ url: string, label?: string }} */ link) => [[link.url, RoadmapSpecs.linkUrl], [link.label, RoadmapSpecs.linkLabel]])]),
    links: words.links ?? [],
  });
  return [of(change, subjectOf(change)), ...(change.parts ?? []).map((/** @type {Change} */ part) => of(part, part.ref))];
}

// §7 The Shape rule (Coach engine §6) over the call, the gate's first rule and so the first check: a change outside the
// catalog's schema refuses the call at its index, naming its subject; a fault outside the changes names nothing.
/** @param {unknown} input @returns {Refused | null} */
function shapeRefusal(input) {
  if (!isObjectOf(input, { treeId: (value) => isText(value) && TREE_ID.test(value), changes: Array.isArray }, ['treeId', 'changes'])) {
    return refusal(AbilityCodes.invalidInput);
  }
  const changes = /** @type {unknown[]} */ (input.changes);
  if (changes.length === 0) return refusal(AbilityCodes.invalidInput);
  const at = changes.findIndex((change) => !isObjectOf(change, SHAPES, ['op']));
  return at < 0 ? null : refusal(AbilityCodes.invalidInput, subjectOf(changes[at]), at);
}

// §7, §6.1 The rules of a change's input, in order: its op's row; a merge of a step into itself, a describe of neither
// field and a split of fewer than two parts; a ref given twice, at its second giving; a text the domain cannot store; a
// value past its cap; and an address the contract does not show. `refs` are the refs the changes before it gave.
/** @param {Change} change @param {Set<string>} refs @param {number} at @returns {Refused | null} */
function formRefusal(change, refs, at) {
  const { required, optional } = /** @type {{ required: readonly string[], optional: readonly string[] }} */ (ProposalOps[change.op]);
  const subject = subjectOf(change);
  const fields = Object.keys(change).filter((name) => name !== 'op');
  if (!required.every((name) => fields.includes(name)) || !fields.every((name) => required.includes(name) || optional.includes(name))) {
    return refusal(AbilityCodes.invalidInput, subject, at);
  }
  if ((change.op === 'merge' && change.nodeId === change.removeId) || (change.op === 'describe' && change.description === undefined && change.links === undefined)
    || (change.op === 'split' && change.parts.length < 2)) return refusal(AbilityCodes.invalidInput, subject, at);
  const given = [change.ref, ...(change.parts ?? []).map((/** @type {Change} */ part) => part.ref)].filter(isText);
  const twice = given.find((ref, index) => refs.has(ref) || given.indexOf(ref) !== index);
  if (twice !== undefined) return refusal(AbilityCodes.invalidInput, twice, at);
  for (const ref of given) refs.add(ref);
  const words = wordsOf(change).map((each) => ({ ...each,
    code: textRefusal(each.texts) ?? (each.links.length > RoadmapSpecs.links.max ? AbilityCodes.overLimit : null) }));
  const unstorable = words.find(({ code }) => code === AbilityCodes.invalidInput) ?? words.find(({ code }) => code !== null);
  if (unstorable?.code) return refusal(unstorable.code, unstorable.about, at);
  const unshown = words.find(({ links }) => webLinks(links).some(({ url }) => !SAFE_URL.test(url)));
  return unshown ? refusal(AbilityCodes.addressNotAllowed, unshown.about, at) : null;
}

/** @param {string} scope @param {string} t @param {Json} id */
const recordKey = (scope, t, id) => `${scope} ${t} ${jcs(id)}`;

// The stamp of one register in stamps read of the copy, null where they hold none of it, and whether they hold it.
/** @param {Map<string, RecordStamps>} stamps @param {string} key @param {string} register @returns {{ held: boolean, stamp: string | null }} */
function stampIn(stamps, key, register) {
  const record = stamps.get(key);
  if (record === undefined) return { held: false, stamp: null };
  if (register === 'life') return { held: record.life !== null, stamp: record.life };
  return { held: Object.hasOwn(record.f, register), stamp: record.f[register] ?? null };
}

// A link's key among the scratch's links.
/** @param {string} from @param {string} to */
const linkKey = (from, to) => jcs([from, to]);

// The records of a scratch copy, by id: its steps, its links by `[from, to]`, its kinds and its marks.
/** @typedef {{ nodes: Map<string, StepInput>, edges: Map<string, Edge>, kinds: Map<string, KindInput>, marks: Map<string, MarkInput> }} ScratchRecords */

// The value a register holds among scratch records, one they hold no record of reading as unset.
/** @param {ScratchRecords} records @param {Write} write @returns {Json} */
function valueIn(records, { t, id, register }) {
  if (t === 'edge') return records.edges.get(jcs(id))?.present === true;
  if (t === 'progress') {
    const mark = records.marks.get(String(id));
    return mark ? { status: mark.status, outOfOrder: mark.outOfOrder ?? false } : UNSET.progress.mark;
  }
  const record = /** @type {Record<string, Json> | undefined} */ ((t === 'node' ? records.nodes : records.kinds).get(String(id)));
  if (register === 'life') return record?.present === true;
  return record?.[register] ?? /** @type {Record<string, Record<string, Json>>} */ (/** @type {unknown} */ (UNSET))[t]?.[register] ?? null;
}

// One register written into scratch records; a record they held none of is made with every other field unset.
/** @param {ScratchRecords} records @param {Write} write */
function writeInto(records, { t, id, register, value }) {
  if (t === 'edge') {
    const [from = '', to = ''] = /** @type {string[]} */ (id);
    records.edges.set(linkKey(from, to), { from, to, present: value === true });
    return;
  }
  const key = String(id);
  if (t === 'progress') {
    const mark = /** @type {{ status: string, outOfOrder: boolean }} */ (value);
    records.marks.set(key, { node: key, status: mark.status, outOfOrder: mark.outOfOrder, recordedAt: null, deviceAt: null, stamp: null });
    return;
  }
  const kept = /** @type {Map<string, Record<string, any>>} */ (t === 'node' ? records.nodes : records.kinds);
  const record = kept.get(key) ?? (t === 'node'
    ? { id: key, present: false, born: null, rc: null, ru: null, ...UNSET.node, links: [], ord: '', status: 'none', branch: null }
    : { id: key, present: false, born: null, ...UNSET.kind, ord: '' });
  kept.set(key, register === 'life' ? { ...record, present: value === true } : { ...record, [register]: value });
}

// §7 A set of changes folded in order over a scratch copy of one standing roadmap. Each change is validated over the
// copy as the changes before it left it; what it writes is then folded in, and each register it is the first to touch
// joins the base, with the stamp the copy holds of it.
export class ProposalFold {
  /** @type {ScratchRecords} */
  #records;
  /** @type {Set<string>} */
  #given = new Set();
  /** @type {Map<string, BaseRegister>} */
  #base = new Map();
  /** @type {Removal[]} */
  #removes = [];
  /** @type {RoadmapTree | null} */
  #tree = null;
  /** @type {StandingRoadmap | null} */
  #roadmap = null;

  // `roadmap` is the standing roadmap the set changes, of the standing roadmaps `standing`; `seen` the stamps of the
  // registers the turn's context and reads returned, as the tool host noted them (§5).
  /** @param {Standing} standing @param {StandingRoadmap} roadmap @param {RecordStamps[]} [seen] */
  constructor(standing, roadmap, seen = []) {
    this.standing = standing;
    this.id = roadmap.id;
    this.held = roadmap.held;
    this.input = roadmap.tree.json;
    this.#records = {
      nodes: new Map((this.input.nodes ?? []).map((node) => [node.id, node])),
      edges: new Map((this.input.edges ?? []).map((edge) => [linkKey(edge.from, edge.to), edge])),
      kinds: new Map((this.input.kinds ?? []).map((kind) => [kind.id, kind])),
      marks: new Map((this.input.marks ?? []).map((mark) => [mark.node, mark])),
    };
    this.stamps = new Map((standing.stamps ?? []).map((record) => [recordKey(record.scope, record.t, record.id), record]));
    this.seen = new Map(seen.map((record) => [recordKey(record.scope, record.t, record.id), record]));
  }

  // A record's changes folded over the standing roadmap as it is now: the fold, or the refusal of the first change that
  // no longer folds, or of the roadmap.
  /** @param {Standing} standing @param {string} treeId @param {Change[]} changes @returns {{ fold: ProposalFold } | AbilityResponse} */
  static over(standing, treeId, changes) {
    const opened = StandingRoadmaps.of(standing).open(treeId, treeId);
    if (!('roadmap' in opened)) return opened;
    const fold = new ProposalFold(standing, opened.roadmap);
    for (const [at, change] of changes.entries()) {
      const refused = fold.apply(change, at);
      if (refused) return refused;
    }
    return { fold };
  }

  // The scratch copy as a tree, rebuilt once a change has written it.
  get tree() {
    this.#tree ??= this.treeOf(this.#records);
    return this.#tree;
  }

  // The scratch copy as the room would show it, its steps' states and what each follows read among every roadmap the
  // device holds, the scratch in place of the roadmap it copies.
  get roadmap() {
    if (this.#roadmap) return this.#roadmap;
    const trees = this.standing.trees.map((tree) => (tree.id === this.id ? this.tree.json : tree));
    const opened = new StandingRoadmaps({ ...this.standing, trees }).open(this.id, this.id);
    precondition('roadmap' in opened, 'a scratch copy stands as the roadmap it copies');
    this.#roadmap = opened.roadmap;
    return this.#roadmap;
  }

  // §7 The base: every register the set touches, in the order the changes first touch it, with the copy's stamp.
  get base() { return [...this.#base.values()]; }

  // §7 The steps the set removes, each as it stood when its change folded.
  get removes() { return [...this.#removes]; }

  // The roadmap as the set leaves it: its present kinds and steps in the room's order, each step with its words, its
  // colour, what it follows and its state.
  get folded() {
    const { tree, roadmap } = this;
    return {
      kinds: tree.kinds.filter((kind) => kind.present).map(({ id, label, hue, description }) => ({ id, label, hue, description })),
      steps: tree.nodes.filter((node) => node.present).map((node) => ({ id: node.id, label: node.label, color: node.color, description: node.description,
        links: node.links.map(({ url, label }) => ({ url, label })), prerequisites: roadmap.graph.followed(node.id).map((entry) => entry.id),
        state: roadmap.state(node.id) })),
    };
  }

  // §7 One change in the record's form folded over the scratch, after the checks of the copy, in order: a step under a
  // delete the person can still undo, an id it gives that the copy holds, the steps and kinds it names, the caps of the
  // roadmap's counts, the op's own check of its links or hues, a register the turn saw at another stamp than the copy's,
  // the marks, and a change that writes nothing. Answers the refusal of the change at `at`, or null once it has folded.
  /** @param {Change} change @param {number} at @returns {Refused | null} */
  apply(change, at) {
    const records = this.#records;
    const named = stepsNamed(change);
    const held = named.find((id) => this.held.has(id));
    if (held !== undefined) return refusal(AbilityCodes.roadmapNotReady, held, at);
    const giving = givenBy(change);
    const taken = giving.find(({ type, id }) => (type === 'node' ? records.nodes : records.kinds).has(id));
    if (taken) return refusal(AbilityCodes.invalidInput, taken.id, at);
    const unknown = named.find((id) => (REF.test(id) && !this.#given.has(id)) || records.nodes.get(id)?.present !== true);
    if (unknown !== undefined) return refusal(AbilityCodes.unknownStep, unknown, at);
    const kinds = kindsNamed(change);
    const shown = kinds.length ? new Set(new LegendRead(this.tree).shown.flatMap(({ kind }) => (kind ? [kind.id] : []))) : new Set();
    const kind = kinds.find((id) => (REF.test(id) && !this.#given.has(id)) || !shown.has(id));
    if (kind !== undefined) return refusal(AbilityCodes.unknownKind, kind, at);
    const folding = this.folding(change);
    if (this.passesCaps(folding.writes)) return refusal(AbilityCodes.overLimit, this.id, at);
    const own = folding.check?.();
    if (own) return refusal(own.refused.code, own.refused.id, at);
    const touched = this.touched(named, [...folding.writes, ...folding.names ?? []], new Set(giving.map(({ id }) => id)));
    const moved = touched.find((each) => each.moved);
    if (moved) return refusal(AbilityCodes.roadmapChanged, moved.owner, at);
    const marks = folding.marks?.();
    if (marks) return refusal(marks.refused.code, marks.refused.id, at);
    if (folding.unchanged ?? folding.writes.every((write) => sameJson(valueIn(records, write), write.value))) {
      return refusal(AbilityCodes.noChange, subjectOf(change), at);
    }
    if (folding.removes !== undefined) this.#removes.push(this.removal(folding.removes));
    for (const { key, entry } of touched) if (!this.#base.has(key)) this.#base.set(key, entry);
    for (const { id } of giving) this.#given.add(id);
    for (const write of folding.writes) writeInto(records, write);
    this.#tree = null;
    this.#roadmap = null;
    return null;
  }

  // What one change writes, by its op, of a scratch that shows every step and kind it names.
  /** @param {Change} change @returns {Folding} */
  folding(change) {
    const { nodeId } = change;
    switch (change.op) {
      case 'add_step': return { writes: this.newStep(nodeId, change, [...new Set(/** @type {string[]} */ (change.prerequisites ?? []))], []) };
      case 'remove_step': return { writes: [nodeLife(nodeId, false)], removes: nodeId,
        check: () => (new EffectsRead(this.roadmap.graph, [nodeId]).takesEveryStart ? refusal(AbilityCodes.takesEveryStart, nodeId) : null) };
      case 'rename': return { writes: [nodeField(nodeId, 'label', change.label)] };
      case 'describe': return { writes: [...(change.description === undefined ? [] : [nodeField(nodeId, 'description', change.description)]),
        ...(change.links === undefined ? [] : [nodeField(nodeId, 'links', webLinks(change.links))])] };
      case 'set_kind': return { writes: [nodeField(nodeId, 'color', this.hueOf(change.kind))] };
      case 'connect': return this.connecting(nodeId, change.prerequisiteId);
      case 'disconnect': return this.disconnecting(nodeId, change.prerequisiteId);
      case 'merge': return this.merging(change);
      case 'split': return this.splitting(change);
      case 'set_progress': return this.marking(nodeId, change.status);
      case 'add_kind': return this.newKind(change);
      case 'rename_kind': return { writes: [kindField(change.kind, 'label', change.label)] };
      case 'recolor_kind': return this.recolouring(change.kind, change.hue);
      default: throw new TypeError(`no op ${change.op}`);
    }
  }

  // A new step after the steps it follows, wearing its kind's hue, where it names none the colour `words` carries (a
  // split's step's) or terracotta, its order key the room's for a new step, after the keys of `placed`.
  /** @param {string} id @param {Change} words @param {string[]} following @param {string[]} placed @returns {Write[]} */
  newStep(id, words, following, placed) {
    const color = words.kind === undefined ? words.color ?? 'terracotta' : this.hueOf(words.kind);
    return [nodeLife(id, true), nodeField(id, 'label', words.label), nodeField(id, 'color', color), nodeField(id, 'description', words.description ?? ''),
      nodeField(id, 'links', webLinks(words.links)), nodeField(id, 'ord', newStepOrd(this.tree, following[0] ?? null, placed)),
      ...following.map((from) => linkLife(from, id, true))];
  }

  // A link added, the step `nodeId` coming to wait on `prerequisiteId`. A link the step already follows, through removed
  // steps too, changes nothing and so closes nothing; a new one that would close a loop is refused as the room's is.
  /** @param {string} nodeId @param {string} prerequisiteId @returns {Folding} */
  connecting(nodeId, prerequisiteId) {
    const follows = this.roadmap.graph.followed(nodeId).some((entry) => entry.id === prerequisiteId);
    return { writes: [linkLife(prerequisiteId, nodeId, true)], unchanged: follows,
      check: () => (!follows && firstLoop(this.tree, [[prerequisiteId, nodeId]], new Set()) === 0 ? refusal(AbilityCodes.closesCycle, nodeId) : null) };
  }

  // A link removed, as the room's own removes one: the step's direct link, or, of a prerequisite it follows through
  // removed steps alone, each link by which it reaches it. The direct link is named either way, so one the turn read that
  // is gone since is a roadmap changed, not a change of nothing.
  /** @param {string} nodeId @param {string} prerequisiteId @returns {Folding} */
  disconnecting(nodeId, prerequisiteId) {
    const direct = linkLife(prerequisiteId, nodeId, false);
    if (this.#records.edges.get(linkKey(prerequisiteId, nodeId))?.present) return { writes: [direct] };
    const followed = this.roadmap.graph.followed(nodeId).find((entry) => entry.id === prerequisiteId);
    return { writes: (followed?.incoming ?? []).map(([from = '', to = '']) => linkLife(from, to, false)), names: [direct] };
  }

  // R-9: `removeId` folds into `nodeId`, which keeps its mark and web links and takes the words sent. Each live link into
  // or out of `removeId` dies and its like is made to or from `nodeId`, one that already stands made once; a link between
  // the two dies with them. `removeId` is removed, its web links with it. A link is between the two as the follow graph
  // reads one, through deleted steps (Roadmap on the sync engine D-5): directly, or through deleted steps alone.
  /** @param {Change} change @returns {Folding} */
  merging({ nodeId, removeId, label, description }) {
    const touching = this.tree.edges.filter((edge) => edge.present && (edge.from === removeId || edge.to === removeId));
    /** @type {Map<string, string[]>} */
    const made = new Map();
    for (const { from, to } of touching) {
      const between = from === removeId ? to === nodeId || this.reachesThroughAbsent(to, 'children', nodeId)
        : from === nodeId || this.reachesThroughAbsent(from, 'parents', nodeId);
      const [madeFrom = '', madeTo = ''] = from === removeId ? [nodeId, to] : [from, nodeId];
      if (between || from === to || this.#records.edges.get(linkKey(madeFrom, madeTo))?.present) continue;
      made.set(linkKey(madeFrom, madeTo), [madeFrom, madeTo]);
    }
    const others = [...(label === undefined ? [] : [nodeField(nodeId, 'label', label)]), ...(description === undefined ? [] : [nodeField(nodeId, 'description', description)]),
      ...touching.map(({ from, to }) => linkLife(from, to, false)), nodeLife(removeId, false)];
    const links = [...made.values()];
    return { writes: [...others, ...links.map(([from = '', to = '']) => linkLife(from, to, true))], removes: removeId,
      check: () => this.loopRefusal(others, links, nodeId) };
  }

  // R-9: the step becomes its parts, side by side: each follows the step's prerequisites and precedes each step that
  // followed it by a copy of each of its live links, takes its mark, and its colour unless it names a kind. The step and
  // its links die.
  /** @param {Change} change @returns {Folding} */
  splitting({ nodeId, parts }) {
    const touching = this.tree.edges.filter((edge) => edge.present && (edge.from === nodeId || edge.to === nodeId));
    const before = touching.filter((edge) => edge.to === nodeId && edge.from !== nodeId).map((edge) => edge.from);
    const after = touching.filter((edge) => edge.from === nodeId && edge.to !== nodeId).map((edge) => edge.to);
    const step = /** @type {StepInput} */ (this.#records.nodes.get(nodeId));
    const mark = this.#records.marks.get(nodeId);
    /** @type {string[]} */
    const placed = [];
    /** @type {Write[]} */
    const others = [...touching.map(({ from, to }) => linkLife(from, to, false)), nodeLife(nodeId, false)];
    /** @type {string[][]} */
    const links = [];
    for (const part of /** @type {Change[]} */ (parts)) {
      const made = this.newStep(part.nodeId, { color: step.color, ...part }, before, placed);
      placed.push(String(made.find((write) => write.register === 'ord')?.value));
      others.push(...made.filter((write) => write.t !== 'edge'));
      if (mark) others.push({ t: 'progress', id: part.nodeId, register: 'mark', value: { status: mark.status, outOfOrder: mark.outOfOrder ?? false } });
      links.push(...before.map((from) => [from, part.nodeId]), ...after.map((to) => [part.nodeId, to]));
    }
    return { writes: [...others, ...links.map(([from = '', to = '']) => linkLife(from, to, true))], removes: nodeId,
      check: () => this.loopRefusal(others, links, nodeId) };
  }

  // §6 rule 7 for a mark: a step that opens a roadmap takes none, and a locked step is not marked complete; a mark that
  // already stands changes nothing.
  /** @param {string} nodeId @param {'complete' | 'none'} status @returns {Folding} */
  marking(nodeId, status) {
    const { roadmap } = this;
    const state = roadmap.state(nodeId);
    return { writes: [{ t: 'progress', id: nodeId, register: 'mark', value: { status, outOfOrder: false } }], unchanged: (state === 'complete') === (status === 'complete'),
      marks: () => {
        if (roadmap.openings.has(nodeId)) return refusal(AbilityCodes.opensRoadmap, nodeId);
        return status === 'complete' && state === 'locked' ? refusal(AbilityCodes.stepLocked, nodeId) : null;
      } };
  }

  // A new kind after the kinds the roadmap holds, wearing a hue no present kind wears.
  /** @param {Change} change @returns {Folding} */
  newKind({ kind, label, hue, description = '' }) {
    const keys = [...this.#records.kinds.values()].flatMap((each) => (each.present && each.ord && isOrderKey(each.ord) ? [each.ord] : [])).sort(compareText);
    return { writes: [kindField(kind, 'life', true), kindField(kind, 'hue', hue), kindField(kind, 'label', label), kindField(kind, 'description', description),
      kindField(kind, 'ord', between(keys.at(-1) ?? null, null))], check: () => this.hueRefusal(hue, kind) };
  }

  // A kind's hue, and the colour of every step the copy holds wearing its old one, present or not, as the room's recolour
  // repaints them; the repainting is the room's command's, no register of the base.
  /** @param {string} kind @param {string} hue @returns {Folding} */
  recolouring(kind, hue) {
    const old = this.hueOf(kind);
    const wearing = [...this.#records.nodes.values()].filter((node) => (node.color ?? 'terracotta') === old);
    return { writes: [kindField(kind, 'hue', hue), ...wearing.map((node) => /** @type {Write} */ ({ ...nodeField(node.id, 'color', hue), base: false }))],
      check: () => this.hueRefusal(hue, kind) };
  }

  // §6.1 `hue-taken`: a hue another present kind wears, checked at each change as the room's recolour checks it, so two
  // kinds do not swap hues in one proposal.
  /** @param {string} hue @param {string} kind */
  hueRefusal(hue, kind) {
    return [...this.#records.kinds.values()].some((each) => each.present && each.id !== kind && each.hue === hue) ? refusal(AbilityCodes.hueTaken, kind) : null;
  }

  // `closes-cycle`: a link a change makes that, over the scratch as the change's other writes leave it, lies on a loop
  // that holds a present step.
  /** @param {Write[]} writes @param {string[][]} links @param {string} nodeId */
  loopRefusal(writes, links, nodeId) {
    const { nodes, edges, kinds, marks } = this.#records;
    const trial = { nodes: new Map(nodes), edges: new Map(edges), kinds: new Map(kinds), marks: new Map(marks) };
    for (const write of writes) writeInto(trial, write);
    return firstLoop(this.treeOf(trial), links, new Set()) >= 0 ? refusal(AbilityCodes.closesCycle, nodeId) : null;
  }

  // §6 rule 4 over the scratch: whether what a change makes would pass the roadmap's caps of steps, links or kinds, which
  // count what it holds alive, a step under a delete the person can still undo among them.
  /** @param {Write[]} writes */
  passesCaps(writes) {
    /** @param {string} t @param {Map<string, { present?: boolean }>} records @param {number} holding @param {number} cap */
    const passes = (t, records, holding, cap) => {
      const lives = writes.filter((write) => write.t === t && write.register === 'life').map((write) => ({ alive: write.value === true,
        was: records.get(t === 'edge' ? jcs(write.id) : String(write.id))?.present === true }));
      const growth = lives.filter(({ alive, was }) => alive && !was).length - lives.filter(({ alive, was }) => !alive && was).length;
      return growth > 0 && [...records.values()].filter((record) => record.present).length + holding + growth > cap;
    };
    const { nodes, edges, kinds } = this.#records;
    return passes('node', nodes, this.held.size, RoadmapCaps.steps) || passes('edge', edges, 0, RoadmapCaps.links) || passes('kind', kinds, 0, RoadmapCaps.kinds);
  }

  // §7 The registers a change touches, each with the base entry it adds and whether the turn saw it at another stamp
  // than the copy's: the being there of every step it names, then every register it writes but the room's command's,
  // and every register it names without writing, each once. A record of a new step or kind of the set is that id's alone: only the life of each the change itself
  // gives joins the base, unheld.
  /** @param {string[]} named @param {Write[]} writes @param {Set<string>} giving */
  touched(named, writes, giving) {
    /** @param {string} id */
    const isNew = (id) => this.#given.has(id) || giving.has(id);
    /** @type {Map<string, { key: string, entry: BaseRegister, moved: boolean, owner: string }>} */
    const touched = new Map();
    for (const { t, id, register } of [...named.map((each) => nodeLife(each, true)), ...writes.filter((write) => write.base !== false)]) {
      const ids = t === 'edge' ? /** @type {string[]} */ (id) : [String(id)];
      const record = recordKey(t === 'progress' ? RoadmapScopes.overlay(this.id) : RoadmapScopes.tree(this.id), t, id);
      const key = `${record} ${register}`;
      if (touched.has(key)) continue;
      if (ids.some(isNew)) {
        if (t !== 'edge' && t !== 'progress' && register === 'life' && giving.has(String(id))) touched.set(key, { key, entry: { t, id, register, stamp: null }, moved: false, owner: String(id) });
        continue;
      }
      const copy = stampIn(this.stamps, record, register);
      const seen = stampIn(this.seen, record, register);
      touched.set(key, { key, entry: { t, id, register, stamp: copy.stamp }, moved: seen.held && seen.stamp !== copy.stamp, owner: ids.at(-1) ?? '' });
    }
    return [...touched.values()];
  }

  // Whether `start`, a step the scratch holds no present step of, reaches `target` over live links onward (`children`) or
  // back (`parents`) through such steps alone, as the follow graph reads a link through absent steps.
  /** @param {string} start @param {'children' | 'parents'} way @param {string} target */
  reachesThroughAbsent(start, way, target) {
    const { index } = this.tree;
    const begin = index.rawSlot.get(start);
    const goal = index.slot.get(target);
    if (begin === undefined || begin < index.ids.length || goal === undefined) return false;
    const passed = new Set([begin]);
    for (const pending = [begin]; pending.length;) {
      for (const next of index[way][/** @type {number} */ (pending.pop())] ?? []) {
        if (next === goal) return true;
        if (next < index.ids.length || passed.has(next)) continue;
        passed.add(next);
        pending.push(next);
      }
    }
    return false;
  }

  // A tree of scratch records.
  /** @param {ScratchRecords} records */
  treeOf({ nodes, edges, kinds, marks }) {
    return new RoadmapTree({ ...this.input, nodes: [...nodes.values()], edges: [...edges.values()], kinds: [...kinds.values()], marks: [...marks.values()] });
  }

  // The hue of a kind the scratch holds.
  /** @param {string} kind */
  hueOf(kind) {
    return /** @type {KindInput} */ (this.#records.kinds.get(kind)).hue;
  }

  // §7 A step a change removes, as it stands in the scratch: its id, label, the Unicode scalars of its description, how
  // many web links it carries and whether it is complete.
  /** @param {string} id @returns {Removal} */
  removal(id) {
    const step = /** @type {StepInput} */ (this.#records.nodes.get(id));
    return { nodeId: id, label: step.label ?? '', descriptionChars: [...(step.description ?? '')].length, links: (step.links ?? []).length,
      done: this.roadmap.state(id) === 'complete' };
  }
}

/** @param {string} id @param {boolean} alive @returns {Write} */
const nodeLife = (id, alive) => ({ t: 'node', id, register: 'life', value: alive });
/** @param {string} id @param {string} field @param {Json} value @returns {Write} */
const nodeField = (id, field, value) => ({ t: 'node', id, register: field, value });
/** @param {string} id @param {string} field @param {Json} value @returns {Write} */
const kindField = (id, field, value) => ({ t: 'kind', id, register: field, value });
/** @param {string} from @param {string} to @param {boolean} alive @returns {Write} */
const linkLife = (from, to, alive) => ({ t: 'edge', id: [from, to], register: 'life', value: alive });

// `propose_roadmap_change` (§7): the changes folded in order over a scratch copy of the standing roadmap, each validated,
// and the proposal minted of them: its id and one id for each ref, drawn from the tool host's random source once the set
// validates, the record's changes each ref under its id, and the base. The call is checked in order: its Shape; the
// roadmap and the person; the count of changes; each change, at its index, the rules of its input and then the fold's
// checks; and the record's size. `seen` are the stamps the turn's reads returned (§5).
/**
 * @param {Standing} standing @param {Change} input @param {string | null} about @param {IdSource} ids @param {RecordStamps[]} [seen]
 * @returns {AbilityResponse}
 */
function proposeRoadmapChange(standing, input, about, ids, seen = []) {
  const shape = shapeRefusal(input);
  if (shape) return shape;
  const { treeId, changes } = input;
  const opened = StandingRoadmaps.of(standing).open(treeId, about);
  if (!('roadmap' in opened)) return opened;
  if (!opened.roadmap.tree.own) return refusal(AbilityCodes.notOwner, treeId);
  if (changes.length > limits.limits.proposalChanges.max) return refusal(AbilityCodes.overLimit, undefined, limits.limits.proposalChanges.max);
  const fold = new ProposalFold(standing, opened.roadmap, seen);
  /** @type {Set<string>} */
  const refs = new Set();
  for (const [at, change] of /** @type {[number, Change][]} */ ([...changes.entries()])) {
    const refused = (() => {
      const held = stepsNamed(change).find((id) => fold.held.has(id));
      if (held !== undefined) return refusal(AbilityCodes.roadmapNotReady, held, at);
      return formRefusal(change, refs, at) ?? fold.apply(recorded(change, (ref) => ref), at);
    })();
    if (refused) return refused;
  }
  const proposalId = ids('coachProposal');
  /** @type {Map<string, string>} */
  const minted = new Map(/** @type {Change[]} */ (changes).flatMap(givenBy).map(({ type, id }) => [id, ids(type)]));
  /** @param {string} name */
  const idOf = (name) => minted.get(name) ?? name;
  const record = {
    changes: changes.map((/** @type {Change} */ change) => recorded(change, idOf)),
    base: fold.base.map((entry) => ({ ...entry, id: Array.isArray(entry.id) ? entry.id : idOf(entry.id) })),
  };
  if (jcsBytes(record.changes).length > limits.limits.proposalChangesBytes.max || jcsBytes(record.base).length > limits.limits.proposalBaseBytes.max) {
    return refusal(AbilityCodes.overLimit);
  }
  return { result: { proposalId, removes: fold.removes.map((removal) => ({ ...removal, nodeId: idOf(removal.nodeId) })) }, proposal: record };
}

// The ability of `../../../../../../packages/api-contract/roadmap/catalog.json` that proposes.
export const ProposalAbilities = Object.freeze({
  propose_roadmap_change: proposeRoadmapChange,
});
