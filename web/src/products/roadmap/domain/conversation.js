// @ts-check
// Roadmap Coach's records (roadmap-coach.md §9), kept in the person's `self/roadmap`: a conversation, its messages, the
// proposals and write fates they carry; the read of one conversation; and what a turn writes as it opens, ends, or is
// withdrawn before it began (§8). A removal of any of them is held, as a roadmap's is, so one held delete can carry both.

import { lengthIn } from '../../../../../packages/api-contract/sync/reference/core/values.js';
import { ActDecision } from '../../../platform/domain-kit/acts.js';
import { EntityType, Id } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path, TextSpec, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { RoadmapChecks, RoadmapLimits, RoadmapRefusals, RoadmapScopes, RoadmapSpecs, gone, writeIn } from './roadmapRules.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/time.js').Instant} Instant */
/** @typedef {'running' | 'interrupted' | 'completed' | 'declined' | 'failed' | 'stopped'} MessageState */
/** @typedef {{ thread: Id<CoachThreadValue>, person: Id<CoachMessageValue>, coach: Id<CoachMessageValue> }} Turn */

// The registry's patterns for a picture's id, which its device row's key repeats, and for a refusal code.
const PICTURE_ID = /^[A-Za-z0-9_-]{8,64}$/u;
const CODE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;

// The registry's rank: a terminal state beats running, and a writer's terminal state beats another device's interrupted.
export const MessageStates = Object.freeze({
  all: /** @type {readonly MessageState[]} */ (Object.freeze(['running', 'interrupted', 'completed', 'declined', 'failed', 'stopped'])),
  /** @param {MessageState} state */
  isTerminal: (state) => state !== 'running',
  /** @param {MessageState} state */
  isWritersTerminal: (state) => state !== 'running' && state !== 'interrupted',
});

// One conversation: what it is about, a roadmap or every roadmap (`treeId` null), the step it started from, and its title.
export class CoachThreadValue {
  /** @param {Id<CoachThreadValue>} id @param {{ treeId?: string | null, stepId?: string | null, title: string }} values */
  constructor(id, { treeId = null, stepId = null, title }) {
    this.id = id;
    this.treeId = treeId;
    this.stepId = stepId;
    this.title = title;
    Object.freeze(this);
  }

  /** @param {{ stepId?: string | null, title?: string }} changes */
  with(changes) { return new CoachThreadValue(this.id, { treeId: this.treeId, stepId: this.stepId, title: this.title, ...changes }); }

  fields() { return { treeId: this.treeId, stepId: this.stepId, title: this.title }; }
}

/** @type {EntityType<CoachThreadValue, string>} */
export const CoachThread = new EntityType({
  type: 'coachThread', scope: RoadmapScopes.account, heldRemoval: true,
  decode: (f) => new CoachThreadValue(new Id(f.id, CoachThread), { treeId: f.optionalString('treeId'), stepId: f.optionalString('stepId'), title: f.string('title', '') }),
  checks: [
    new Check('treeId', (thread) => { RoadmapSpecs.coachTreeId.applyOptional(thread.treeId, new Path('treeId')); return thread; }),
    new Check('stepId', (thread) => thread.with({ stepId: RoadmapSpecs.coachStep.applyOptional(thread.stepId, new Path('stepId')) })),
    new Check('title', (thread) => thread.with({ title: RoadmapSpecs.coachTitle.apply(thread.title, new Path('title')) })),
  ],
});

// A picture on a message: its id on the device that sent it while `localOnly`.
export class CoachPicture {
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
    const id = RoadmapSpecs.coachPictureId.apply(this.id, at.plus('id'));
    if (!PICTURE_ID.test(id)) throw new Violation(RoadmapSpecs.coachPictureId.path, at.plus('id'), { kind: 'custom', custom: 'notAnId' });
    return new CoachPicture(id, RoadmapSpecs.coachMediaType.apply(this.mediaType, at.plus('mediaType')), this.localOnly);
  }

  // The device row that keeps a picture's original on the device that sent it.
  /** @param {string} id */
  static rowKey(id) { return `picture:${id}`; }

  /** @param {import('../../../platform/domain-kit/entities.js').Fields} f */
  static decode(f) { return new CoachPicture(f.string('id'), f.string('mediaType'), f.bool('localOnly', false)); }
}

/** @typedef {'person' | 'coach'} Role */

