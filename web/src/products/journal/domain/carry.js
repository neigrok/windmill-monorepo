// @ts-check

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
import { Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { LocalDay } from '../../../platform/domain-kit/time.js';
import { Violation } from '../../../platform/domain-kit/values.js';
import { compareDocumentStamps, isDocumentStamp } from '../../../platform/sync/core/content.js';
import { hashText } from '../../../platform/sync/core/encoding.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { JOURNAL_SCOPE, JournalState, JournalStateValue, PageDocument, STATE_FIELDS } from './page.js';
import { JournalRefusals } from './journalRules.js';
import { EditorDraft, JournalWriteState, JournalWriting } from './writing.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/acts.js').ActReader} ActReader */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {{ ms: number, counter: number, actor: string }} DocumentStamp */
/** @typedef {CarryPage | KeepAsDraft | RetireFirstRun | RecordCarry} CarryPart */

// web-device-parity §5: what the journal's bundle before the engine kept in this browser's storage, one store a key,
// read as pages, and the actions that carry them into the replica. Only a browser that ran that bundle holds its
// stores, so these rules are the web's alone.

// A store's key names whose pages it keeps: those written signed out (`.anon`), an account's (`.u.<id>`), or pages
// that bundle could not attribute (`.unclaimed`, the unscoped store of its first version, and the unattributed pages the
// engine's device metadata once held, returned one page a key). The first version's keys lack `v2.`.
const STORE_KEY = /^wm\.journal\.(?:v2\.)?pages(?:\.(anon|unclaimed(?:\.[0-9a-f]{16})?|u\.(.+)))?$/;

// The first version kept mood on 1–5 and energy on 1–3; the engine keeps both on 0–10.
const FIRST_ENERGY = /** @type {Readonly<Record<number, number>>} */ (Object.freeze({ 1: 2, 2: 5, 3: 8 }));

/** @param {Plan} plan @param {unknown} result */
const writeIn = (plan, result) => ActDecision.write(new ActPlan([new ScopedPlan(JOURNAL_SCOPE, plan)]), result);

// Whose pages a store keeps, and so the replica they go to.
export class Seat {
  /** @param {'anon' | 'account' | 'unclaimed'} kind @param {string | null} [account] */
  constructor(kind, account = null) {
    this.kind = kind;
    this.account = account;
    Object.freeze(this);
  }

  static anon = new Seat('anon');
  static unclaimed = new Seat('unclaimed');

  /** @param {string} account */
  static of(account) { return new Seat('account', account); }

  // The seat whose pages go into a replica: its account's where it is bound, the signed-out pages' where it is
  // anonymous, none where it is dormant.
  /** @param {{ state: string, account?: string | null }} replica the replica's meta */
  static ofReplica({ state, account = null }) {
    if (state === 'bound' && account !== null) return Seat.of(account);
    return state === 'anon' ? Seat.anon : null;
  }

  // The seat a store's key names, or null for a key that is no journal store's.
  /** @param {string} key */
  static ofKey(key) {
    const match = STORE_KEY.exec(key);
    if (match === null) return null;
    const [, suffix, account] = match;
    if (account !== undefined) return Seat.of(account);
    return suffix === 'anon' ? Seat.anon : Seat.unclaimed;
  }

  /** @param {Seat} other */
  equals(other) { return this.kind === other.kind && this.account === other.account; }

  // Every page of the signed-out and the unattributed stores is the person's own writing; of an account's, only those
  // the browser owed the account, the rest being copies of its pages, which the engine's pull brings.
  /** @param {OldPage} page */
  carries(page) { return this.kind !== 'account' || page.owed; }

  get name() { return this.kind === 'account' ? `u.${this.account}` : this.kind; }
}

