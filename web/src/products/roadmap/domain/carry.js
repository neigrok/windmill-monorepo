// @ts-check

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
import { Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation } from '../../../platform/domain-kit/values.js';
import { hashText } from '../../../platform/sync/core/encoding.js';
import { between, isOrderKey } from '../../../../../packages/api-contract/sync/reference/core/fracindex.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';
import { CoachMessage, CoachProposal, CoachThread, CoachWriteFate } from './conversation.js';
import { RoadmapKind, RoadmapKindValue } from './kinds.js';
import { StepMark, StepMarkValue } from './progress.js';
import { HUES, HeldRecord, RoadmapRefusals, RoadmapScopes, RoadmapSpecs, gone, writeIn } from './roadmapRules.js';
import { Roadmap, RoadmapMeta, RoadmapMetaValue, RoadmapValue } from './roadmaps.js';
import { ImportUnit, RoadmapLinkValue, RoadmapStep, RoadmapStepValue, importChunks } from './steps.js';
import { StepNote, StepNoteValue } from './workspace.js';

/** @typedef {import('../../../platform/domain-kit/acts.js').ActReader} ActReader */
/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/time.js').Moment} Moment */
/** @typedef {import('../../../../../packages/api-contract/sync/reference/core/registry.js').Registry} Registry */
/** @typedef {{ t: string, id: string }} Subject */
/** @typedef {{ id: string, hue: string, label: string, description: string }} OldKind */
/** @typedef {{ id: string, label: string, icon: string, color: string, description: string, links: { url: string, label: string }[], order: string }} OldStep */
/** @typedef {{ title: string, guide: string, kinds: OldKind[], steps: OldStep[], links: string[][] }} OldRoadmap */
/** @typedef {'pastBound' | 'capFilled' | 'roadmapDeleted' | 'accessEnded'} KeptReason */
/** @typedef {{ id: string, reason: KeptReason, subject: Subject, values: Record<string, Json>, named: string }} Kept */
/** @typedef {{ notice: string, settles: boolean }} CarryRefusal */

// §8.2 What a browser holds: the rules the carry-over follows as it moves what roadmap's old bundle kept into the
// replica. Only a browser that ran the old bundle holds its stores, so these rules are the web's alone.

// The id a carried thing takes, derived from its old one, so carrying twice writes nothing twice: a roadmap the server
// holds for someone else, or as spent, takes a fresh roadmap id, and each workspace item its own.
export const CarriedIds = Object.freeze({
  /** @param {string} old */
  roadmap: (old) => `t_${hashText(jcs(['roadmap', old])).slice(0, 16)}`,
  /** @param {string} type @param {string} tree @param {string} step @param {string} old */
  item: (type, tree, step, old) => hashText(jcs([type, tree, step, old])).slice(0, 32),
});

// A carried roadmap's steps keep their order: each old key that still sorts after the one before it stands, and every
// other step takes a key in its place, as production's move does (§8.1). `keys` are in the old bundle's order.
/** @param {string[]} keys */
export function carriedOrds(keys) {
  /** @type {string[]} */
  const ords = [];
  /** @type {string | null} */
  let previous = null;
  const stands = (/** @type {string | undefined} */ key, /** @type {string | null} */ after) => key !== undefined && isOrderKey(key) && (after === null || key > after);
  keys.forEach((key, index) => {
    if (stands(key, previous)) {
      ords.push(key);
      previous = key;
      return;
    }
    const next = keys.slice(index + 1).find((later) => stands(later, previous)) ?? null;
    const placed = between(previous, next);
    ords.push(placed);
    previous = placed;
  });
  return ords;
}

// A record set aside whole, in the words it held, rather than cut short (§8.2): it goes to §6's one list, named by its
// own words or, where it has none that name it, by what it belongs to (`named`, a step's or a roadmap's name).
/**
 * @param {string} old
 * @param {KeptReason} reason
 * @param {Subject} subject
 * @param {Record<string, Json>} values
 * @param {string} [named]
 * @returns {Kept}
 */
