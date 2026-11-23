// @ts-check
// What a turn writes around its records (gym Coach on the AI service §4.4, §5): the open, the text as it streams, the
// round in flight, the end, the withdraw and the delete of a conversation; the mark that names the turn this browser is
// running; and the pictures the browser keeps for it.

import { lengthIn } from '../../../../../../packages/api-contract/sync/reference/core/values.js';
import { Decision } from '../../../../platform/domain-kit/actions.js';
import { DecodeError, Fields, Id } from '../../../../platform/domain-kit/entities.js';
import { Plan } from '../../../../platform/domain-kit/plans.js';
import { Refused } from '../../../../platform/domain-kit/refusals.js';
import { Valid } from '../../../../platform/domain-kit/validation.js';
import { Path, TextSpec, Violation, precondition } from '../../../../platform/domain-kit/values.js';
import { GymRefusals } from '../gymRules.js';
import { AbilityCall, CoachMessage, CoachMessageValue, CoachRules, CoachThread, CoachThreadValue, CoachTurnBounds, MessageStates } from './conversation.js';

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../../platform/domain-kit/actions.js').IDSource} IDSource */
/** @typedef {import('../gymRules.js').GymRefusal} GymRefusal */
/** @typedef {import('./conversation.js').MessageState} MessageState */
/** @typedef {import('./conversation.js').Picture} Picture */
/** @typedef {{ thread: Id<CoachThreadValue>, lifter: Id<CoachMessageValue>, coach: Id<CoachMessageValue> }} Turn */

const MESSAGE_ID = /^[A-Za-z0-9_-]{8,58}$/u;
const CALL_ID = /^[A-Za-z0-9_-]{22}$/u;

/** @param {Id<any>} id @returns {GymRefusal} */
function gone(id) { return GymRefusals.ofRefused(new Refused('unknown-record', id.ref, null, 'predicted')); }

/** @param {string} code @param {Id<any> | null} id @returns {GymRefusal} */
function predicted(code, id) { return GymRefusals.ofRefused(new Refused(code, id?.ref ?? null, null, 'predicted')); }

// The mark (Coach engine D-6, gym Coach on the AI service §4.4): `runningTurn`, the Coach message this browser's turn
// writes, and `runningRound`, `{message, callId, bytesBefore}`, the round in flight. A round counts only when it names
// the running turn's message and holds its shape; any other round row is stale, and a reader that meets one clears it.
export class Mark {
  static turnKey = 'runningTurn';
  static roundKey = 'runningRound';

  /** @param {string | null} turnId @param {{ callId: string, bytesBefore: number } | null} round @param {boolean} roundRow */
  constructor(turnId, round, roundRow) {
    this.turnId = turnId;
    this.callId = round?.callId ?? null;
    this.textBytesBeforeRound = round?.bytesBefore ?? 0;
    this.roundRow = roundRow;
    Object.freeze(this);
  }

  // A round row the device holds that names no round of the running turn.
  get roundIsStale() { return this.roundRow && this.callId === null; }

  /** @param {Id<CoachMessageValue>} message */
  names(message) { return this.turnId !== null && this.turnId === message.record; }

  // Every write that clears `runningTurn` clears `runningRound` in the same write.
  /** @param {Plan} plan */
  clear(plan) {
    plan.device(Mark.turnKey, null);
    plan.device(Mark.roundKey, null);
  }

  /** @param {Reader} read */
  static read(read) {
    const turn = read.device(Mark.turnKey);
    const turnId = typeof turn === 'string' && MESSAGE_ID.test(turn) ? turn : null;
    const row = read.device(Mark.roundKey);
    if (row === null) return new Mark(turnId, null, false);
    const round = row !== null && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const shaped = Object.keys(round).length === 3 && round.message === turnId && turnId !== null
      && typeof round.callId === 'string' && CALL_ID.test(round.callId)
      && Number.isSafeInteger(round.bytesBefore) && /** @type {number} */ (round.bytesBefore) >= 0 && /** @type {number} */ (round.bytesBefore) <= 131_072;
    return new Mark(turnId, shaped ? { callId: /** @type {string} */ (round.callId), bytesBefore: /** @type {number} */ (round.bytesBefore) } : null, true);
  }
}

// The mark as a turn host recovers from it (Coach engine §5): read, with a stale or malformed round row cleared.
export class RecoverMark {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {Reader} read */
  load(read) { return Mark.read(read); }