// One page a store kept: its day and words on the engine's scales, the stamp it was last written with, whether the
// browser owed it to the account (`owed`) and had read the account's answer for its day (`read`).
export class OldPage {
  /** @param {{ day: LocalDay, document: PageDocument, stamp: DocumentStamp, owed: boolean, read: boolean }} page */
  constructor({ day, document: doc, stamp, owed, read }) {
    this.day = day;
    this.document = doc;
    this.stamp = stamp;
    this.owed = owed;
    this.read = read;
    Object.freeze(this);
  }

  // One entry of a store, `first` where the store is of the first version, or null where it does not read as a page.
  /** @param {string} day @param {any} entry @param {boolean} first */
  static read(day, entry, first) {
    const parsed = LocalDay.parse(day);
    const raw = entry?.page;
    if (parsed === null || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const [ms, counter, ...actor] = String(raw.stamp || '0:0:').split(':');
    const stamp = { ms: Number(ms), counter: Number(counter), actor: actor.join(':') };
    if (!isDocumentStamp(stamp)) return null;
    const score = (/** @type {unknown} */ value) => (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 10 ? Number(value) : null);
    const mood = score(raw.mood);
    const energy = score(raw.energy);
    const words = new PageDocument({ body: typeof raw.body === 'string' ? raw.body : '', source: raw.source === 'spoken' ? 'spoken' : 'typed',
      mood: first ? (mood !== null && mood >= 1 && mood <= 5 ? mood * 2 - 1 : null) : mood,
      energy: first ? (energy === null ? null : FIRST_ENERGY[energy] ?? null) : energy });
    return new OldPage({ day: parsed, document: words, stamp, owed: Boolean(entry.needsPush), read: Boolean(entry.read) });
  }

  // The page's day and words, named: how the ledger records it, and its claim's id, so writing it twice writes it once.
  get digest() { return hashText(jcs([this.day.text, this.document.fields()])); }
  get claimId() { return `carry-${this.digest}`; }
  get draft() { return new EditorDraft({ day: this.day, document: this.document }); }

  // Whether the bundle kept this page over `held`, a page of its day read before it: an owed page over a copy of the
  // account's, a page owed but never read over one read, then the newer stamp, this one on a tie.
  /** @param {OldPage} held */
  isPreferredTo(held) {
    if (this.owed !== held.owed) return this.owed;
    const unread = this.owed && !this.read;
    if (unread !== (held.owed && !held.read)) return unread;
    return compareDocumentStamps(this.stamp, held.stamp) >= 0;
  }
}

// One store: its key, the bytes it held as read, its seat, its pages, and its entries that do not read as pages, which
// stay as they are (`unread`, null where its bytes are no JSON object at all).
export class OldStore {
  /** @param {{ key: string, raw: string, seat: Seat, pages: OldPage[], unread: Record<string, Json> | null }} store */
  constructor({ key, raw, seat, pages, unread }) {
    this.key = key;
    this.raw = raw;
    this.seat = seat;
    this.pages = Object.freeze([...pages]);
    this.unread = unread;
    Object.freeze(this);
  }

  // The store a key holds, or null for a key that is no journal store's.
  /** @param {string} key @param {string} raw */
  static read(key, raw) {
    const seat = Seat.ofKey(key);
    if (seat === null) return null;
    let entries;
    try { entries = JSON.parse(raw); } catch { entries = null; }
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return new OldStore({ key, raw, seat, pages: [], unread: null });
    const first = !key.startsWith('wm.journal.v2.');
    /** @type {OldPage[]} */
    const pages = [];
    /** @type {Record<string, Json>} */
    const unread = {};
    for (const [day, entry] of Object.entries(entries).sort(([a], [b]) => compareText(a, b))) {
      const page = OldPage.read(day, entry, first);
      if (page === null) unread[day] = entry;
      else pages.push(page);
    }
    return new OldStore({ key, raw, seat, pages, unread });
  }