export function kept(old, reason, subject, values, named = '') {
  return Object.freeze({ id: hashText(jcs([old, subject, values])).slice(0, 16), reason, subject, values, named });
}

// The bounds of §4 a workspace item the old bundle kept is held to, by its type: each field and its spec.
/** @type {Readonly<Record<'subtask' | 'stepLink' | 'stepNote', [string, import('../../../platform/domain-kit/values.js').TextSpec][]>>} */
const ITEM_BOUNDS = Object.freeze({
  subtask: [['label', RoadmapSpecs.subtask]],
  stepLink: [['url', RoadmapSpecs.url], ['title', RoadmapSpecs.linkTitle]],
  stepNote: [['text', RoadmapSpecs.note]],
});

// §8.2 Whether a workspace item the old bundle kept stands within the bounds of §4. One past a bound is set aside whole
// before the act that carries the rest, as `CarriedRoadmap` sets aside a record, so that act is never refused for it.
/**
 * @param {'subtask' | 'stepLink' | 'stepNote'} type
 * @param {Record<string, Json>} values
 */
export function withinBounds(type, values) {
  try {
    for (const [field, spec] of ITEM_BOUNDS[type]) spec.apply(String(values[field] ?? ''), new Path(field));
    return true;
  } catch (error) {
    if (!(error instanceof Violation)) throw error;
    return false;
  }
}

// What a roadmap the old bundle kept comes to as the engine's records: its words, its kinds in their order, its steps
// in theirs and the links among them. A colour the engine does not know reads as terracotta and a link with no address
// carries nothing, as the old server read them. A record that fails its type's checks, or that would pass its type's
// cap, is set aside in `kept`, and with a step every link that touches it.
export class CarriedRoadmap {
  /**
   * @param {string} old the roadmap's id in the old store
   * @param {OldRoadmap} roadmap
   * @param {Registry} registry
   * @param {Moment} moment
   */
  constructor(old, { title, guide, kinds, steps, links }, registry, moment) {
    /** @type {Kept[]} */
    this.kept = [];
    const cap = (/** @type {string} */ type) => registry.type(type)?.cap ?? Infinity;
    /** @type {(subject: Subject, values: Record<string, Json>, make: () => any) => any} */
    const checked = (subject, values, make) => {
      try {
        return make();
      } catch (error) {
        if (!(error instanceof Violation)) throw error;
        this.kept.push(kept(old, 'pastBound', subject, values));
        return null;
      }
    };
    const blank = RoadmapMetaValue.blank();
    this.meta = checked({ t: RoadmapMeta.type, id: 'meta' }, { title, guide }, () => new Valid(blank.with({ title, guide }), moment, ['title', 'guide']))
      ?? new Valid(blank, moment, ['title', 'guide']);
    const kindOrds = carriedOrds(kinds.map(() => ''));
    this.kinds = this.capped(old, RoadmapKind.type, cap(RoadmapKind.type), kinds.flatMap((kind, index) => {
      const values = { hue: kind.hue, label: kind.label, description: kind.description };
      const made = checked({ t: RoadmapKind.type, id: kind.id }, values,
        () => new Valid(new RoadmapKindValue(new Id(kind.id, RoadmapKind), { ...values, ord: kindOrds[index] ?? null }), moment));
      return made === null ? [] : [made];
    }));
    const ords = carriedOrds(steps.map((step) => step.order));
    /** @type {Valid<RoadmapStepValue>[]} */
    const made = this.capped(old, RoadmapStep.type, cap(RoadmapStep.type), steps.flatMap((step, index) => {
      const values = { label: step.label, icon: step.icon, color: HUES.includes(step.color) ? step.color : 'terracotta', description: step.description,
        links: step.links.filter((link) => link.url.trim() !== '').map((link) => ({ url: link.url, label: link.label })) };
      const valid = checked({ t: RoadmapStep.type, id: step.id }, values,
        () => new Valid(new RoadmapStepValue(new Id(step.id, RoadmapStep), { ...values, ord: ords[index] ?? null }), moment));
      return valid === null ? [] : [valid];
    }));
    const held = new Set(made.map((step) => String(step.id.record)));
    const linked = new Set();
    /** @type {Valid<RoadmapLinkValue>[]} */
    const among = links.filter(([from = '', to = '']) => from !== to && held.has(from) && held.has(to) && !linked.has(jcs([from, to])) && linked.add(jcs([from, to])))
      .map(([from = '', to = '']) => new Valid(new RoadmapLinkValue(from, to), moment));
    const into = new Map(made.map((step) => [String(step.id.record), /** @type {Valid<RoadmapLinkValue>[]} */ ([])]));
    for (const link of among.slice(0, cap('edge'))) into.get(link.value.to)?.push(link);
    this.units = made.map((step) => new ImportUnit(step, into.get(String(step.id.record)) ?? []));
    Object.freeze(this);
  }