  /** @param {Mark} mark @param {IDSource} ids */
  decide(mark, ids) {
    if (!mark.roundIsStale) return Decision.unchanged(mark);
    const plan = new Plan();
    plan.device(Mark.roundKey, null);
    return Decision.write(plan, new Mark(mark.turnId, null, false));
  }
}

// gym Coach §4.1 step 2: in one transaction, the lifter's message, the running Coach message, a new thread when none
// is named, and `runningTurn`.
export class OpenTurn {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {{ thread?: Id<CoachThreadValue> | null, question: string, pictures?: readonly Picture[] }} input */
  constructor({ thread = null, question, pictures = [] }) {
    this.thread = thread;
    this.question = question;
    this.pictures = Object.freeze([...pictures]);
  }

  /** @param {Reader} read */
  load(read) {
    return { thread: this.thread === null ? null : read.repository(CoachThread).find(this.thread, 'drawn'), replica: read.replica, moment: read.moment };
  }

  /** @param {ReturnType<OpenTurn['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    if (this.thread !== null && loaded.thread === null) return Decision.refuse(gone(this.thread));
    const bytes = lengthIn('bytes', this.question);
    if (bytes > CoachRules.maxQuestionBytes) {
      throw new Violation(CoachRules.question, new Path('text'), { kind: 'tooLong', max: CoachRules.maxQuestionBytes, unit: 'bytes', measured: bytes });
    }
    const blank = TextSpec.isBlank(this.question);
    if (blank && this.pictures.length === 0) throw new Violation(CoachRules.question, new Path('text'), { kind: 'blank' });
    const plan = new Plan();
    const threadId = this.thread ?? ids.mint(CoachThread);
    if (this.thread === null) plan.create(new Valid(new CoachThreadValue(threadId, blank ? 'Photo' : this.question), loaded.moment));
    /** @type {Turn} */
    const turn = { thread: threadId, lifter: ids.mint(CoachMessage), coach: ids.mint(CoachMessage) };
    const at = loaded.moment.now;
    plan.create(new Valid(new CoachMessageValue({ id: turn.lifter, threadId, role: 'lifter', text: this.question, pictures: this.pictures, at }), loaded.moment));
    plan.create(new Valid(new CoachMessageValue({ id: turn.coach, threadId, role: 'coach', replica: loaded.replica, at }), loaded.moment));
    plan.device(Mark.turnKey, turn.coach.record);
    return Decision.write(plan, turn);
  }
}

// This replica's Coach message, while its writer has not ended it: a message another device marked `interrupted` is
// still the writer's to answer (gym Coach on the AI service §4.2).
/** @param {CoachMessageValue | null} message @param {string} replica */
export function writersOwn(message, replica) {
  return message !== null && message.isCoach && message.replica === replica && !MessageStates.isWritersTerminal(message.state);
}

// The answer as it streams: this replica's Coach message takes the text so far, until its writer ends it.
export class StreamTurnText {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {Id<CoachMessageValue>} message @param {string} text */
  constructor(message, text) {
    this.message = message;
    this.text = text;
  }

  /** @param {Reader} read */
  load(read) { return { message: read.repository(CoachMessage).find(this.message, 'drawn'), replica: read.replica, moment: read.moment }; }

  /** @param {ReturnType<StreamTurnText['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    const streaming = loaded.message?.isCoach ? loaded.message : null;
    if (streaming === null) return Decision.refuse(gone(this.message));
    if (!writersOwn(streaming, loaded.replica) || streaming.text === this.text) return Decision.unchanged(null);
    const plan = new Plan();
    plan.update(new Valid(streaming.with({ text: this.text }), loaded.moment, ['text']), { fields: ['text'] });
    return Decision.write(plan, null);
  }
}

// A round begins (Coach engine D-6): `runningRound` names it and the bytes of text before it, beside the running turn.
export class BeginRound {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {Id<CoachMessageValue>} message @param {string} callId @param {number} bytesBefore */
  constructor(message, callId, bytesBefore) {
    precondition(CALL_ID.test(callId), 'a round is named by a call id of 22 characters');
    precondition(Number.isSafeInteger(bytesBefore) && bytesBefore >= 0 && bytesBefore <= 131_072, 'a round starts within the text bound');
    this.message = message;
    this.callId = callId;
    this.bytesBefore = bytesBefore;
  }