  // A page the engine's device metadata once held unattributed, as a store of its own, under a key its day and words
  // name. One the metadata held as another page of its day (`recovered`) is held as not owed, so the page it lost to is
  // kept again first.
  /** @param {{ day: string, body: string, mood: number | null, energy: number | null, source: string, stamp?: string, recovered?: boolean }} page */
  static returned({ day, body, mood, energy, source, stamp = '', recovered = false }) {
    const page = { day, body, mood, energy, source, stamp };
    const digest = hashText(jcs([day, { body, mood, energy, source }])).slice(0, 16);
    return { key: `wm.journal.v2.pages.unclaimed.${digest}`, raw: JSON.stringify({ [day]: { page, needsPush: !recovered, read: false } }) };
  }

  // Whether a key holds a page `returned` put back.
  /** @param {string} key */
  static isReturned(key) { return /^wm\.journal\.v2\.pages\.unclaimed\.[0-9a-f]{16}$/.test(key); }

  // How many of its entries do not read as pages; all of them count as one where its bytes do not read at all.
  get unreadable() { return this.unread === null ? 1 : Object.keys(this.unread).length; }

  // What is left of the store once every page `done` names is carried: nothing, its entries that do not read, or the
  // store as it is while a page waits or its bytes do not read.
  /** @param {(page: OldPage) => boolean} done @returns {{ kind: 'forget' } | { kind: 'rewrite', raw: string } | { kind: 'keep' }} */
  rest(done) {
    if (this.unread === null || !this.pages.every(done)) return { kind: 'keep' };
    if (Object.keys(this.unread).length === 0) return { kind: 'forget' };
    const raw = JSON.stringify(this.unread);
    return raw === this.raw ? { kind: 'keep' } : { kind: 'rewrite', raw };
  }
}

// One seat's pages, a day each: the page the bundle kept of the day across the seat's stores (`OldPage.isPreferredTo`,
// the later store by key winning a tie), and each other page of the day with other words, kept for the person to
// recover. A page the seat does not carry takes no part.
export class SeatPages {
  /** @param {Seat} seat @param {readonly OldStore[]} stores every store read, of whichever seat */
  constructor(seat, stores) {
    this.seat = seat;
    this.stores = Object.freeze(stores.filter((store) => store.seat.equals(seat)).sort((a, b) => compareText(a.key, b.key)));
    /** @type {Map<string, { kept: OldPage, others: OldPage[] }>} */
    const days = new Map();
    for (const store of this.stores) {
      for (const page of store.pages.filter((each) => seat.carries(each))) {
        const held = days.get(page.day.text);
        if (held === undefined) days.set(page.day.text, { kept: page, others: [] });
        else if (page.isPreferredTo(held.kept)) days.set(page.day.text, { kept: page, others: [...held.others, held.kept] });
        else held.others.push(page);
      }
    }
    this.days = Object.freeze([...days.values()].sort((a, b) => LocalDay.compare(a.kept.day, b.kept.day)).map(({ kept, others }) => {
      const distinct = new Map(others.filter((page) => !page.document.equals(kept.document)).map((page) => [page.digest, page]));
      return Object.freeze({ kept, others: Object.freeze([...distinct.values()]) });
    }));
  }

  // Every page the seat carries: each day's kept page, then its others.
  get pages() { return this.days.flatMap(({ kept, others }) => [kept, ...others]); }

  // The acts that carry the seat's pages into its replica, `size` pages an act: a page kept for its day is claimed
  // where this browser holds no work of the day and kept as a draft to recover where it does, each other page of the day
  // is kept as a draft to recover, a page the seat's ledger records is not written again, the first act also retires the
  // first run's invitations where a page has words, and each act records its pages in the ledger last, so the ledger
  // and what it records land together.
  /** @param {number} size @returns {CarryPart[][]} */
  carrying(size) {
    const parts = this.days.flatMap(({ kept, others }) => [new CarryPage(kept, this.seat, 'recover'),
      ...others.map((page) => new KeepAsDraft(page, this.seat))]);
    const written = parts.some((part) => part.page.document.isWritten);
    return chunks(parts, size).map((chunk, index) => [...chunk, ...(index === 0 && written ? [new RetireFirstRun()] : []),
      new RecordCarry(this.seat, chunk.map((part) => part.page.digest))]);
  }