  // The first `cap` of `made`, each one after it set aside.
  /**
   * @template {Valid<any>} V
   * @param {string} old
   * @param {string} type
   * @param {number} cap
   * @param {V[]} made
   * @returns {V[]}
   */
  capped(old, type, cap, made) {
    for (const over of made.slice(cap)) this.kept.push(kept(old, 'capFilled', { t: type, id: String(over.id.record) }, over.written));
    return made.slice(0, cap);
  }
}

// §8.2 A roadmap made signed out, or one carried under a new id, becomes a creation that keeps its ids: the `tree`
// record, then its tree scope with its words, its kinds, and its steps and links in chunks as an import's. A roadmap the
// account already holds, or knows as spent, is not made again. The carry-over keeps no Undo of it.
export class CarryRoadmap {
  /**
   * @param {string} tree the id the roadmap takes
   * @param {CarriedRoadmap} carried
   */
  constructor(tree, carried) {
    this.id = new Id(tree, Roadmap);
    this.carried = carried;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => {
      const roadmaps = account.repository(Roadmap);
      return { held: roadmaps.record(this.id.record, 'stored') !== undefined || roadmaps.spentBorn(this.id) !== null, moment: account.moment };
    });
  }

  /** @param {{ held: boolean, moment: Moment }} loaded */
  decide({ held, moment }) {
    const result = { tree: String(this.id.record) };
    if (held) return ActDecision.unchanged(result);
    const scope = RoadmapScopes.tree(String(this.id.record));
    const { meta, kinds, units } = this.carried;
    const account = new Plan();
    account.create(new Valid(new RoadmapValue(this.id), moment));
    const opening = new Plan();
    opening.create(meta, { fields: meta.value.guide === '' ? ['title'] : ['title', 'guide'] });
    for (const kind of kinds) opening.create(kind);
    const [first = [], ...later] = importChunks(units, 1 + kinds.length);
    for (const unit of first) unit.writeTo(opening, false);
    const segments = later.map((chunk) => {
      const plan = new Plan();
      for (const unit of chunk) unit.writeTo(plan, false);
      return new ScopedPlan(scope, plan);
    });
    return ActDecision.write(new ActPlan([new ScopedPlan(RoadmapScopes.account, account), new ScopedPlan(scope, opening), ...segments]), result);
  }
}

// A mark the carry-over found where no gesture made it, from a step's seed or a mark left undrained from before roadmap's
// own sync: it stands only where the person's overlay holds no mark of the step, so a mark the server has is never
// overwritten by an older one.
export class CarryMark {
  /**
   * @param {string} tree
   * @param {string} step
   */
  constructor(tree, step) {
    this.tree = tree;
    this.step = step;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    const known = read.inScope(RoadmapScopes.tree(this.tree), (tree) => HeldRecord.read(tree.repository(RoadmapStep), new Id(this.step, RoadmapStep)).known);
    return read.inScope(RoadmapScopes.overlay(this.tree), (overlay) => ({
      known, marked: overlay.repository(StepMark).record(this.step, 'stored') !== undefined, moment: overlay.moment,
    }));
  }

