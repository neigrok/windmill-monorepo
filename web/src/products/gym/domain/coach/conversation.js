// @ts-check
// A Coach conversation as the engine holds it (gym Coach §9): its records, the calls a turn ran, the receipt they
// derive, and the reads over its messages.

import { jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { lengthIn } from '../../../../../../packages/api-contract/sync/reference/core/values.js';
import { DecodeError, EntityType, Id, compareText } from '../../../../platform/domain-kit/entities.js';
import { Rule, RuleBook } from '../../../../platform/domain-kit/rules.js';
import { Instant } from '../../../../platform/domain-kit/time.js';
import { Check } from '../../../../platform/domain-kit/validation.js';
import { ChoiceSpec, CountSpec, Path, TextSpec, Violation } from '../../../../platform/domain-kit/values.js';
import { registry } from '../../../../platform/sync/schema.js';
import { Session, TrainingSet } from '../training.js';

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../platform/domain-kit/entities.js').RecordRef} RecordRef */
/** @typedef {'running' | 'interrupted' | 'completed' | 'declined' | 'failed' | 'stopped'} MessageState */

export const CoachRules = Object.freeze({
  maxQuestionBytes: 8_000,
  maxReceiptBytes: 16_384,
  maxCallsBytes: 32_768,
  maxResultBytes: 16_384,
  maxInputDepth: 32,
  question: 'message.question',
  receipt: 'message.receipt',
  calls: 'message.calls',
  title: new TextSpec('thread.title', { unit: 'bytes', min: 1, max: 8_000, trim: false, nfc: false }),
  role: new ChoiceSpec('message.role', ['lifter', 'coach']),
  replica: new TextSpec('message.replica', { unit: 'chars', min: 35, max: 35, trim: false, nfc: false }),
  text: new TextSpec('message.text', { unit: 'bytes', min: 0, max: 131_072, trim: false, nfc: false }),
  pictures: new CountSpec('message.pictures', { min: 0, max: 1 }),
  pictureId: new TextSpec('message.pictures.id', { unit: 'chars', min: 8, max: 64, trim: false, nfc: false }),
  // The registry's pattern for a picture's id, which its row key repeats: the spec measures it, this names its characters.
  pictureIdPattern: /^[A-Za-z0-9_-]{8,64}$/u,
  mediaType: new TextSpec('message.pictures.mediaType', { unit: 'bytes', min: 1, max: 255, trim: false, nfc: false }),
  /** @param {Json} json @param {number} max @param {string} rule @param {Path} at */
  within(json, max, rule, at) {
    const measured = jcsBytes(json).length;
    if (measured > max) throw new Violation(rule, at, { kind: 'tooLong', max, unit: 'bytes', measured });
  },
});

// The registry's rank: a terminal state beats running, and a writer's terminal state beats another device's interrupted.
export const MessageStates = Object.freeze({
  all: /** @type {readonly MessageState[]} */ (Object.freeze(['running', 'interrupted', 'completed', 'declined', 'failed', 'stopped'])),
  /** @param {MessageState} state */
  isTerminal: (state) => state !== 'running',
  /** @param {MessageState} state */
  isWritersTerminal: (state) => state !== 'running' && state !== 'interrupted',
});

export class CoachThreadValue {
  /** @param {Id<CoachThreadValue>} id @param {string} title */
  constructor(id, title) {
    this.id = id;
    this.title = title;
    Object.freeze(this);
  }

  fields() { return { title: this.title }; }
}

/** @type {EntityType<CoachThreadValue, string>} */
export const CoachThread = new EntityType({
  type: 'thread', scope: 'self/gym', heldRemoval: false,
  decode: (f) => new CoachThreadValue(new Id(f.id, CoachThread), f.string('title', '')),
  checks: [new Check('title', (thread) => new CoachThreadValue(thread.id, CoachRules.title.apply(thread.title, new Path('title'))))],
});

// A picture on a message: its id in the browser or on the phone that sent it when `localOnly` (gym Coach §9.3).
export class Picture {
  /** @param {string} id @param {string} mediaType @param {boolean} [localOnly] */
  constructor(id, mediaType, localOnly = false) {
    this.id = id;
    this.mediaType = mediaType;
    this.localOnly = localOnly;
    Object.freeze(this);
  }

  /** @returns {Json} */
  get json() { return { id: this.id, mediaType: this.mediaType, ...(this.localOnly ? { localOnly: true } : {}) }; }

  /** @param {Path} at */
  validated(at) {
    const id = CoachRules.pictureId.apply(this.id, at.plus('id'));
    if (!CoachRules.pictureIdPattern.test(id)) throw new Violation(CoachRules.pictureId.path, at.plus('id'), { kind: 'custom', custom: 'notAnId' });
    return new Picture(id, CoachRules.mediaType.apply(this.mediaType, at.plus('mediaType')), this.localOnly);
  }

  /** @param {import('../../../../platform/domain-kit/entities.js').Fields} f */
  static decode(f) { return new Picture(f.string('id'), f.string('mediaType'), f.bool('localOnly', false)); }
}

// How many log rows a read served, as a result states it and a receipt sums it.
export class ReadTally {
  constructor(sets = 0, sessions = 0, weeks = 0) {
    this.sets = sets;
    this.sessions = sessions;
    this.weeks = weeks;
    Object.freeze(this);
  }

  /** @returns {Json} */
  get json() { return { sets: this.sets, sessions: this.sessions, weeks: this.weeks }; }

  /** @param {ReadTally} other */
  plus(other) { return new ReadTally(this.sets + other.sets, this.sessions + other.sessions, this.weeks + other.weeks); }

  /** @param {import('../../../../platform/domain-kit/entities.js').Fields} f */
  static decode(f) { return new ReadTally(f.int('sets'), f.int('sessions'), f.int('weeks')); }
}

const WEEK_MS = 604_800_000;
const EPOCH_TO_MONDAY = 259_200_000;

/** @template T @param {readonly T[]} items @param {T} item @param {(a: T, b: T) => number} compare */
function holding(items, item, compare) {
  if (items.some((held) => compare(held, item) === 0)) return items;
  return [...items, item].sort(compare);
}

// The log rows a read handed to the model, by identity, and their weeks (Monday 00:00 UTC), each list in order and
// without repeats.
export class ReadServed {
  /** @param {readonly Id<any>[]} sessions @param {readonly Id<any>[]} sets @param {readonly number[]} weeks */
  constructor(sessions, sets, weeks) {
    this.sessions = Object.freeze([...sessions]);
    this.sets = Object.freeze([...sets]);
    this.weeks = Object.freeze([...weeks]);
    Object.freeze(this);
  }

  static none = new ReadServed([], [], []);

  /** @param {import('../training.js').SessionValue} session */
  sawSession(session) {
    return new ReadServed(holding(this.sessions, session.id, Id.compare), this.sets, this.weeks).sawWeek(ReadServed.week(session.startedAt));
  }

  /** @param {import('../training.js').TrainingSetValue} set */
  sawSet(set) {
    return new ReadServed(this.sessions, holding(this.sets, set.id, Id.compare), this.weeks).sawWeek(ReadServed.week(set.completedAt));
  }

  /** @param {number} week */
  sawWeek(week) { return new ReadServed(this.sessions, this.sets, holding(this.weeks, week, (a, b) => a - b)); }

  /** @param {ReadServed} other */
  saw(other) {
    return new ReadServed(other.sessions.reduce((held, id) => holding(held, id, Id.compare), this.sessions),
      other.sets.reduce((held, id) => holding(held, id, Id.compare), this.sets),
      other.weeks.reduce((held, week) => holding(held, week, (a, b) => a - b), this.weeks));
  }

  // The rows this read served that another did not.
  /** @param {ReadServed} held */
  without(held) {
    return new ReadServed(this.sessions.filter((id) => !held.sessions.some((other) => other.equals(id))),
      this.sets.filter((id) => !held.sets.some((other) => other.equals(id))), this.weeks.filter((week) => !held.weeks.includes(week)));
  }

  get isEmpty() { return this.sessions.length === 0 && this.sets.length === 0 && this.weeks.length === 0; }
  get tally() { return new ReadTally(this.sets.length, this.sessions.length, this.weeks.length); }

  /** @returns {Json} */
  get json() { return { sessions: this.sessions.map((id) => id.json), sets: this.sets.map((id) => id.json), weeks: [...this.weeks] }; }

  // The epoch was a Thursday: the instant moves three days forward, floors to a week, and moves back.
  /** @param {Instant} instant */
  static week(instant) {
    return Math.max(1, Math.floor((instant.ms + EPOCH_TO_MONDAY) / WEEK_MS) * WEEK_MS - EPOCH_TO_MONDAY);
  }

  /** @param {import('../../../../platform/domain-kit/entities.js').Fields} f */
  static decode(f) {
    /** @param {string} field */
    const items = (field) => {
      const value = f.json(field);
      if (!Array.isArray(value)) throw new DecodeError(CoachMessage.type, `calls.read.${field}`, 'absent');
      return value;
    };
    /** @param {string} field @param {import('../../../../platform/domain-kit/entities.js').EntityType<any>} type */
    const ids = (field, type) => items(field).map((item) => {
      if (typeof item !== 'string' && !Array.isArray(item)) throw new DecodeError(CoachMessage.type, `calls.read.${field}`, 'not an id');
      return new Id(item, type);
    });
    return new ReadServed(ids('sessions', Session), ids('sets', TrainingSet), items('weeks').map((week) => {
      if (!Number.isSafeInteger(week)) throw new DecodeError(CoachMessage.type, 'calls.read.weeks', 'not an integer');
      return /** @type {number} */ (week);
    }));
  }
}

// The codes a call the replica refused carries back (gym Coach §5, §6.4).
export const AbilityRefusals = Object.freeze({
  notOffered: 'not-offered',
  seatRequired: 'seat-required',
  invalidInput: 'invalid-input',
  invalidArguments: 'invalid-arguments',
  refused: 'refused',
  loadFloor: 'load-floor',
  resultTooLarge: 'result-too-large',
  volume: 'coach-turn-volume',
});

const ABILITY_CODES = /** @type {readonly string[]} */ (Object.freeze(Object.values(AbilityRefusals)));

// One ability call as the Coach message records it (gym Coach §4.3 step 2): its outcome `ok` or a refusal code, the
// records it created, and the log rows it read, by identity or, when the calls had no room, as counts alone.
export class AbilityCall {
  /**
   * @param {{ callId: string, name: string, input?: Json | null, outcome: string, created?: readonly RecordRef[],
   *   read?: ReadServed | ReadTally }} call
   */
  constructor({ callId, name, input = null, outcome, created = [], read = ReadServed.none }) {
    this.callId = callId;
    this.name = name;
    this.input = input;
    this.outcome = outcome;
    this.created = Object.freeze(created.map((ref) => Object.freeze({ t: ref.t, id: ref.id })));
    this.read = read;
    Object.freeze(this);
  }

  get isOk() { return this.outcome === 'ok'; }

  /** @param {Partial<ConstructorParameters<typeof AbilityCall>[0]>} changes */
  with(changes) {
    return new AbilityCall({ callId: this.callId, name: this.name, input: this.input, outcome: this.outcome, created: this.created, read: this.read, ...changes });
  }

  /** @returns {Json} */
  get json() {
    return { callId: this.callId, name: this.name, ...(this.input === null ? {} : { input: this.input }), outcome: this.outcome,
      created: this.created.map((ref) => ({ t: ref.t, id: ref.id })), read: this.read.json,
      ...(this.read instanceof ReadTally ? { readTruncated: true } : {}) };
  }

  /** @param {import('../../../../platform/domain-kit/entities.js').Fields} f */
  static decode(f) {
    const outcome = f.string('outcome');
    const created = f.json('created');
    if (!Array.isArray(created)) throw new DecodeError(CoachMessage.type, 'calls.created', 'absent');
    const refs = created.map((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item) || typeof item.t !== 'string'
        || (typeof item.id !== 'string' && !Array.isArray(item.id))) throw new DecodeError(CoachMessage.type, 'calls.created', 'not an id');
      return { t: item.t, id: /** @type {import('../../../../platform/domain-kit/entities.js').RecordID} */ (item.id) };
    });
    if (f.json('read') === undefined) throw new DecodeError(CoachMessage.type, 'calls.read', 'absent');
    const read = f.bool('readTruncated', false) ? f.value('read', ReadTally.decode) : f.value('read', ReadServed.decode);
    const input = f.json('input');
    return new AbilityCall({ callId: f.string('callId'), name: f.string('name'), input: input === undefined ? null : input,
      outcome: outcome === 'ok' || ABILITY_CODES.includes(outcome) ? outcome : AbilityRefusals.refused, created: refs, read });
  }

  // gym Coach §9.2: reads by identity across the calls, plus the calls held as counts (`truncated` then), and the ids
  // created; a refused call counts nothing.
  /** @param {readonly AbilityCall[]} calls @returns {Json} */
  static receipt(calls) {
    let served = ReadServed.none;
    let counted = new ReadTally();
    let truncated = false;
    /** @type {RecordRef[]} */
    const created = [];
    for (const call of calls.filter((each) => each.isOk)) {
      if (call.read instanceof ReadTally) { counted = counted.plus(call.read); truncated = true; }
      else served = served.saw(call.read);
      for (const ref of call.created) if (!created.some((held) => held.t === ref.t && compareText(String(held.id), String(ref.id)) === 0)) created.push(ref);
    }
    return { read: served.tally.plus(counted).json, results: created.map((ref) => ({ t: ref.t, id: ref.id })), ...(truncated ? { truncated: true } : {}) };
  }
}

