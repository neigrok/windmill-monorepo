// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { Fields, Id, compareText, uniqueInByteOrder } from '../../../platform/domain-kit/entities.js';
import { Plan, Prediction } from '../../../platform/domain-kit/plans.js';
import { LocalDay } from '../../../platform/domain-kit/time.js';
import { Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation } from '../../../platform/domain-kit/values.js';
import { claimBody, isDocumentStamp, nextDocumentStamp } from '../../../platform/sync/core/content.js';
import { hashText } from '../../../platform/sync/core/encoding.js';
import { jcs } from '../../../platform/sync/core/jcs.js';
import { EDITOR_DRAFT_KEY, EDITOR_RECOVERY_PREFIX, JOURNAL_SCOPE, JournalState, JournalStateValue, Page, PageDocument, STATE_FIELDS } from './page.js';
import { ClaimPageSpecs, JournalRefusals, JournalRules, SavePageSpecs } from './journalRules.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/actions.js').IDSource} IDSource */
/** @typedef {import('../../../platform/domain-kit/time.js').Moment} Moment */
/** @typedef {import('./page.js').DocumentFields} DocumentFields */
/** @typedef {import('./journalRules.js').JournalRefusal} JournalRefusal */
/** @typedef {LocalDay | string} DayInput */
/** @typedef {{ day: DayInput, document: PageDocument | DocumentFields, retiring?: string[] }} SaveInput */

/** @param {DayInput} value */
function dayOf(value) {
  const day = typeof value === 'string' ? LocalDay.parse(value) : value instanceof LocalDay ? LocalDay.parse(value.text) : null;
  if (day === null) throw new TypeError('invalid journal day');
  return day;
}

/** @param {PageDocument | DocumentFields} value */
function documentOf(value) { return value instanceof PageDocument ? value : PageDocument.fromJSON(value); }

export const ContentClock = Object.freeze({
  /** @param {Json} stamp */
  valid: (stamp) => isDocumentStamp(stamp),
  /** @param {{ clock?: Json | null, observed?: Json | null, now: number, actor: string }} input */
  advance({ clock = null, observed = null, now, actor }) {
    const fields = Fields.object(clock ?? { ms: 0, counter: 0 }, 'contentClock');
    const pair = { ms: fields.int('ms'), counter: fields.int('counter') };
    return /** @type {{ ms: number, counter: number, actor: string }} */ (nextDocumentStamp({ pair, observed, now, actor }));
  },
  /** @param {{ ms: number, counter: number }} stamp */
  pair: (stamp) => ({ ms: stamp.ms, counter: stamp.counter }),
});

export class SavePageCommand {
  static command = 'journal.savePage';
  static body = SavePageSpecs.body;
  static source = SavePageSpecs.source;
  static actor = SavePageSpecs.actor;

  /** @param {DocumentFields & { day: DayInput, stamp: Json }} args */
  constructor(args) {
    const day = dayOf(args.day);
    const doc = PageDocument.fromJSON({ body: args.body, mood: args.mood, energy: args.energy, source: args.source });
    if (!Object.hasOwn(args, 'stamp')) throw new TypeError('missing journal stamp');
    JournalRules.check(doc);
    const { stamp } = args;
    if (stamp !== null && typeof stamp === 'object' && !Array.isArray(stamp) && typeof stamp.actor === 'string') {
      SavePageSpecs.actor.apply(stamp.actor, new Path('stamp.actor'));
    }
    if (!ContentClock.valid(stamp)) throw new Violation('journal.documentStamp', new Path('stamp'), { kind: 'custom', custom: 'invalidStamp' });
    this.name = SavePageCommand.command;
    this.specs = Object.values(SavePageSpecs);
    this.args = { day: day.text, ...doc.fields(), stamp };
    Object.freeze(this);
  }
}

export class ClaimPageCommand {
  static command = 'journal.claimPage';
  static body = ClaimPageSpecs.body;
  static source = ClaimPageSpecs.source;
  static claimId = ClaimPageSpecs.claimId;