  /** @param {{ known: boolean, marked: boolean, moment: Moment }} loaded */
  decide({ known, marked, moment }) {
    if (!known) return gone(RoadmapStep.type, this.step);
    if (marked) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.create(new Valid(new StepMarkValue(new Id(this.step, StepMark), 'complete', false), moment), { fields: ['mark'] });
    return writeIn(RoadmapScopes.overlay(this.tree), plan, null);
  }
}

// A step's note the old bundle kept on this device: written where the step holds no note, and after the note it holds
// where it holds another, so neither is lost; a note that already ends with it writes nothing. A note past its bound is
// refused as the note's own save is, and so set aside.
export class CarryStepNote {
  /**
   * @param {string} tree
   * @param {string} step
   * @param {string} text
   */
  constructor(tree, step, text) {
    this.tree = tree;
    this.step = step;
    this.text = text;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    const known = read.inScope(RoadmapScopes.tree(this.tree), (tree) => HeldRecord.read(tree.repository(RoadmapStep), new Id(this.step, RoadmapStep)).known);
    return read.inScope(RoadmapScopes.overlay(this.tree), (overlay) => ({
      known, note: overlay.repository(StepNote).find(new Id(this.step, StepNote), 'drawn') ?? new StepNoteValue(new Id(this.step, StepNote)), moment: overlay.moment,
    }));
  }

  /** @param {{ known: boolean, note: StepNoteValue, moment: Moment }} loaded */
  decide({ known, note, moment }) {
    if (!known) return gone(RoadmapStep.type, this.step);
    const held = note.text;
    if (this.text === '' || held === this.text || held.endsWith(`\n\n${this.text}`)) return ActDecision.unchanged(null);
    const valid = new Valid(new StepNoteValue(note.id, held === '' ? this.text : `${held}\n\n${this.text}`), moment);
    const plan = new Plan();
    plan.create(valid, { fields: ['text'], from: note });
    return writeIn(RoadmapScopes.overlay(this.tree), plan, null);
  }
}

// Whether one stamp `ms:counter:actor` of the old bundle's clock is newer than another.
/** @param {string} a @param {string} b */
function newer(a, b) {
  const [msA = 0, counterA = 0] = a.split(':').map(Number);
  const [msB = 0, counterB = 0] = b.split(':').map(Number);
  return msA !== msB ? msA > msB : counterA > counterB;
}

// §8.2 The ledger of what the carry-over carried of one old roadmap, a device row of the replica it went to
// (`carry:<old id>`), written in the act that carried it. `to` is the roadmap it became, null where it was not carried
// (not the person's); `created` whether the carry-over made `to` itself, so the old stores stay until the server takes
// that creation; `frontier` the newest stamp of each writer of the old bundle whose changes it carried, so a change an
// old tab makes after it is carried again and nothing before it twice; `items` each workspace item carried, by its old
// key, with a digest of what it held; `marks` a digest of the marks left undrained it carried; `kept` each record it set
// aside for §6's one list, with its reason and its words. The row never leaves the device.
export class CarryLedger {
  /**
   * @param {{ to?: string | null, created?: boolean, frontier?: Record<string, string>, items?: Record<string, string>, marks?: string | null, kept?: Kept[],
   *   refusal?: CarryRefusal | null }} ledger
   */
  constructor({ to = null, created = false, frontier = {}, items = {}, marks = null, kept = [], refusal = null } = {}) {
    this.to = to;
    this.created = created;
    this.frontier = Object.freeze({ ...frontier });
    this.items = Object.freeze({ ...items });
    this.marks = marks;
    this.kept = Object.freeze([...kept]);
    // The refusal of a creation the carry-over made, after which it placed the roadmap again: its notice, and whether the
    // notice may go, every Coach record it holds written again.
    this.refusal = refusal === null ? null : Object.freeze({ ...refusal });
    Object.freeze(this);
  }

  /** @param {string} old */
  static key(old) { return `carry:${old}`; }