// One message: the person's question, or Coach's answer with the state of its turn, `truncated` and the code a turn
// that could not answer ended with. The calls, receipts and proposal a turn records are m3's and m4's to write.
export class CoachMessageValue {
  /**
   * @param {{ id: Id<CoachMessageValue>, threadId: Id<CoachThreadValue>, role: Role, replica?: string | null, text?: string, state?: MessageState,
   *   truncated?: boolean, refusal?: string | null, pictures?: readonly CoachPicture[], at: Instant }} message
   */
  constructor({ id, threadId, role, replica = null, text = '', state = 'running', truncated = false, refusal = null, pictures = [], at }) {
    this.id = id;
    this.threadId = threadId;
    this.role = role;
    this.replica = replica;
    this.text = text;
    this.state = state;
    this.truncated = truncated;
    this.refusal = refusal;
    this.pictures = Object.freeze([...pictures]);
    this.at = at;
    Object.freeze(this);
  }

  /** @param {Partial<ConstructorParameters<typeof CoachMessageValue>[0]>} changes */
  with(changes) {
    return new CoachMessageValue({ id: this.id, threadId: this.threadId, role: this.role, replica: this.replica, text: this.text, state: this.state,
      truncated: this.truncated, refusal: this.refusal, pictures: this.pictures, at: this.at, ...changes });
  }

  get isCoach() { return this.role === 'coach'; }

  // A person's message carries its conversation, role, text, pictures and moment only.
  /** @returns {Record<string, Json>} */
  fields() {
    return { threadId: this.threadId.json, role: this.role, at: this.at.ms, text: this.text,
      ...(this.pictures.length ? { pictures: this.pictures.map((picture) => picture.json) } : {}),
      ...(this.isCoach ? { ...(this.replica === null ? {} : { replica: this.replica }), state: this.state, truncated: this.truncated, refusal: this.refusal } : {}) };
  }
}

/** @type {EntityType<CoachMessageValue, string>} */
export const CoachMessage = new EntityType({
  type: 'coachMessage', scope: RoadmapScopes.account, heldRemoval: true,
  decode: (f) => {
    const state = f.string('state', 'running');
    return new CoachMessageValue({ id: new Id(f.id, CoachMessage), threadId: f.ref('threadId', CoachThread),
      role: /** @type {Role} */ (f.string('role')), replica: f.optionalString('replica'),
      text: f.string('text', ''), state: MessageStates.all.find((known) => known === state) ?? 'running', truncated: f.bool('truncated', false),
      refusal: f.optionalString('refusal'), pictures: f.optionalList('pictures', CoachPicture.decode) ?? [], at: f.instant('at') });
  },
  checks: [
    new Check('role', (message) => { RoadmapSpecs.coachRole.apply(message.role, new Path('role')); return message; }),
    new Check('replica', (message) => { RoadmapSpecs.coachReplica.applyOptional(message.replica, new Path('replica')); return message; }),
    new Check('text', (message) => message.with({ text: RoadmapSpecs.coachText.apply(message.text, new Path('text')) })),
    new Check('refusal', (message) => {
      const refusal = RoadmapSpecs.coachRefusal.applyOptional(message.refusal, new Path('refusal'));
      if (refusal !== null && !CODE.test(refusal)) throw new Violation(RoadmapSpecs.coachRefusal.path, new Path('refusal'), { kind: 'custom', custom: 'notACode' });
      return message;
    }),
    new Check('pictures', (message) => {
      RoadmapSpecs.coachPictures.apply([...message.pictures], new Path('pictures'));
      return message.with({ pictures: message.pictures.map((picture, index) => picture.validated(new Path(`pictures.${index}`))) });
    }),
  ],
});

/** @typedef {'pending' | 'applied' | 'rejected' | 'stale' | 'replaced'} ProposalState */

// A proposal (§7) as far as a roadmap's delete reads it: the roadmap it changes, where it was made, and its state. Minting
// one, with its base and changes, is m4's.
export class CoachProposalValue {
  /** @param {Id<CoachProposalValue>} id @param {{ treeId: string, threadId: Id<CoachThreadValue>, messageId: Id<CoachMessageValue>, state?: ProposalState }} values */
  constructor(id, { treeId, threadId, messageId, state = 'pending' }) {
    this.id = id;
    this.treeId = treeId;
    this.threadId = threadId;
    this.messageId = messageId;
    this.state = state;
    Object.freeze(this);
  }
}

const PROPOSAL_STATES = Object.freeze(['pending', 'applied', 'rejected', 'stale', 'replaced']);