  /** @param {DocumentFields & { day: DayInput, claimId: string }} args */
  constructor(args) {
    const day = dayOf(args.day);
    const doc = PageDocument.fromJSON({ body: args.body, mood: args.mood, energy: args.energy, source: args.source });
    if (typeof args.claimId !== 'string') throw new TypeError('missing journal claim id');
    JournalRules.check(doc, ClaimPageSpecs);
    ClaimPageSpecs.claimId.apply(args.claimId, new Path('claimId'));
    this.name = ClaimPageCommand.command;
    this.specs = Object.values(ClaimPageSpecs);
    this.args = { day: day.text, ...doc.fields(), claimId: args.claimId };
    Object.freeze(this);
  }
}

export class EditorDraft {
  static key = EDITOR_DRAFT_KEY;
  static recoveryPrefix = EDITOR_RECOVERY_PREFIX;

  /** @param {{ day: DayInput, document: PageDocument | DocumentFields }} input */
  constructor({ day, document: doc }) {
    this.day = dayOf(day);
    this.document = documentOf(doc);
    Object.freeze(this);
  }

  /** @param {Json} json */
  static fromJSON(json) {
    const fields = Fields.object(json, 'editorDraft');
    return new EditorDraft({ day: fields.string('day'), document: PageDocument.fromJSON(fields.present('document')) });
  }

  get json() { return { day: this.day.text, document: this.document.fields() }; }

  /** @param {EditorDraft | null} incoming @param {EditorDraft | null} current */
  static adopt(incoming, current) {
    const distinct = incoming !== null && current !== null
      && (incoming.day.text !== current.day.text || !incoming.document.equals(current.document));
    return { current: current ?? incoming, recovered: distinct ? incoming : null };
  }

  get recoveryKey() { return `${EditorDraft.recoveryPrefix}${hashText(jcs(this.json))}`; }

  /** @param {Record<string, Json>} rows @param {EditorDraft} draft */
  static retain(rows, draft) { rows[draft.recoveryKey] = draft.json; }
}

export class PreserveEditorDraft {
  scope = JOURNAL_SCOPE;
  refusals = JournalRefusals;

  /** @param {{ day: DayInput, document: PageDocument | DocumentFields }} input */
  constructor(input) { this.draft = new EditorDraft(input); }
  /** @param {Reader} read */
  load(read) { return null; }
  /** @param {null} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    const plan = new Plan();
    plan.device(EditorDraft.key, this.draft.json);
    return Decision.write(plan, null);
  }
}

export class PendingClaim {
  /** @param {{ day: DayInput, claimId: string, document: PageDocument | DocumentFields, retirements?: Record<string, Json> }} input */
  constructor({ day, claimId, document: doc, retirements = {} }) {
    this.day = dayOf(day);
    this.claimId = claimId;
    this.base = documentOf(doc);
    this.latest = this.base;
    /** @type {string[]} */
    this.touched = [];
    this.retirements = { ...retirements };
    /** @type {{ epoch: string, seq: number } | null} */
    this.claimResult = null;
    /** @type {Json | null} */
    this.refusal = null;
  }

  /** @param {Json} json */
  static fromJSON(json) {
    const fields = Fields.object(json, 'pendingClaim');
    const pending = new PendingClaim({ day: fields.string('day'), claimId: fields.string('claimId'),
      document: PageDocument.fromJSON(fields.present('base')),
      retirements: Fields.object(fields.present('retirements'), 'pendingClaim', 'retirements').values });
    pending.latest = PageDocument.fromJSON(fields.present('latest'));
    const touched = fields.present('touched');
    if (!Array.isArray(touched) || touched.some((value) => typeof value !== 'string')) throw fields.failure('touched', 'not string fields');
    pending.touched = uniqueInByteOrder(/** @type {string[]} */ (touched));
    if (!fields.isAbsent('claimResult')) {
      const result = Fields.object(fields.present('claimResult'), 'pendingClaim', 'claimResult');
      pending.claimResult = { epoch: result.string('epoch'), seq: result.int('seq') };
    }
    pending.refusal = fields.json('refusal') ?? null;
    return pending;
  }