  /** @param {string} key */
  static isLedger(key) { return key.startsWith('carry:'); }

  /** @param {unknown} json */
  static of(json) {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return new CarryLedger();
    const row = /** @type {Record<string, any>} */ (json);
    const strings = (/** @type {unknown} */ value) => (value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, each]) => typeof each === 'string')) : {});
    const refusal = row.refusal !== null && typeof row.refusal === 'object' && typeof row.refusal.notice === 'string'
      ? { notice: row.refusal.notice, settles: row.refusal.settles === true } : null;
    return new CarryLedger({ to: typeof row.to === 'string' ? row.to : null, created: row.created === true, frontier: strings(row.frontier), items: strings(row.items),
      marks: typeof row.marks === 'string' ? row.marks : null, kept: Array.isArray(row.kept) ? row.kept.map((each) => ({ ...each, named: typeof each?.named === 'string' ? each.named : '' })) : [],
      refusal });
  }

  // The ledger with another carry's entry added: its roadmap where it names one, and whether the carry-over made it, each
  // writer's newer stamp, its items and marks, each record it kept that this one does not hold, and the refusal it placed
  // the roadmap after where it names one.
  /** @param {CarryLedger} entry */
  merging(entry) {
    const frontier = { ...this.frontier };
    for (const [actor, stamp] of Object.entries(entry.frontier)) if (frontier[actor] === undefined || newer(stamp, frontier[actor] ?? '')) frontier[actor] = stamp;
    const known = new Set(this.kept.map((each) => each.id));
    return new CarryLedger({ to: entry.to ?? this.to, created: entry.to === null ? this.created : entry.created, frontier, items: { ...this.items, ...entry.items },
      marks: entry.marks ?? this.marks,
      kept: [...this.kept, ...entry.kept.filter((each) => !known.has(each.id))], refusal: entry.refusal ?? this.refusal });
  }

  // The ledger less one record it set aside.
  /** @param {string} id */
  without(id) {
    return new CarryLedger({ to: this.to, created: this.created, frontier: this.frontier, items: this.items, marks: this.marks,
      kept: this.kept.filter((each) => each.id !== id), refusal: this.refusal });
  }

  // Whether the old bundle's change under `stamp` was carried.
  /** @param {string} stamp */
  carried(stamp) {
    const [, , ...actor] = stamp.split(':');
    const seen = this.frontier[actor.join(':')];
    return seen !== undefined && !newer(stamp, seen);
  }

  get json() {
    /** @type {Json} */
    const json = { to: this.to, created: this.created, frontier: { ...this.frontier }, items: { ...this.items }, marks: this.marks,
      kept: this.kept.map((each) => ({ id: each.id, reason: each.reason, subject: { ...each.subject }, values: each.values, named: each.named })),
      ...(this.refusal === null ? {} : { refusal: { ...this.refusal } }) };
    return json;
  }
}

// The carry-over's ledger of one old roadmap with an entry added, written through the account's scope, which any
// roadmap's end leaves writable; the last part of every act that carries, so the ledger and what it records land
// together.
export class RecordCarry {
  /**
   * @param {string} old
   * @param {CarryLedger} entry
   */
  constructor(old, entry) {
    this.key = CarryLedger.key(old);
    this.entry = entry;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(RoadmapScopes.account, (account) => CarryLedger.of(account.device(this.key))); }

  /** @param {CarryLedger} held */
  decide(held) {
    const next = held.merging(this.entry);
    if (jcs(next.json) === jcs(held.json)) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.device(this.key, next.json);
    return writeIn(RoadmapScopes.account, plan, null);
  }
}

// §6 A record the carry-over set aside, discarded from the one list: its ledger keeps everything else it records.
// Answers whether the ledger still held it.
export class DiscardKept {
  /**
   * @param {string} old
   * @param {string} id
   */
  constructor(old, id) {
    this.key = CarryLedger.key(old);
    this.id = id;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(RoadmapScopes.account, (account) => CarryLedger.of(account.device(this.key))); }