  // The acts that restore the seat's pages into an account's replica, `size` pages an act: a page kept for its day is
  // claimed, joined onto the account's page of the day as a claim is, and each other page of the day is kept as a draft
  // to recover. A restore keeps no ledger: the stores go once its acts are written.
  /** @param {number} size @returns {CarryPart[][]} */
  restoring(size) {
    return chunks(this.days.flatMap(({ kept, others }) => [new CarryPage(kept, this.seat, 'join'),
      ...others.map((page) => new KeepAsDraft(page, this.seat))]), size);
  }
}

/** @template T @param {T[]} items @param {number} size */
function chunks(items, size) {
  /** @type {T[][]} */
  const all = [];
  for (let start = 0; start < items.length; start += size) all.push(items.slice(start, start + size));
  return all;
}

// What the replica holds of an old page and its day: whether the seat's ledger records the page, the page's own claim
// (`claimed`), its draft to recover (`recovered`), whether this browser holds work of the day (`dayHeld`: a queued write
// of it, a claim of it or the editor's draft of it), whether the account's page of the day has been pulled
// (`accountPage`), and whether the editor holds a draft of any day.
class HeldDay {
  /** @param {Reader} read @param {OldPage} page @param {Seat} seat */
  constructor(read, page, seat) {
    const state = new JournalWriteState(read, page.day);
    const day = page.day.text;
    this.recorded = CarryLedger.read(read, seat).has(page.digest);
    this.claimed = state.pending.some((claim) => claim.claimId === page.claimId)
      || state.commands.some(({ command }) => command.args.claimId === page.claimId);
    this.recovered = read.device(page.draft.recoveryKey) !== null;
    this.dayHeld = state.hasEditorDraft || state.pending.some((claim) => claim.day.text === day)
      || state.commands.some(({ command }) => command.args.day === day);
    this.accountPage = state.page !== null;
    this.editorDraft = read.device(EditorDraft.key) !== null;
    Object.freeze(this);
  }
}

// One old page of `seat` written into the replica as a claim under the id its day and words derive (`OldPage.claimId`),
// so a page the seat's ledger records, or whose claim the replica holds, is not written again. The claim joins the
// account's page of the day as every claim does, whether or not the replica has pulled it yet. Where this browser
// already holds work of the day, the carry keeps the page as a draft to recover (`recover`), so a later save of the day
// cannot supersede it, and a restore joins it onto the day as a claim does (`join`). Where the claim's bounds refuse the
// words, they stay for the person to correct: as the editor's draft where the editor holds none and the replica holds
// nothing of the day, as a draft to recover otherwise. Answers how the page went: `claimed`, `drafted`, `recovered`, or
// `held` where the replica held it already.
export class CarryPage {
  refusals = JournalRefusals;

  /** @param {OldPage} page @param {Seat} seat @param {'recover' | 'join'} whereHeld */
  constructor(page, seat, whereHeld) {
    this.page = page;
    this.seat = seat;
    this.whereHeld = whereHeld;
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(JOURNAL_SCOPE, (journal) => new HeldDay(journal, this.page, this.seat)); }

  /** @param {HeldDay} held */
  decide(held) {
    if (held.recorded || held.claimed || held.recovered) return ActDecision.unchanged('held');
    const { draft } = this.page;
    const recover = () => {
      const plan = new Plan();
      plan.device(draft.recoveryKey, draft.json);
      return writeIn(plan, 'recovered');
    };
    if (held.dayHeld && this.whereHeld === 'recover') return recover();
    try {
      return writeIn(JournalWriting.claimPlan({ day: this.page.day, document: this.page.document, claimId: this.page.claimId }), 'claimed');
    } catch (error) {
      if (!(error instanceof Violation)) throw error;
    }
    if (held.dayHeld || held.accountPage || held.editorDraft) return recover();
    const plan = new Plan();
    plan.device(EditorDraft.key, draft.json);
    return writeIn(plan, 'drafted');
  }
}

// An old page of `seat` of a day whose kept page has other words: a draft to recover, written once. Answers
// `recovered`, or `held` where the seat's ledger records the page or the replica holds the draft already.
export class KeepAsDraft {
  refusals = JournalRefusals;