/** @typedef {'lifter' | 'coach'} Role */

export class CoachMessageValue {
  /**
   * @param {{ id: Id<CoachMessageValue>, threadId: Id<CoachThreadValue>, role: Role, replica?: string | null, text?: string,
   *   state?: MessageState, truncated?: boolean, receipt?: Json | null, calls?: readonly AbilityCall[], pictures?: readonly Picture[], at: Instant }} message
   */
  constructor({ id, threadId, role, replica = null, text = '', state = 'running', truncated = false, receipt = null, calls = [], pictures = [], at }) {
    this.id = id;
    this.threadId = threadId;
    this.role = role;
    this.replica = replica;
    this.text = text;
    this.state = state;
    this.truncated = truncated;
    this.receipt = receipt;
    this.calls = Object.freeze([...calls]);
    this.pictures = Object.freeze([...pictures]);
    this.at = at;
    Object.freeze(this);
  }

  /** @param {Partial<ConstructorParameters<typeof CoachMessageValue>[0]>} changes */
  with(changes) {
    return new CoachMessageValue({ id: this.id, threadId: this.threadId, role: this.role, replica: this.replica, text: this.text, state: this.state,
      truncated: this.truncated, receipt: this.receipt, calls: this.calls, pictures: this.pictures, at: this.at, ...changes });
  }