  /** @param {CarryLedger} held */
  decide(held) {
    if (!held.kept.some((each) => each.id === this.id)) return ActDecision.unchanged(false);
    const plan = new Plan();
    plan.device(this.key, held.without(this.id).json);
    return writeIn(RoadmapScopes.account, plan, true);
  }
}

// How the account's list holds a roadmap: `alive`, `spent` where it held one under the id, or null where it never did.
/**
 * @param {import('../../../platform/domain-kit/reading.js').Reader} read a reader of the account's scope
 * @param {string} id
 * @returns {'alive' | 'spent' | null}
 */
export function listedAs(read, id) {
  const roadmaps = read.repository(Roadmap);
  const record = roadmaps.record(id, 'stored');
  if (record?.life?.[0] === 'alive') return 'alive';
  return record !== undefined || roadmaps.spentBorn(new Id(id, Roadmap)) !== null ? 'spent' : null;
}

// The ledger of one old roadmap as the replica holds it.
/**
 * @param {import('../../../platform/domain-kit/reading.js').Reader} read a reader of the account's scope
 * @param {string} old
 */
export function carryLedgerOf(read, old) {
  return CarryLedger.of(read.device(CarryLedger.key(old)));
}

// Every record the carry-over set aside, each with the old roadmap whose ledger holds it, in the order of their ledgers,
// from roadmap's device rows.
/** @param {Record<string, Json>} rows */
export function carriedKept(rows) {
  return Object.entries(rows).filter(([key]) => CarryLedger.isLedger(key)).sort(([a], [b]) => compareText(a, b))
    .flatMap(([key, row]) => CarryLedger.of(row).kept.map((each) => ({ old: key.slice('carry:'.length), ...each })));
}

/** @typedef {import('../../../platform/domain-kit/entities.js').EntityType<any, string>} CoachType */
/** @typedef {[Json, string]} Register */
/** @typedef {import('../../../platform/domain-kit/refusals.js').NoticeContent} NoticeContent */
/**
 * A Coach record as a notice holds it: its newest life and the newest register of each field it wrote, and whether it
 * made the record.
 * @typedef {{ type: CoachType, id: string, made: boolean, life: [string, string] | null, registers: Record<string, Register> }} CarriedCoachRecord
 */

// Coach's record types, in the order a write makes them: a conversation before its messages, a message before the
// proposal and the write fates that name it.
const COACH_TYPES = Object.freeze([CoachThread, CoachMessage, CoachProposal, CoachWriteFate]);

// The Coach records (roadmap-coach.md §9) a refused creation's notice holds about the roadmap `tree` it would have
// created: each conversation and proposal that names it, each message of those conversations or carrying one of those
// proposals, and the write fates of those messages, read from the notice's deltas and predictions alike. `others` are the
// Coach records it holds about anything else. A record the notice made is nowhere else, but for one in `landed`, made by
// an entry the refusal made an orphan and the server then took, which the device reads from the server as it stands.
export class CarriedConversations {
  /** @param {readonly CarriedCoachRecord[]} records @param {readonly CarriedCoachRecord[]} others */
  constructor(records, others) {
    this.records = Object.freeze([...records]);
    this.others = Object.freeze([...others]);
    Object.freeze(this);
  }

  // How many of `others` a reader of the person's scope does not draw: the records only the notice holds.
  /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
  unheld(read) { return this.others.filter(({ type, id }) => read.repository(type).find(new Id(id, type), 'drawn') === null).length; }

