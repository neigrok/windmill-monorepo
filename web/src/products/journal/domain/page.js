// @ts-check

import { EntityType, Fields, Id, compareText, sameJson } from '../../../platform/domain-kit/entities.js';
import { LocalDay } from '../../../platform/domain-kit/time.js';
import { Check } from '../../../platform/domain-kit/validation.js';
import { ChoiceSpec, Path } from '../../../platform/domain-kit/values.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {{ body: string, mood: number | null, energy: number | null, source: string }} DocumentFields */
/** @typedef {{ placeholder?: string, privacyLine?: string, firstPage?: string, scales?: string }} StateFields */

export const JOURNAL_SCOPE = 'self/journal';
export const EDITOR_DRAFT_KEY = 'pendingClaim:__editorDraft__';
export const STATE_FIELDS = Object.freeze(['placeholder', 'privacyLine', 'firstPage', 'scales']);

export class PageDocument {
  /** @param {Partial<DocumentFields>} [fields] */
  constructor({ body = '', mood = null, energy = null, source = 'typed' } = {}) {
    this.body = body;
    this.mood = mood;
    this.energy = energy;
    this.source = source;
    Object.freeze(this);
  }

  get isWritten() { return this.body !== '' || this.mood !== null || this.energy !== null; }

  /** @returns {DocumentFields} */
  fields() { return { body: this.body, mood: this.mood, energy: this.energy, source: this.source }; }

  /** @param {PageDocument} other */
  equals(other) { return this.body === other.body && this.mood === other.mood && this.energy === other.energy && this.source === other.source; }

  /** @param {Json} json */
  static fromJSON(json) {
    const fields = Fields.object(json, 'page');
    for (const name of ['body', 'mood', 'energy', 'source']) {
      if (!Object.hasOwn(fields.values, name) || fields.values[name] === undefined) throw fields.failure(name, 'absent');
    }
    return new PageDocument({ body: fields.string('body'), mood: fields.optionalInt('mood'),
      energy: fields.optionalInt('energy'), source: fields.string('source') });
  }
}

export class PageValue {
  /** @param {Id<PageValue>} id @param {PageDocument} doc @param {Json} documentStamp */
  constructor(id, doc, documentStamp) {
    this.id = id;
    this.document = doc;
    this.documentStamp = documentStamp;
    Object.freeze(this);
  }
}

/** @type {EntityType<PageValue>} */
export const Page = new EntityType({
  type: 'page', scope: JOURNAL_SCOPE,
  decode: (fields) => new PageValue(new Id(fields.id, Page), new PageDocument({ body: fields.text('body'),
    mood: fields.optionalInt('mood'), energy: fields.optionalInt('energy'), source: fields.string('source', 'typed') }),
  fields.json('documentStamp') ?? { ms: 0, counter: 0, actor: '' }),
});

export const JournalStateRules = Object.freeze(STATE_FIELDS.map((name) => new ChoiceSpec(`journalState.${name}`, ['pending', 'retired'])));

export class JournalStateValue {
  /** @param {StateFields} [fields] */
  constructor({ placeholder = 'pending', privacyLine = 'pending', firstPage = 'pending', scales = 'pending' } = {}) {
    this.id = new Id('journalState', JournalState);
    this.placeholder = placeholder;
    this.privacyLine = privacyLine;
    this.firstPage = firstPage;
    this.scales = scales;
    Object.freeze(this);
  }

  fields() { return { placeholder: this.placeholder, privacyLine: this.privacyLine, firstPage: this.firstPage, scales: this.scales }; }
  get scaleInvitationDue() { return this.firstPage === 'retired' && this.scales === 'pending'; }
  get keepDue() { return this.firstPage === 'retired' && this.scales === 'retired'; }
}

/** @type {EntityType<JournalStateValue>} */
export const JournalState = new EntityType({
  type: 'journalState', scope: JOURNAL_SCOPE,
  decode: (fields) => new JournalStateValue(Object.fromEntries(STATE_FIELDS.map((name) => [name, fields.string(name, 'pending')]))),
  checks: JournalStateRules.map((spec) => {
    const name = spec.path.slice('journalState.'.length);
    return new Check(name, (value) => {
      spec.apply(/** @type {Record<string, string>} */ (value.fields())[name] ?? '', new Path(name));
      return value;
    });
  }),
});

/** @typedef {{ day: LocalDay, document: PageDocument, documentStamp: Json, backup: 'savedHere' | 'pending' | 'backedUp' | 'refused' }} JournalDay */

export class JournalRoom {
  /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
  constructor(read) {
    const complete = read.firstPullComplete();
    this.isAnonymous = read.isAnonymous;
    this.firstRunKnown = this.isAnonymous || complete;
    this.stance = read.repository(Page).all('stored').length ? 'holding' : this.firstRunKnown ? 'empty' : 'unknown';
    const state = (read.repository(JournalState).find(new Id('journalState', JournalState), 'drawn') ?? new JournalStateValue()).fields();
    /** @type {Map<string, JournalDay>} */
    const byDay = new Map();
    const commands = read.commands();
    for (const row of read.views.drawn.values()) {
      if (row.t !== Page.type) continue;
      const page = Page.decode(Fields.record(row));
      const day = page.id.day;
      if (day === null) continue;
      const confirmed = read.confirmed(Page, page.id);
      const queued = commands.some(({ command }) => command.args.day === day.text);
      const clean = complete && !queued && confirmed !== null && sameJson(Fields.record(row).values, Fields.record(confirmed).values);
      byDay.set(day.text, { day, document: page.document, documentStamp: page.documentStamp,
        backup: this.isAnonymous ? 'savedHere' : clean ? 'backedUp' : 'pending' });
    }
    const pendingDays = new Set();
    for (const [key, json] of Object.entries(read.devices('pendingClaim:')).sort(([a], [b]) => compareText(a, b))) {
      if (key === EDITOR_DRAFT_KEY) continue;
      const pending = Fields.object(json, 'pendingClaim');
      const day = LocalDay.parse(pending.string('day'));
      if (day === null) throw pending.failure('day', 'not a Gregorian day');
      if (!pendingDays.has(day.text)) {
        byDay.set(day.text, { day, document: PageDocument.fromJSON(pending.present('latest')),
          documentStamp: byDay.get(day.text)?.documentStamp ?? { ms: 0, counter: 0, actor: '' },
          backup: pending.isAbsent('refusal') ? 'savedHere' : 'refused' });
        pendingDays.add(day.text);
      }
      const retired = Fields.object(pending.present('retirements'), 'pendingClaim').values;
      for (const name of STATE_FIELDS) if (retired[name] === 'retired') /** @type {Record<string, string>} */ (state)[name] = 'retired';
    }
    this.state = new JournalStateValue(state);
    this.pages = Object.freeze([...byDay.values()].sort((a, b) => LocalDay.compare(a.day, b.day)));
    this.days = Object.freeze(this.pages.filter((page) => page.document.isWritten));
    Object.freeze(this);
  }

  get scaleInvitationDue() { return this.firstRunKnown && this.state.scaleInvitationDue; }
  get keepDue() { return this.isAnonymous && this.firstRunKnown && this.state.keepDue; }
}