  get key() { return `pendingClaim:${this.claimId}`; }
  get json() {
    return { day: this.day.text, claimId: this.claimId, base: this.base.fields(), latest: this.latest.fields(),
      touched: uniqueInByteOrder(this.touched), retirements: { ...this.retirements }, claimResult: this.claimResult, refusal: this.refusal };
  }

  /** @param {PageDocument | DocumentFields} value @param {Record<string, Json>} [retiring] */
  edit(value, retiring = {}) {
    const doc = documentOf(value);
    const latest = this.latest.fields();
    const changed = Object.entries(doc.fields()).filter(([name, next]) => next !== /** @type {Record<string, Json>} */ (latest)[name]).map(([name]) => name);
    this.touched = uniqueInByteOrder([...this.touched, ...changed]);
    this.latest = doc;
    this.retirements = { ...this.retirements, ...retiring };
    return this;
  }

  /** @param {string} joined @param {string} base @param {string} latest */
  static reconcileBody(joined, base, latest) {
    if (joined === base) return latest;
    const suffix = `\n\n${base.trimStart()}`;
    if (base.trim() !== '' && joined.endsWith(suffix)) return claimBody(joined.slice(0, -suffix.length), latest);
    return claimBody(joined, latest);
  }
}

export class JournalWriteState {
  /** @param {Reader} read @param {LocalDay} day */
  constructor(read, day) {
    this.moment = read.moment;
    this.actor = read.actor;
    this.anonymous = read.isAnonymous;
    this.firstPullComplete = read.firstPullComplete();
    this.clock = read.device('contentClock');
    this.page = read.confirmed(Page, Id.ofDay(day, Page));
    this.state = read.repository(JournalState).find(new Id('journalState', JournalState), 'drawn') ?? new JournalStateValue();
    const devices = read.devices('pendingClaim:');
    this.pending = Object.entries(devices).filter(([key]) => key !== EditorDraft.key && !key.startsWith(EditorDraft.recoveryPrefix)).sort(([a], [b]) => compareText(a, b))
      .map(([, value]) => PendingClaim.fromJSON(value));
    const draft = devices[EditorDraft.key];
    this.hasEditorDraft = draft !== undefined && EditorDraft.fromJSON(draft).day.text === day.text;
    this.commands = read.commands();
    this.checkpoint = read.checkpoint();
  }
}

export class SavePage {
  scope = JOURNAL_SCOPE;
  refusals = JournalRefusals;

  /** @param {SaveInput} input */
  constructor({ day, document: doc, retiring = [] }) {
    this.day = dayOf(day);
    this.document = documentOf(doc);
    this.retiring = [...retiring];
  }

  /** @param {Reader} read */
  load(read) { return new JournalWriteState(read, this.day); }