  /**
   * @param {import('../../../platform/domain-kit/refusals.js').Notice} notice
   * @param {string} tree
   * @param {readonly Subject[]} [landed]
   */
  static of(notice, tree, landed = []) {
    const took = new Set(landed.map(({ t, id }) => jcs([t, id])));
    /** @type {Map<string, CarriedCoachRecord>} */
    const found = new Map();
    const newest = (/** @type {string | undefined} */ a, /** @type {string} */ b) => a === undefined || Stamp.compare(b, a) >= 0;
    /** @param {import('../../../platform/domain-kit/refusals.js').NoticeDelta} delta */
    const take = (delta) => {
      const type = COACH_TYPES.find((each) => each.type === delta.t);
      if (type === undefined) return;
      const key = jcs([delta.t, delta.id]);
      const held = found.get(key) ?? { type, id: String(delta.id), made: false, life: null, registers: {} };
      const registers = { ...held.registers };
      for (const [name, register] of Object.entries(delta.f ?? {})) if (newest(registers[name]?.[1], register[1])) registers[name] = register;
      const life = delta.life !== undefined && newest(held.life?.[1], delta.life[1]) ? delta.life : held.life;
      const making = delta.life?.[0] === 'alive' && delta.born === delta.life[1] && !took.has(key);
      found.set(key, { type, id: held.id, made: held.made || making, life, registers });
    };
    /** @param {NoticeContent & { predictions?: { scope: string, d: import('../../../platform/domain-kit/refusals.js').NoticeDelta[] }[] }} content */
    const walk = (content) => {
      for (const delta of content.d ?? []) take(delta);
      for (const prediction of content.predictions ?? []) for (const delta of prediction.d ?? []) take(delta);
      for (const dependent of content.dependents ?? []) walk(dependent);
    };
    walk(notice.content);
    const all = [...found.values()];
    const value = (/** @type {CarriedCoachRecord} */ record, /** @type {string} */ name) => record.registers[name]?.[0];
    const about = (/** @type {CoachType} */ type) => new Set(all.filter((record) => record.type === type && value(record, 'treeId') === tree).map((record) => record.id));
    const threads = about(CoachThread);
    const proposals = about(CoachProposal);
    const messages = new Set(all.filter((record) => record.type === CoachMessage
      && (threads.has(String(value(record, 'threadId'))) || proposals.has(String(value(record, 'proposalId'))))).map((record) => record.id));
    /** @type {Map<CoachType, Set<string>>} */
    const carriedOf = new Map(/** @type {[CoachType, Set<string>][]} */ ([[CoachThread, threads], [CoachProposal, proposals], [CoachMessage, messages]]));
    const ours = (/** @type {CarriedCoachRecord} */ record) => carriedOf.get(record.type)?.has(record.id) ?? messages.has(String(value(record, 'messageId')));
    const rank = (/** @type {CoachType} */ type) => COACH_TYPES.indexOf(type);
    const ordered = all.sort((a, b) => rank(a.type) - rank(b.type) || compareText(a.id, b.id));
    return new CarriedConversations(ordered.filter(ours), ordered.filter((record) => !ours(record)));
  }
}