  get isCoach() { return this.role === 'coach'; }

  // A lifter message carries its thread, role, text, pictures and moment only (gym Coach §9.1).
  /** @returns {Record<string, Json>} */
  fields() {
    return { threadId: this.threadId.json, role: this.role, at: this.at.ms, text: this.text,
      ...(this.pictures.length ? { pictures: this.pictures.map((picture) => picture.json) } : {}),
      ...(this.isCoach ? { ...(this.replica === null ? {} : { replica: this.replica }), state: this.state, truncated: this.truncated,
        ...(this.receipt === null ? {} : { receipt: this.receipt }), calls: this.calls.map((call) => call.json) } : {}) };
  }

  get callsBytes() { return jcsBytes(this.calls.map((call) => call.json)).length; }

  // The log rows the message's calls already hold by identity.
  get heldReads() {
    return this.calls.filter((call) => call.isOk && call.read instanceof ReadServed)
      .reduce((held, call) => held.saw(/** @type {ReadServed} */ (call.read)), ReadServed.none);
  }

  // gym Coach §9.2: the first form the calls bound holds: whole, less the rows earlier calls hold; without input; as
  // counts alone; refused `coach-turn-volume`; or none.
  /** @param {AbilityCall} call */
  recorded(call) {
    const fresh = call.read instanceof ReadServed ? call.with({ read: call.read.without(this.heldReads) }) : call;
    const forms = [fresh, fresh.with({ input: null })];
    if (fresh.read instanceof ReadServed && !fresh.read.isEmpty) forms.push(fresh.with({ input: null, read: fresh.read.tally }));
    forms.push(new AbilityCall({ callId: call.callId, name: call.name, outcome: AbilityRefusals.volume }));
    return forms.find((form) => this.with({ calls: [...this.calls, form] }).callsBytes <= CoachRules.maxCallsBytes) ?? null;
  }
}