  /** @param {JournalWriteState} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    if (this.day.text !== loaded.moment.today.text) throw new Violation('journal.day', new Path('day'), { kind: 'custom', custom: 'readOnlyDay' });
    const contribution = loaded.anonymous || (!loaded.firstPullComplete && loaded.page === null);
    JournalRules.check(this.document, contribution ? ClaimPageSpecs : SavePageSpecs);
    const retiring = Object.fromEntries(Object.entries(loaded.state.fields()).filter(([, value]) => value === 'retired'));
    for (const field of this.retiring) {
      if (!STATE_FIELDS.includes(field)) throw new Violation('journalState', new Path(field), { kind: 'custom', custom: 'unknownState' });
      retiring[field] = 'retired';
    }
    if (this.document.body !== '') retiring.placeholder = 'retired';
    if (this.document.isWritten) { retiring.privacyLine = 'retired'; retiring.firstPage = 'retired'; }
    if (this.document.mood !== null || this.document.energy !== null) retiring.scales = 'retired';
    const pending = loaded.pending.find((claim) => claim.day.text === this.day.text);
    if (!loaded.anonymous && pending) {
      pending.edit(this.document, retiring);
      const plan = new Plan();
      plan.device(pending.key, pending.json);
      if (loaded.hasEditorDraft) plan.device(EditorDraft.key, null);
      return JournalWriting.write(plan, pending.claimId);
    }
    if (contribution) {
      const prior = loaded.commands.filter(({ command }) => command.name === ClaimPageCommand.command && command.args.day === this.day.text);
      if (prior.some((entry) => !entry.canSupersede)) throw new Violation('journal.claim', new Path('day'), { kind: 'custom', custom: 'claimInFlight' });
      const replaced = loaded.pending.filter((claim) => claim.day.text === this.day.text);
      for (const claim of replaced) Object.assign(retiring, claim.retirements);
      const claimId = ids.opaqueID();
      const plan = JournalWriting.claimPlan({ day: this.day, document: this.document, claimId, retirements: retiring }, loaded.moment);
      plan.supersede(prior.map((entry) => entry.gestureId));
      for (const claim of replaced) plan.device(claim.key, null);
      if (loaded.hasEditorDraft) plan.device(EditorDraft.key, null);
      return JournalWriting.write(plan, claimId);
    }
    const stamp = JournalWriting.stamp(loaded, loaded.page?.f?.documentStamp?.[0] ?? null);
    const plan = Plan.running(new SavePageCommand({ day: this.day, ...this.document.fields(), stamp }),
      [JournalWriting.prediction(this.day, this.document, stamp)]);
    plan.device('contentClock', ContentClock.pair(stamp));
    if (loaded.hasEditorDraft) plan.device(EditorDraft.key, null);
    JournalWriting.retire(retiring, plan, loaded.moment);
    return JournalWriting.write(plan, null);
  }
}

export class ClaimPage {
  scope = JOURNAL_SCOPE;
  refusals = JournalRefusals;

  /** @param {SaveInput} input */
  constructor(input) { this.save = new SavePage(input); }
  /** @param {Reader} read */
  load(read) { return this.save.load(read); }
  /** @param {JournalWriteState} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    if (!loaded.anonymous) throw new Violation('journal.claim', new Path('day'), { kind: 'custom', custom: 'boundClaim' });
    return this.save.decide(loaded, ids);
  }
}

export class ReconcileClaim {
  scope = JOURNAL_SCOPE;
  refusals = JournalRefusals;

  /** @param {{ day: DayInput, claimId: string }} input */
  constructor({ day, claimId }) { this.day = dayOf(day); this.claimId = claimId; }
  /** @param {Reader} read */
  load(read) { return new JournalWriteState(read, this.day); }
  /** @param {JournalWriteState} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    const pending = loaded.pending.find((claim) => claim.claimId === this.claimId && claim.day.text === this.day.text);
    if (!pending || pending.refusal !== null || pending.claimResult === null) return Decision.unchanged(false);
    const { epoch, seq } = pending.claimResult;
    if (loaded.checkpoint.epoch !== null && loaded.checkpoint.epoch !== epoch) {
      const outstanding = loaded.commands.some(({ command }) => command.name === ClaimPageCommand.command && command.args.claimId === pending.claimId);
      const plan = outstanding ? new Plan() : Plan.running(new ClaimPageCommand({ day: pending.day, ...pending.base.fields(), claimId: pending.claimId }));
      pending.claimResult = null;
      plan.device(pending.key, pending.json);
      return JournalWriting.write(plan, false);
    }
    const row = loaded.page;
    if (loaded.checkpoint.epoch !== epoch || loaded.checkpoint.cleanSeq === null || loaded.checkpoint.cleanSeq < seq || row === null) return Decision.unchanged(false);
    let plan = new Plan();
    if (pending.touched.length) {
      const confirmed = Page.decode(Fields.record(row)).document;
      const doc = new PageDocument({
        body: pending.touched.includes('body') ? PendingClaim.reconcileBody(confirmed.body, pending.base.body, pending.latest.body) : confirmed.body,
        mood: pending.touched.includes('mood') ? pending.latest.mood : confirmed.mood,
        energy: pending.touched.includes('energy') ? pending.latest.energy : confirmed.energy,
        source: pending.touched.includes('source') ? pending.latest.source : confirmed.source,
      });
      JournalRules.check(doc);
      const stamp = JournalWriting.stamp(loaded, row.f?.documentStamp?.[0] ?? null);
      plan = Plan.running(new SavePageCommand({ day: this.day, ...doc.fields(), stamp }), [JournalWriting.prediction(this.day, doc, stamp)]);
      plan.device('contentClock', ContentClock.pair(stamp));
    }
    JournalWriting.retire(pending.retirements, plan, loaded.moment);
    plan.device(pending.key, null);
    return JournalWriting.write(plan, true);
  }
}

export class RetireJournalInvitation {
  scope = JOURNAL_SCOPE;
  refusals = JournalRefusals;

  /** @param {{ field: string }} input */
  constructor({ field }) { this.field = field; }
  /** @param {Reader} read */
  load(read) { return new JournalWriteState(read, read.moment.today); }
  /** @param {JournalWriteState} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    if (!STATE_FIELDS.includes(this.field)) throw new Violation('journalState', new Path(this.field), { kind: 'custom', custom: 'unknownState' });
    const plan = new Plan();
    const pending = loaded.pending.find((claim) => claim.day.text === loaded.moment.today.text);
    if (pending) {
      pending.retirements[this.field] = 'retired';
      plan.device(pending.key, pending.json);
    } else JournalWriting.retire({ [this.field]: 'retired' }, plan, loaded.moment);
    return JournalWriting.write(plan, null);
  }
}

export const JournalWriting = Object.freeze({
  /** @template T @param {Plan} plan @param {T} result */
  write(plan, result) {
    plan.deviceWrites.sort((a, b) => compareText(a.key, b.key));
    return Decision.write(plan, result);
  },
  /** @param {Record<string, Json>} fields @param {Plan} plan @param {Moment} moment */
  retire(fields, plan, moment) {
    const names = Object.keys(fields);
    if (!names.length) return;
    for (const name of names) if (!STATE_FIELDS.includes(name)) throw new Violation('journalState', new Path(name), { kind: 'custom', custom: 'unknownState' });
    const state = JournalState.decode(Fields.values(JournalState.type, 'journalState', fields));
    plan.create(new Valid(state, moment, names), { fields: names });
  },
  /** @param {LocalDay} day @param {PageDocument} doc @param {Json | null} [stamp] */
  prediction(day, doc, stamp = null) {
    const { body, ...values } = doc.fields();
    return Prediction.write(Id.ofDay(day, Page), stamp === null ? values : { ...values, documentStamp: stamp }, { body });
  },
  /** @param {{ day: DayInput, document: PageDocument | DocumentFields, claimId: string, retirements?: Record<string, Json> }} input @param {Moment} [moment] */
  claimPlan({ day, document: doc, claimId, retirements = {} }, moment) {
    const pending = new PendingClaim({ day, claimId, document: doc, retirements });
    const plan = Plan.running(new ClaimPageCommand({ day: pending.day, ...pending.base.fields(), claimId }), [JournalWriting.prediction(pending.day, pending.base)]);
    plan.device(pending.key, pending.json);
    if (Object.keys(retirements).length) {
      if (moment === undefined) throw new TypeError('journal retirement needs the commit moment');
      JournalWriting.retire(retirements, plan, moment);
    }
    return plan;
  },
  /** @param {JournalWriteState} loaded @param {Json | null} observed */
  stamp(loaded, observed) {
    try { return ContentClock.advance({ clock: loaded.clock, observed, now: loaded.moment.now.ms, actor: loaded.actor }); }
    catch { throw new Violation('journal.contentClock', new Path('stamp'), { kind: 'custom', custom: 'exhausted' }); }
  },
  /** @param {string} product @param {Record<string, Json>} rows */
  pendingWork(product, rows) {
    if (product !== 'journal') return [];
    return Object.entries(rows).filter(([key, value]) => {
      if (key === EditorDraft.key || key.startsWith(EditorDraft.recoveryPrefix)) return true;
      if (!key.startsWith('pendingClaim:')) return false;
      const pending = PendingClaim.fromJSON(value);
      return pending.touched.length > 0 || Object.keys(pending.retirements).length > 0;
    }).map(([key]) => key).sort(compareText);
  },
  reconcileBody: PendingClaim.reconcileBody,
  claimBody,
});