  /** @param {Reader} read */
  load(read) { return { message: read.repository(CoachMessage).find(this.message, 'drawn'), replica: read.replica, mark: Mark.read(read) }; }

  /** @param {ReturnType<BeginRound['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    if (!loaded.message?.isCoach) return Decision.refuse(gone(this.message));
    if (!writersOwn(loaded.message, loaded.replica) || !loaded.mark.names(this.message)) return Decision.refuse(predicted('message-final', this.message));
    if (loaded.mark.callId === this.callId && loaded.mark.textBytesBeforeRound === this.bytesBefore) return Decision.unchanged(null);
    const plan = new Plan();
    plan.device(Mark.roundKey, { message: this.message.record, callId: this.callId, bytesBefore: this.bytesBefore });
    return Decision.write(plan, null);
  }
}

// gym Coach §4.4, §4.5: the terminal state, the whole text, `truncated` and the receipt the calls derive in one write,
// with the mark cleared unless it names another turn. A turn its writer already ended is final.
export class EndTurn {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {Id<CoachMessageValue>} message @param {MessageState} state @param {string | null} [text] @param {boolean} [truncated] */
  constructor(message, state, text = null, truncated = false) {
    precondition(MessageStates.isTerminal(state), 'a turn ends in a terminal state');
    this.message = message;
    this.state = state;
    this.text = text;
    this.truncated = truncated;
  }

  /** @param {Reader} read */
  load(read) { return { message: read.repository(CoachMessage).find(this.message, 'drawn'), moment: read.moment, mark: Mark.read(read) }; }

  // The end itself: the state, the whole text, `truncated` and the receipt the calls derive.
  /** @param {Plan} plan @param {CoachMessageValue} running @param {MessageState} state @param {string} text @param {boolean} truncated @param {import('../../../../platform/domain-kit/time.js').Moment} moment */
  static write(plan, running, state, text, truncated, moment) {
    const written = ['state', 'text', 'receipt', 'truncated'];
    plan.update(new Valid(running.with({ state, text, truncated, receipt: AbilityCall.receipt(running.calls) }), moment, written), { fields: written });
  }

  /** @param {ReturnType<EndTurn['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    const running = loaded.message?.isCoach ? loaded.message : null;
    if (running === null) return Decision.refuse(gone(this.message));
    if (MessageStates.isWritersTerminal(running.state)) return Decision.unchanged(null);
    const plan = new Plan();
    EndTurn.write(plan, running, this.state, this.text ?? running.text, this.truncated, loaded.moment);
    if (loaded.mark.turnId === null || loaded.mark.names(this.message)) loaded.mark.clear(plan);
    return Decision.write(plan, null);
  }
}

// A turn whose message is gone, as a conversation deleted elsewhere takes it: the mark lets go of it, and of no other.
export class ForgetRunningTurn {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {Id<CoachMessageValue>} message */
  constructor(message) { this.message = message; }

  /** @param {Reader} read */
  load(read) { return Mark.read(read); }

  /** @param {Mark} mark @param {IDSource} ids */
  decide(mark, ids) {
    if (!mark.names(this.message)) return Decision.unchanged(null);
    const plan = new Plan();
    mark.clear(plan);
    return Decision.write(plan, null);
  }
}

/** @param {Plan} plan @param {readonly CoachMessageValue[]} messages */
function forgetPictures(plan, messages) {
  const pictures = messages.flatMap((message) => message.pictures).filter((picture) => picture.localOnly).map((picture) => picture.id);
  for (const id of pictures) plan.device(CoachPictureRow.key(id), null);
  return pictures;
}

// A turn the AI service refused before its first word never happened: its messages, their pictures, the thread when it
// held nothing else, and the mark go. It answers the picture ids removed.
export class WithdrawTurn {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {Turn} turn */
  constructor(turn) { this.turn = turn; }

  /** @param {Reader} read */
  load(read) {
    return { thread: read.repository(CoachThread).find(this.turn.thread, 'drawn'),
      messages: read.repository(CoachMessage).children(this.turn.thread, 'threadId', 'stored'), mark: Mark.read(read) };
  }