/** @type {EntityType<CoachMessageValue, string>} */
export const CoachMessage = new EntityType({
  type: 'message', scope: 'self/gym', heldRemoval: false,
  decode: (f) => {
    const role = f.string('role');
    if (role !== 'lifter' && role !== 'coach') throw new DecodeError(CoachMessage.type, 'role', 'not a role');
    const state = f.string('state', 'running');
    const calls = f.json('calls');
    if (calls !== undefined && calls !== null && !Array.isArray(calls)) throw new DecodeError(CoachMessage.type, 'calls', 'not an array');
    const receipt = f.json('receipt');
    return new CoachMessageValue({ id: new Id(f.id, CoachMessage), threadId: f.ref('threadId', CoachThread), role, replica: f.optionalString('replica'),
      text: f.string('text', ''), state: MessageStates.all.find((known) => known === state) ?? 'running', truncated: f.bool('truncated', false),
      receipt: receipt === undefined ? null : receipt, calls: Array.isArray(calls) ? f.list('calls', AbilityCall.decode) : [],
      pictures: f.optionalList('pictures', Picture.decode) ?? [], at: f.instant('at') });
  },
  checks: [
    new Check('role', (message) => { CoachRules.role.apply(message.role, new Path('role')); return message; }),
    new Check('replica', (message) => { CoachRules.replica.applyOptional(message.replica, new Path('replica')); return message; }),
    new Check('text', (message) => message.with({ text: CoachRules.text.apply(message.text, new Path('text')) })),
    new Check('pictures', (message) => { CoachRules.pictures.apply([...message.pictures], new Path('pictures')); return message; }),
    new Check('receipt', (message) => { CoachRules.within(message.receipt, CoachRules.maxReceiptBytes, CoachRules.receipt, new Path('receipt')); return message; }),
    new Check('calls', (message) => {
      CoachRules.within(message.calls.map((call) => call.json), CoachRules.maxCallsBytes, CoachRules.calls, new Path('calls'));
      return message;
    }),
  ],
});