/** @type {EntityType<CoachProposalValue, string>} */
export const CoachProposal = new EntityType({
  type: 'coachProposal', scope: RoadmapScopes.account, heldRemoval: true, checks: [],
  decode: (f) => {
    const state = f.string('state', 'pending');
    return new CoachProposalValue(new Id(f.id, CoachProposal), { treeId: f.string('treeId'), threadId: f.ref('threadId', CoachThread),
      messageId: f.ref('messageId', CoachMessage), state: /** @type {ProposalState} */ (PROPOSAL_STATES.find((known) => known === state) ?? 'pending') });
  },
});

/** @typedef {'undone' | 'refused'} Fate */

// What became of one receipt's write after its turn ended (§6): undone, or refused by the server with its code. Writing
// one is m3's.
export class CoachWriteFateValue {
  /** @param {Id<CoachWriteFateValue>} id @param {{ messageId: Id<CoachMessageValue>, receipt: number, fate: Fate, code?: string | null }} values */
  constructor(id, { messageId, receipt, fate, code = null }) {
    this.id = id;
    this.messageId = messageId;
    this.receipt = receipt;
    this.fate = fate;
    this.code = code;
    Object.freeze(this);
  }
}

/** @type {EntityType<CoachWriteFateValue, string>} */
export const CoachWriteFate = new EntityType({
  type: 'coachWriteFate', scope: RoadmapScopes.account, heldRemoval: true, checks: [],
  decode: (f) => new CoachWriteFateValue(new Id(f.id, CoachWriteFate), { messageId: f.ref('messageId', CoachMessage), receipt: f.int('receipt'),
    fate: /** @type {Fate} */ (f.string('fate')), code: f.optionalString('code') }),
});

// One conversation as the device draws it: none once the conversation is gone, its own delete still held included, so
// a removed conversation shows no message and no write fate before the server's consequences arrive.
export class Conversation {
  /** @param {CoachThreadValue} thread @param {readonly CoachMessageValue[]} messages @param {readonly CoachWriteFateValue[]} fates */
  constructor(thread, messages, fates) {
    this.thread = thread;
    // The messages in the order they were said: by moment, the person's before Coach's, then by id.
    this.messages = Object.freeze([...messages].sort((a, b) => a.at.ms - b.at.ms || Number(a.isCoach) - Number(b.isCoach) || Id.compare(a.id, b.id)));
    // Each message's write fates, in the messages' order, then by receipt and id.
    this.fates = Object.freeze(this.messages.flatMap((message) => fates.filter((fate) => fate.messageId.equals(message.id))
      .sort((a, b) => a.receipt - b.receipt || Id.compare(a.id, b.id))));
    Object.freeze(this);
  }

  /** @param {Reader} read @param {Id<CoachThreadValue>} thread */
  static read(read, thread) {
    const found = read.repository(CoachThread).find(thread, 'drawn');
    if (found === null) return null;
    const messages = read.repository(CoachMessage).children(thread, 'threadId', 'drawn');
    const fates = messages.flatMap((message) => read.repository(CoachWriteFate).children(message.id, 'messageId', 'drawn'));
    return new Conversation(found, messages, fates);
  }
}

// The mark of one turn (Coach engine D-6, roadmap-coach.md §8): the device row `runningTurn:<turnId>`, keyed by the
// Coach message the turn writes, holding the round in flight, `{callId, bytesBefore}`. Before the first round `callId`
// is null.
export const TurnMark = Object.freeze({
  /** @param {Id<CoachMessageValue>} message */
  key: (message) => `runningTurn:${message.record}`,
  opening: Object.freeze({ callId: null, bytesBefore: 0 }),
});