  /** @param {ReturnType<WithdrawTurn['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    const withdrawn = loaded.messages.filter((message) => message.id.equals(this.turn.lifter) || message.id.equals(this.turn.coach));
    const plan = new Plan();
    for (const message of withdrawn) plan.remove(message.id);
    const pictures = forgetPictures(plan, withdrawn);
    if (loaded.thread !== null && withdrawn.length === loaded.messages.length) plan.remove(this.turn.thread);
    loaded.mark.clear(plan);
    return Decision.write(plan, pictures);
  }
}

// A conversation deleted from History: the thread, its messages, their pictures, and the mark when it names one of
// them. It answers the picture ids removed.
export class DeleteConversation {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {Id<CoachThreadValue>} thread */
  constructor(thread) { this.thread = thread; }

  /** @param {Reader} read */
  load(read) {
    return { thread: read.repository(CoachThread).find(this.thread, 'drawn'),
      messages: read.repository(CoachMessage).children(this.thread, 'threadId', 'stored'), mark: Mark.read(read) };
  }

  /** @param {ReturnType<DeleteConversation['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    if (loaded.thread === null) return Decision.unchanged(/** @type {string[]} */ ([]));
    const plan = new Plan();
    plan.remove(this.thread);
    for (const message of loaded.messages) plan.remove(message.id);
    const pictures = forgetPictures(plan, loaded.messages);
    if (loaded.messages.some((message) => loaded.mark.names(message.id))) loaded.mark.clear(plan);
    return Decision.write(plan, pictures);
  }
}

// One copy of a picture as the browser keeps it: its media type, its size in pixels, and its bytes in base64.
export class PictureCopy {
  /** @param {string} mediaType @param {number} width @param {number} height @param {string} data */
  constructor(mediaType, width, height, data) {
    this.mediaType = mediaType;
    this.width = width;
    this.height = height;
    this.data = data;
    Object.freeze(this);
  }

  // The bytes the base64 holds.
  get bytes() { return Math.floor((this.data.length * 3) / 4) - (this.data.endsWith('==') ? 2 : this.data.endsWith('=') ? 1 : 0); }

  /** @returns {Json} */
  get json() { return { mediaType: this.mediaType, width: this.width, height: this.height, data: this.data }; }

  /** @param {Fields} f */
  static decode(f) {
    const data = f.string('data');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 !== 0) throw new DecodeError('picture', f.named('data'), 'not base64');
    return new PictureCopy(f.string('mediaType'), f.int('width'), f.int('height'), data);
  }
}

// A picture the browser keeps in its `picture:<id>` device row (gym Coach on the AI service §5): the original the person
// chose, and the model copy, bounded, that alone leaves the browser, for the AI service to hold through a turn.
export class CoachPictureRow {
  static prefix = 'picture:';

  /** @param {string} id @param {PictureCopy} original @param {PictureCopy} model */
  constructor(id, original, model) {
    this.id = id;
    this.original = original;
    this.model = model;
    Object.freeze(this);
  }

  /** @param {string} id */
  static key(id) { return CoachPictureRow.prefix + id; }

  /** @returns {Json} */
  get json() { return { original: this.original.json, model: this.model.json }; }

  // A row this build cannot read is no picture.
  /** @param {string} id @param {Json} json */
  static decode(id, json) {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
    try {
      const f = Fields.object(json, 'picture');
      return new CoachPictureRow(id, f.value('original', PictureCopy.decode), f.value('model', PictureCopy.decode));
    } catch (error) {
      if (error instanceof DecodeError) return null;
      throw error;
    }
  }
}

// Both copies within gym Coach §9.3's bounds: the original's `PICTURE_EDGE` and `PICTURE_BYTES`, the model copy's own.
export class KeepPicture {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {CoachPictureRow} picture */
  constructor(picture) {
    const { original, model } = picture;
    precondition(CoachRules.pictureIdPattern.test(picture.id), 'a picture\'s id is one its row key admits');
    precondition(Math.max(original.width, original.height) <= CoachTurnBounds.pictureEdge && original.bytes <= CoachTurnBounds.pictureBytes,
      'a picture\'s original is within its bounds');
    precondition(Math.max(model.width, model.height) <= CoachTurnBounds.modelPictureEdge && model.bytes <= CoachTurnBounds.modelPictureBytes,
      'a picture\'s model copy is within its bounds');
    this.picture = picture;
  }

  /** @param {Reader} read */
  load(read) { return null; }