/** @type {RuleBook | null} */
let book = null;

// A book of its own: packages/api-contract/gym/domain/rules.json pins GymRules.book, which every gym implementation shares.
export const CoachBook = Object.freeze({
  get book() {
    book ??= new RuleBook(registry, [CoachThread, CoachMessage], [
      ...[CoachRules.title, CoachRules.role, CoachRules.replica, CoachRules.text, CoachRules.pictures, CoachRules.pictureId, CoachRules.mediaType]
        .map((spec) => Rule.localSpec(spec)),
      ...[CoachRules.receipt, CoachRules.calls, CoachRules.question].map((name) => Rule.localCheck(name, CoachMessage.type)),
    ]);
    return book;
  },
});

export const CoachTurnBounds = Object.freeze({
  contextTurns: 24,
  contextBytes: 24_000,
  contextPictures: 2,
  contextReadBytes: 64 * 1024,
  pictureEdge: 4096,
  pictureBytes: 5 * 1024 * 1024,
  modelPictureEdge: 1568,
  modelPictureBytes: 1024 * 1024,
  contextReads: Object.freeze(['list_sessions', 'list_notes', 'list_exercises', 'list_routines']),
});

// The reads over one conversation's messages, which the room and the turn host share.
export class Conversation {
  // The messages in the order they were said: by moment, the lifter before the Coach, then by id.
  /** @param {readonly CoachMessageValue[]} messages */
  constructor(messages) {
    this.messages = Object.freeze([...messages].sort((a, b) => a.at.ms - b.at.ms || Number(a.isCoach) - Number(b.isCoach) || Id.compare(a.id, b.id)));
    Object.freeze(this);
  }

  // gym Coach §4.1 step 4: the messages of the newest completed turns within the bounds, oldest first; the turn being
  // opened is not among them.
  /** @param {Id<CoachMessageValue>} before */
  history(before, turns = CoachTurnBounds.contextTurns, bytes = CoachTurnBounds.contextBytes) {
    /** @type {CoachMessageValue[][]} */
    const newestFirst = [];
    let used = 0;
    for (let index = this.messages.length - 1; index > 0; index -= 1) {
      const answer = /** @type {CoachMessageValue} */ (this.messages[index]);
      const question = /** @type {CoachMessageValue} */ (this.messages[index - 1]);
      if (!answer.isCoach || answer.id.equals(before) || answer.state !== 'completed' || question.isCoach) continue;
      const cost = lengthIn('bytes', question.text) + lengthIn('bytes', answer.text);
      if (newestFirst.length >= turns || used + cost > bytes) break;
      newestFirst.push([question, answer]);
      used += cost;
    }
    return newestFirst.reverse().flat();
  }

  // gym Coach §4.1 step 5: the pictures of the lifter message being sent and of the one before it, newest first.
  /** @param {Id<CoachMessageValue>} sending */
  contextPictures(sending, limit = CoachTurnBounds.contextPictures) {
    const questions = this.messages.filter((message) => !message.isCoach);
    const at = questions.map((message) => message.id.equals(sending)).lastIndexOf(true);
    if (at < 0) return [];
    return [questions[at], questions[at - 1]].flatMap((message) => message?.pictures ?? []).slice(0, limit);
  }
}
