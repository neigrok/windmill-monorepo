// @ts-check

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
import { Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { LocalDay } from '../../../platform/domain-kit/time.js';
import { Violation } from '../../../platform/domain-kit/values.js';
import { compareDocumentStamps, isDocumentStamp } from '../../../platform/sync/core/content.js';
import { hashText } from '../../../platform/sync/core/encoding.js';
import { JcsError, jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { JOURNAL_SCOPE, JournalState, JournalStateValue, PageDocument, STATE_FIELDS } from './page.js';
import { JournalRefusals } from './journalRules.js';
import { EditorDraft, JournalWriteState, JournalWriting } from './writing.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/acts.js').ActReader} ActReader */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {{ ms: number, counter: number, actor: string }} DocumentStamp */
/** @typedef {CarryPage | KeepAsDraft | RetireFirstRun | RecordCarry} CarryPart */
// One act of a carry or a restore: the parts the runner composes, and the pages they write.
/** @typedef {{ pages: OldPage[], parts: CarryPart[] }} CarryAct */
// The pages a store gives up, by digest: carried, restored or discarded.
/** @typedef {{ has(digest: string): boolean }} Settled */

// web-device-parity §5: what the journal's bundle before the engine kept in this browser's storage, one store a key,
// read as pages, and the actions that carry them into the replica. Only a browser that ran that bundle holds its
// stores, so these rules are the web's alone.

// A store's key names whose pages it keeps: those written signed out (`.anon`), an account's (`.u.<id>`), or pages
// that bundle could not attribute (`.unclaimed`, the unscoped store of its first version, and the unattributed pages the
// engine's device metadata once held, returned one page a key). The first version's keys lack `v2.`.
const STORE_KEY = /^wm\.journal\.(?:v2\.)?pages(?:\.(anon|unclaimed(?:\.[0-9a-f]{16})?|u\.(.+)))?$/;

// The first version's one store, kept before it scoped pages to an account: beside the writes it owed, it cached the
// account's own pages, as an account's store does.
const FIRST_UNSCOPED = 'wm.journal.pages';

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

  get name() { return this.kind === 'account' ? `u.${this.account}` : this.kind; }
}

// One page a store kept: its day and words on the engine's scales, the stamp it was last written with, whether the
// browser owed it to the account (`owed`) and had read the account's answer for its day (`read`), whether it is only a
// copy of the account's own page, which the engine's pull brings (`copy`), and its day and words named (`digest`): how
// the ledger records it, and its claim's id, so writing it twice writes it once.
export class OldPage {
  /** @param {{ day: LocalDay, document: PageDocument, stamp: DocumentStamp, owed: boolean, read: boolean, copy: boolean, digest: string }} page */
  constructor({ day, document: doc, stamp, owed, read, copy, digest }) {
    this.day = day;
    this.document = doc;
    this.stamp = stamp;
    this.owed = owed;
    this.read = read;
    this.copy = copy;
    this.digest = digest;
    Object.freeze(this);
  }

  // One entry of a store, `first` where the store is of the first version and `caches` where its pages the browser did not
  // owe are copies of the account's, or null where it does not read as a page: no page, no calendar day, a stamp that does
  // not read, or words no digest can name (a lone surrogate).
  /** @param {string} day @param {any} entry @param {{ first: boolean, caches: boolean }} store */
  static read(day, entry, { first, caches }) {
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
    let digest;
    try { digest = hashText(jcs([parsed.text, words.fields()])); }
    catch (error) {
      if (error instanceof JcsError) return null;
      throw error;
    }
    const owed = Boolean(entry.needsPush);
    return new OldPage({ day: parsed, document: words, stamp, owed, read: Boolean(entry.read), copy: caches && !owed, digest });
  }

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

// One store: its key, the bytes it held as read, its seat, its entries as they parsed (null where its bytes are no JSON
// object at all) and those of them that read as pages. An entry that does not read stays as it is.
export class OldStore {
  /** @param {{ key: string, raw: string, seat: Seat, entries: Record<string, Json> | null, pages: OldPage[] }} store */
  constructor({ key, raw, seat, entries, pages }) {
    this.key = key;
    this.raw = raw;
    this.seat = seat;
    this.entries = entries;
    this.pages = Object.freeze([...pages]);
    Object.freeze(this);
  }