  /** @param {OldPage} page @param {Seat} seat */
  constructor(page, seat) {
    this.page = page;
    this.seat = seat;
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(JOURNAL_SCOPE, (journal) => CarryLedger.read(journal, this.seat).has(this.page.digest)
      || journal.device(this.page.draft.recoveryKey) !== null);
  }

  /** @param {boolean} held */
  decide(held) {
    if (held) return ActDecision.unchanged('held');
    const { draft } = this.page;
    const plan = new Plan();
    plan.device(draft.recoveryKey, draft.json);
    return writeIn(plan, 'recovered');
  }
}

// Whoever wrote pages before the engine has seen the first run: its invitations are retired with the pages carried.
export class RetireFirstRun {
  refusals = JournalRefusals;

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(JOURNAL_SCOPE, (journal) => ({ moment: journal.moment,
      state: journal.repository(JournalState).find(new Id('journalState', JournalState), 'drawn') ?? new JournalStateValue() }));
  }

  /** @param {{ moment: import('../../../platform/domain-kit/time.js').Moment, state: JournalStateValue }} loaded */
  decide({ moment, state }) {
    const fields = /** @type {Record<string, string>} */ (state.fields());
    const pending = STATE_FIELDS.filter((name) => fields[name] !== 'retired');
    if (pending.length === 0) return ActDecision.unchanged(null);
    const plan = new Plan();
    JournalWriting.retire(Object.fromEntries(pending.map((name) => [name, 'retired'])), plan, moment);
    return writeIn(plan, null);
  }
}

// The ledger of what the carry wrote of one seat's pages into a replica, the replica's device row `carry:<seat>`,
// written in the act that writes them: each page by its digest. A store goes only once the ledger records every page of
// it the seat carries (as roadmap-on-the-engine §8.2's INV-4 holds for roadmap). The row never leaves the device.
export class CarryLedger {
  /** @type {Set<string>} */
  #pages;

  /** @param {Iterable<string>} [pages] */
  constructor(pages = []) {
    this.#pages = new Set(pages);
    Object.freeze(this);
  }

  /** @param {Seat} seat */
  static key(seat) { return `carry:${hashText(seat.name).slice(0, 16)}`; }

  /** @param {Json | null} json */
  static of(json) {
    const pages = json !== null && typeof json === 'object' && !Array.isArray(json) ? json.pages : null;
    return new CarryLedger(Array.isArray(pages) ? pages.filter((page) => typeof page === 'string') : []);
  }

  // The ledger of `seat` as the replica a reader reads holds it.
  /** @param {Reader} read @param {Seat} seat */
  static read(read, seat) { return CarryLedger.of(read.device(CarryLedger.key(seat))); }

  /** @param {string} digest */
  has(digest) { return this.#pages.has(digest); }

  /** @param {Iterable<string>} digests */
  with(digests) { return new CarryLedger([...this.#pages, ...digests]); }

  get size() { return this.#pages.size; }
  get json() { return { pages: [...this.#pages].sort(compareText) }; }
}

// Pages written into the replica, recorded in their seat's ledger: the last part of every act that carries.
export class RecordCarry {
  refusals = JournalRefusals;

  /** @param {Seat} seat @param {string[]} digests */
  constructor(seat, digests) {
    this.seat = seat;
    this.digests = digests;
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(JOURNAL_SCOPE, (journal) => CarryLedger.read(journal, this.seat)); }

  /** @param {CarryLedger} held */
  decide(held) {
    const next = held.with(this.digests);
    if (next.size === held.size) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.device(CarryLedger.key(this.seat), next.json);
    return writeIn(plan, null);
  }
}