// §8 and Coach engine §5 step 1: in one write, the person's message, Coach's running message, a new conversation when
// none is named, about the roadmap `about` names or every roadmap, and the turn's mark. A question keeps gym's bounds.
export class OpenTurn {
  /**
   * @param {{ thread?: Id<CoachThreadValue> | null, about?: { treeId: string | null, stepId?: string | null } | null, question: string,
   *   pictures?: readonly CoachPicture[] }} input
   */
  constructor({ thread = null, about = null, question, pictures = [] }) {
    precondition((thread === null) !== (about === null), 'a turn names its conversation, or what a new one is about');
    this.thread = thread;
    this.about = about;
    this.question = question;
    this.pictures = Object.freeze([...pictures]);
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/acts.js').ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => ({
      thread: this.thread === null ? null : account.repository(CoachThread).find(this.thread, 'drawn'), replica: account.replica, moment: account.moment,
    }));
  }

  /** @param {ReturnType<OpenTurn['load']>} loaded @param {import('../../../platform/domain-kit/acts.js').ActIDSource} ids */
  decide({ thread, replica, moment }, ids) {
    if (this.thread !== null && thread === null) return gone(CoachThread.type, this.thread.record);
    const bytes = lengthIn('bytes', this.question);
    if (bytes > RoadmapLimits.questionBytes) {
      throw new Violation(RoadmapChecks.question, new Path('text'), { kind: 'tooLong', max: RoadmapLimits.questionBytes, unit: 'bytes', measured: bytes });
    }
    const blank = TextSpec.isBlank(this.question);
    if (blank && this.pictures.length === 0) throw new Violation(RoadmapChecks.question, new Path('text'), { kind: 'blank' });
    const plan = new Plan();
    const threadId = this.thread ?? ids.mint(CoachThread);
    if (this.about !== null) {
      plan.create(new Valid(new CoachThreadValue(threadId, { treeId: this.about.treeId, stepId: this.about.stepId ?? null, title: blank ? 'Photo' : this.question }),
        moment));
    }
    /** @type {Turn} */
    const turn = { thread: threadId, person: ids.mint(CoachMessage), coach: ids.mint(CoachMessage) };
    const at = moment.now;
    plan.create(new Valid(new CoachMessageValue({ id: turn.person, threadId, role: 'person', text: this.question, pictures: this.pictures, at }), moment));
    plan.create(new Valid(new CoachMessageValue({ id: turn.coach, threadId, role: 'coach', replica, at }), moment));
    plan.device(TurnMark.key(turn.coach), TurnMark.opening);
    return writeIn(RoadmapScopes.account, plan, { thread: threadId.record, person: turn.person.record, coach: turn.coach.record });
  }
}

// §8 and §9: Coach's message takes its terminal state, its whole text, `truncated` and the code a turn that could not
// answer ended with, in one write that lets go of the turn's mark. A turn its writer already ended is final.
export class EndTurn {
  /**
   * @param {Id<CoachMessageValue>} message
   * @param {{ state: MessageState, text?: string | null, truncated?: boolean, refusal?: string | null }} end
   */
  constructor(message, { state, text = null, truncated = false, refusal = null }) {
    precondition(MessageStates.isTerminal(state), 'a turn ends in a terminal state');
    this.message = message;
    this.state = state;
    this.text = text;
    this.truncated = truncated;
    this.refusal = refusal;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/acts.js').ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => ({
      message: account.repository(CoachMessage).find(this.message, 'drawn'), marked: account.device(TurnMark.key(this.message)) !== null, moment: account.moment,
    }));
  }

  /** @param {ReturnType<EndTurn['load']>} loaded */
  decide({ message, marked, moment }) {
    if (message === null || !message.isCoach) return gone(CoachMessage.type, this.message.record);
    if (MessageStates.isWritersTerminal(message.state)) return ActDecision.unchanged(null);
    const written = ['state', 'text', 'truncated', 'refusal'];
    const plan = new Plan();
    plan.update(new Valid(message.with({ state: this.state, text: this.text ?? message.text, truncated: this.truncated, refusal: this.refusal }), moment, written),
      { fields: written });
    if (marked) plan.device(TurnMark.key(this.message), null);
    return writeIn(RoadmapScopes.account, plan, null);
  }
}

// A turn refused before its answer began never happened: its two messages go, with the pictures they kept on this
// device, the conversation too when it held nothing else, and the turn's mark. It answers the picture ids forgotten.
export class WithdrawTurn {
  /** @param {Turn} turn */
  constructor(turn) {
    this.turn = turn;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/acts.js').ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => ({
      thread: account.repository(CoachThread).find(this.turn.thread, 'drawn'),
      messages: account.repository(CoachMessage).children(this.turn.thread, 'threadId', 'stored'),
      marked: account.device(TurnMark.key(this.turn.coach)) !== null,
    }));
  }

  /** @param {ReturnType<WithdrawTurn['load']>} loaded */
  decide({ thread, messages, marked }) {
    const withdrawn = messages.filter((message) => message.id.equals(this.turn.person) || message.id.equals(this.turn.coach));
    if (withdrawn.length === 0 && !marked) return ActDecision.unchanged(/** @type {string[]} */ ([]));
    const plan = new Plan();
    for (const message of withdrawn) plan.remove(message.id);
    const pictures = withdrawn.flatMap((message) => message.pictures).filter((picture) => picture.localOnly).map((picture) => picture.id);
    for (const id of pictures) plan.device(CoachPicture.rowKey(id), null);
    if (thread !== null && withdrawn.length === messages.length) plan.remove(this.turn.thread);
    if (marked) plan.device(TurnMark.key(this.turn.coach), null);
    return writeIn(RoadmapScopes.account, plan, pictures);
  }
}