// §8.2 A refused creation's Coach records written again where the carry-over placed its roadmap again, `to`, in one write
// of the person's records, register by register: a record the device holds in no way, which the notice made and left
// alive, is made again under its own id; of one the device draws, each field the notice wrote later than the device's
// register takes the notice's value, and a death the notice holds later than its life removes it. Every conversation and
// proposal about `from` comes to name `to`. A record the device holds dead, spent or with its removal held is left as
// the device holds it. It answers how many conversations it wrote to.
export class CarryConversations {
  /** @param {CarriedConversations} carried @param {string} from @param {string} to */
  constructor(carried, from, to) {
    this.carried = carried;
    this.from = from;
    this.to = to;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => {
      const holding = (/** @type {CarriedCoachRecord} */ record) => {
        const repository = account.repository(record.type);
        const drawn = repository.record(record.id, 'drawn');
        const held = repository.record(record.id, 'stored') !== undefined || repository.spentBorn(new Id(record.id, record.type)) !== null;
        return { record, drawn: drawn?.life?.[0] === 'alive' ? drawn : undefined, held };
      };
      return { held: this.carried.records.map(holding), moment: account.moment };
    });
  }

  /** @param {ReturnType<CarryConversations['load']>} loaded */
  decide({ held, moment }) {
    const plan = new Plan();
    // A removal of Coach's is held (§9), and a held plan holds removals alone.
    const removals = new Plan();
    /** @type {Set<string>} */
    const conversations = new Set();
    let written = 0;
    const aimed = (/** @type {Record<string, Json>} */ values) => (values.treeId === this.from ? { ...values, treeId: this.to } : values);
    for (const { record: { type, id, made, life, registers }, drawn, held: holding } of held) {
      const record = new Id(id, type);
      /** @type {Record<string, Json>} */
      let value;
      if (drawn === undefined) {
        if (holding || !made || life?.[0] !== 'alive') continue;
        value = aimed(Object.fromEntries(Object.entries(registers).map(([name, [each]]) => [name, each])));
        plan.create(new Valid(type.decoding(record, value), moment));
      } else if (life?.[0] === 'dead' && Stamp.compare(life[1], drawn.life?.[1] ?? Stamp.UNSET) > 0) {
        value = Object.fromEntries(Object.entries(drawn.f ?? {}).map(([name, [each]]) => [name, each]));
        removals.remove(record);
      } else {
        const now = Object.fromEntries(Object.entries(drawn.f ?? {}).map(([name, [each]]) => [name, each]));
        const later = Object.entries(registers).filter(([name, [, stamp]]) => Stamp.compare(stamp, drawn.f?.[name]?.[1] ?? Stamp.UNSET) > 0);
        value = aimed({ ...now, ...Object.fromEntries(later.map(([name, [each]]) => [name, each])) });
        const entity = type.decoding(record, value);
        const writes = entity.fields();
        const changed = Object.keys(value).filter((name) => Object.hasOwn(writes, name) && jcs(value[name] ?? null) !== jcs(now[name] ?? null));
        if (changed.length === 0) continue;
        plan.update(new Valid(entity, moment, changed), { fields: changed });
      }
      written += 1;
      const thread = type === CoachThread ? id : value.threadId;
      if (thread !== undefined && thread !== null) conversations.add(String(thread));
    }
    if (written === 0) return ActDecision.unchanged(0);
    const segments = [plan, removals].filter((each) => each.writing.length > 0).map((each) => new ScopedPlan(RoadmapScopes.account, each));
    return ActDecision.write(new ActPlan(segments), conversations.size);
  }
}

// §8.2 The refusals the carry-over settles: of each creation it made, the server's refusal of that roadmap as taken or
// spent, which it places again; and each refusal a ledger names, which it placed the roadmap after. No list shows one of
// them and none is a failure: the carry-over reports what it cannot write again. `rows` are roadmap's device rows.
export class CarriedRefusals {
  static CODES = Object.freeze(['id-taken', 'id-spent']);

  /** @param {readonly string[]} created @param {readonly string[]} notices */
  constructor(created, notices) {
    this.created = new Set(created);
    this.notices = new Set(notices);
    Object.freeze(this);
  }

  /** @param {Record<string, Json>} rows */
  static of(rows) {
    const ledgers = Object.entries(rows).filter(([key]) => CarryLedger.isLedger(key)).map(([, row]) => CarryLedger.of(row));
    return new CarriedRefusals(ledgers.flatMap((ledger) => (ledger.created && ledger.to !== null ? [ledger.to] : [])),
      ledgers.flatMap((ledger) => (ledger.refusal === null ? [] : [ledger.refusal.notice])));
  }

  // Whether `notice` refuses the creation of the roadmap `tree` as taken or spent.
  /** @param {import('../../../platform/domain-kit/refusals.js').Notice} notice @param {string} tree */
  static refuses(notice, tree) {
    return notice.scope === RoadmapScopes.account && CarriedRefusals.CODES.includes(notice.code)
      && (notice.content?.d ?? []).some((delta) => delta.t === Roadmap.type && String(delta.id) === tree);
  }

  /** @param {import('../../../platform/domain-kit/refusals.js').Notice} notice */
  settles(notice) {
    return this.notices.has(notice.id) || [...this.created].some((tree) => CarriedRefusals.refuses(notice, tree));
  }
}