  /** @param {null} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    const plan = new Plan();
    plan.device(CoachPictureRow.key(this.picture.id), this.picture.json);
    return Decision.write(plan, null);
  }
}

// The row of a picture kept for a turn that did not open.
export class ForgetPicture {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {string} id */
  constructor(id) { this.id = id; }

  /** @param {Reader} read */
  load(read) { return read.device(CoachPictureRow.key(this.id)) !== null; }

  /** @param {boolean} kept @param {IDSource} ids */
  decide(kept, ids) {
    if (!kept) return Decision.unchanged(null);
    const plan = new Plan();
    plan.device(CoachPictureRow.key(this.id), null);
    return Decision.write(plan, null);
  }
}

// Every message the replica draws, or null where one cannot be read: a message this build cannot read might claim any
// picture.
/** @param {Reader} read */
function drawnMessages(read) {
  return read.views.visible('drawn', CoachMessage.type).map((record) => {
    try { return CoachMessage.decode(Fields.record(record)); }
    catch (error) {
      if (error instanceof DecodeError) return null;
      throw error;
    }
  });
}

const messageUnreadable = predicted('coach-message-unreadable', null);

// The picture rows no message claims: a conversation deleted elsewhere, or a tab closed between `KeepPicture` and
// `OpenTurn`. A replica behind its log cannot tell a message gone from one not yet arrived, so it forgets nothing; a
// message this build cannot read holds the sweep, which refuses and forgets nothing until the next pass.
export class ForgetUnclaimedPictures {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {Reader} read */
  load(read) {
    const rows = Object.keys(read.devices(CoachPictureRow.prefix));
    const caughtUp = read.isAnonymous || (read.firstPullComplete() && read.checkpoint().cleanSeq !== null);
    if (rows.length === 0 || !caughtUp) return { rows: [], claimed: new Set(), unreadable: false };
    const messages = drawnMessages(read);
    return { rows, claimed: new Set(messages.flatMap((message) => message?.pictures ?? []).map((picture) => CoachPictureRow.key(picture.id))),
      unreadable: messages.includes(null) };
  }

  /** @param {ReturnType<ForgetUnclaimedPictures['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    if (loaded.unreadable) return Decision.refuse(messageUnreadable);
    const unclaimed = loaded.rows.filter((key) => !loaded.claimed.has(key));
    if (unclaimed.length === 0) return Decision.unchanged(null);
    const plan = new Plan();
    for (const key of unclaimed) plan.device(key, null);
    return Decision.write(plan, null);
  }
}

// Signing out takes what Coach keeps in the browser (gym Coach on the AI service §5): the mark, and every picture but
// those a message not yet sent names, which stay with the unsent work a Keep keeps. A seat change ends this replica's
// running turn `interrupted` (Coach engine §5), in the same write that clears the mark, so the account's record carries
// the end. Run on the account's replica as the sign-out begins; a Discard then takes the rest with the replica. It
// answers the picture ids removed.
export class ForgetCoachAtSignOut {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  /** @param {Reader} read */
  load(read) {
    const unsent = drawnMessages(read).filter((message) => message !== null && read.confirmed(CoachMessage, message.id) === null);
    const mark = Mark.read(read);
    const named = mark.turnId === null ? null : read.repository(CoachMessage).find(new Id(mark.turnId, CoachMessage), 'drawn');
    return { rows: Object.keys(read.devices(CoachPictureRow.prefix)), mark, markHeld: read.device(Mark.turnKey) !== null, moment: read.moment,
      running: named !== null && writersOwn(named, read.replica) ? named : null,
      named: new Set(unsent.flatMap((message) => message?.pictures ?? []).map((picture) => CoachPictureRow.key(picture.id))) };
  }

  /** @param {ReturnType<ForgetCoachAtSignOut['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    const forgotten = loaded.rows.filter((key) => !loaded.named.has(key));
    if (forgotten.length === 0 && !loaded.markHeld && !loaded.mark.roundRow) return Decision.unchanged(/** @type {string[]} */ ([]));
    const plan = new Plan();
    if (loaded.running !== null) EndTurn.write(plan, loaded.running, 'interrupted', loaded.running.text, loaded.running.truncated, loaded.moment);
    if (loaded.markHeld || loaded.mark.roundRow) loaded.mark.clear(plan);
    for (const key of forgotten) plan.device(key, null);
    return Decision.write(plan, forgotten.map((key) => key.slice(CoachPictureRow.prefix.length)));
  }
}