  // The store a key holds, or null for a key that is no journal store's. An account's store, and the first version's
  // unscoped one, cached the account's own pages beside the writes the browser owed it.
  /** @param {string} key @param {string} raw */
  static read(key, raw) {
    const seat = Seat.ofKey(key);
    if (seat === null) return null;
    let entries;
    try { entries = JSON.parse(raw); } catch { entries = null; }
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return new OldStore({ key, raw, seat, entries: null, pages: [] });
    const first = !key.startsWith('wm.journal.v2.');
    const caches = seat.kind === 'account' || key === FIRST_UNSCOPED;
    const pages = Object.entries(entries).sort(([a], [b]) => compareText(a, b))
      .flatMap(([day, entry]) => [OldPage.read(day, entry, { first, caches })].filter((page) => page !== null));
    return new OldStore({ key, raw, seat, entries, pages });
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
  get unreadable() { return this.entries === null ? 1 : Object.keys(this.entries).length - this.pages.length; }

  // What is left of the store once it gives up its pages `done` names and its copies of the account's pages: nothing, or
  // its other entries, those that do not read among them, as they were; the store as it is where it gives up nothing or
  // its bytes do not read. Answers the pages it gives up.
  /** @param {Settled} done @returns {{ kind: 'keep' } | { kind: 'forget', gone: OldPage[] } | { kind: 'rewrite', raw: string, gone: OldPage[] }} */
  rest(done) {
    if (this.entries === null) return { kind: 'keep' };
    const gone = this.pages.filter((page) => page.copy || done.has(page.digest));
    const days = new Set(gone.map((page) => page.day.text));
    const left = Object.entries(this.entries).filter(([day]) => !days.has(day));
    if (left.length === 0) return { kind: 'forget', gone };
    if (gone.length === 0) return { kind: 'keep' };
    return { kind: 'rewrite', raw: JSON.stringify(Object.fromEntries(left)), gone };
  }
}

// One seat's pages, a day each: the page the bundle kept of the day across the seat's stores (`OldPage.isPreferredTo`,
// the later store by key winning a tie), and each other page of the day with other words, kept for the person to
// recover. A copy of the account's own page takes no part.
export class SeatPages {
  /** @param {Seat} seat @param {readonly OldStore[]} stores every store read, of whichever seat */
  constructor(seat, stores) {
    this.seat = seat;
    this.stores = Object.freeze(stores.filter((store) => store.seat.equals(seat)).sort((a, b) => compareText(a.key, b.key)));
    /** @type {Map<string, { kept: OldPage, others: OldPage[] }>} */
    const days = new Map();
    for (const store of this.stores) {
      for (const page of store.pages.filter((each) => !each.copy)) {
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
  // first run's invitations where a page has words, and each act records every page of it in the ledger last, written
  // or found held, so the ledger and what it records land together.
  /** @param {number} size @returns {CarryAct[]} */
  carrying(size) {
    const parts = this.days.flatMap(({ kept, others }) => [new CarryPage(kept, this.seat, 'recover'),
      ...others.map((page) => new KeepAsDraft(page, this.seat))]);
    const written = parts.some((part) => part.page.document.isWritten);
    return chunks(parts, size).map((chunk, index) => {
      const pages = chunk.map((part) => part.page);
      const retire = index === 0 && written ? [new RetireFirstRun()] : [];
      return { pages, parts: [...chunk, ...retire, new RecordCarry(this.seat, pages.map((page) => page.digest))] };
    });
  }

  // The acts that restore the seat's pages into an account's replica, `size` pages an act: a page kept for its day is
  // claimed, joined onto the account's page of the day as a claim is, and each other page of the day is kept as a draft
  // to recover. A restore keeps no ledger: each act's pages leave their stores once it is written.
  /** @param {number} size @returns {CarryAct[]} */
  restoring(size) {
    const parts = this.days.flatMap(({ kept, others }) => [new CarryPage(kept, this.seat, 'join'),
      ...others.map((page) => new KeepAsDraft(page, this.seat))]);
    return chunks(parts, size).map((chunk) => ({ pages: chunk.map((part) => part.page), parts: chunk }));
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

// The ledger of what the carry took of one seat's pages into a replica, the replica's device row `carry:<seat>`, written
// in the act that takes them: each page of the act by its digest, whether the act wrote it or found it held. A page
// leaves its store only once the ledger records it (as roadmap-on-the-engine §8.2's INV-4 holds for roadmap). The row
// never leaves the device.
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

// The pages of an act recorded in their seat's ledger: the last part of every act that carries.
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
