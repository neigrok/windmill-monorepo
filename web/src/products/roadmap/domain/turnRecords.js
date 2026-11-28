// @ts-check
// What a Coach turn writes and reads in the person's `self/roadmap` beyond its opening, end and withdrawal
// (roadmap-coach.md §8, §9; Coach engine §5): the facts a turn records of its calls and direct writes, a round's mark,
// the answer's text as it streams, the mark read back and let go of, a turn nobody ends, what became of a receipt's
// write, a conversation's delete and History, the one list of every conversation.

import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';
import { ActDecision } from '../../../platform/domain-kit/acts.js';
import { Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Valid } from '../../../platform/domain-kit/validation.js';
import { precondition } from '../../../platform/domain-kit/values.js';
import { CoachMessage, CoachProposal, CoachThread, CoachWriteFate, CoachWriteFateValue, TurnMark } from './conversation.js';
import { RoadmapRefusals, RoadmapScopes, gone, writeIn } from './roadmapRules.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/acts.js').ActReader} ActReader */
/** @typedef {import('./conversation.js').CoachMessageValue} CoachMessageValue */
/** @typedef {import('./conversation.js').CoachThreadValue} CoachThreadValue */
/** @typedef {import('./conversation.js').CoachProposalValue} CoachProposalValue */

// Engine §11: a running Coach message no write has reached for this long, by the server's clock, is ended by any device.
export const TURN_STALE_MS = 1_800_000;

// A round's call id: 22 characters of unpadded base64url (Coach engine §4.2).
const CALL_ID = /^[A-Za-z0-9_-]{22}$/u;

// One call a turn made, as its Coach message records it (§9, INV-5): the ability, or `context` for what the turn was told
// before it asked anything; the roadmap it read or wrote; `ok` or the refusal code; and of a read, how many steps it
// answered and how many of them were done, the steps it named by id (at most 50) and the fields it asked for. Nothing of
// what it answered.
export class CoachCall {
  /**
   * @param {{ ability: string, treeId?: string | null, outcome?: string, steps?: number | null, done?: number | null,
   *   nodeIds?: readonly string[] | null, fields?: readonly string[] | null }} call
   */
  constructor({ ability, treeId = null, outcome = 'ok', steps = null, done = null, nodeIds = null, fields = null }) {
    precondition(nodeIds === null || nodeIds.length <= CoachCall.nodeIds, 'a call records at most 50 steps by id');
    this.ability = ability;
    this.treeId = treeId;
    this.outcome = outcome;
    this.steps = steps;
    this.done = done;
    this.nodeIds = nodeIds === null ? null : Object.freeze([...nodeIds]);
    this.fields = fields === null ? null : Object.freeze([...fields]);
    Object.freeze(this);
  }

  static nodeIds = 50;

  /** @returns {Json} */
  get json() {
    return { ability: this.ability, treeId: this.treeId, outcome: this.outcome, ...(this.steps === null ? {} : { steps: this.steps }),
      ...(this.done === null ? {} : { done: this.done }), ...(this.nodeIds === null ? {} : { nodeIds: [...this.nodeIds] }),
      ...(this.fields === null ? {} : { fields: [...this.fields] }) };
  }

  /** @param {any} json */
  static decode(json) {
    return new CoachCall({ ability: json.ability, treeId: json.treeId ?? null, outcome: json.outcome ?? 'ok', steps: json.steps ?? null, done: json.done ?? null,
      nodeIds: json.nodeIds ?? null, fields: json.fields ?? null });
  }
}

/** @typedef {'completed' | 'reset' | 'changed' | 'created' | 'linked'} ReceiptChange */

// D-4: one direct write as its Coach message records it, a fact and never a sentence: the ability, the roadmap and step it
// wrote, the step's label as it stood after the write, and what changed: a mark set or reset; the fields of the step changed
// (`label`, `description`, `links`) with the words of each item added to its checklist; a new step with the labels of the
// steps it follows; or a link, with the label of the step now followed.
export class CoachReceipt {
  /**
   * @param {{ ability: string, treeId: string, nodeId: string, label: string, change: ReceiptChange, fields?: readonly string[],
   *   items?: readonly string[], prerequisites?: readonly string[] }} receipt
   */
  constructor({ ability, treeId, nodeId, label, change, fields = [], items = [], prerequisites = [] }) {
    this.ability = ability;
    this.treeId = treeId;
    this.nodeId = nodeId;
    this.label = label;
    this.change = change;
    this.fields = Object.freeze([...fields]);
    this.items = Object.freeze([...items]);
    this.prerequisites = Object.freeze([...prerequisites]);
    Object.freeze(this);
  }

  /** @returns {Json} */
  get json() {
    return { ability: this.ability, treeId: this.treeId, nodeId: this.nodeId, label: this.label, change: this.change,
      ...(this.fields.length ? { fields: [...this.fields] } : {}), ...(this.items.length ? { items: [...this.items] } : {}),
      ...(this.prerequisites.length ? { prerequisites: [...this.prerequisites] } : {}) };
  }

  /** @param {any} json */
  static decode(json) {
    return new CoachReceipt({ ability: json.ability, treeId: json.treeId, nodeId: json.nodeId, label: json.label, change: json.change,
      fields: json.fields ?? [], items: json.items ?? [], prerequisites: json.prerequisites ?? [] });
  }
}

// A turn's mark as this device holds it: the Coach message the turn writes and the round in flight, `callId` null before
// the first. A row in any other shape is no mark.
export class RunningMark {
  /** @param {Id<CoachMessageValue>} message @param {string | null} callId @param {number} bytesBefore */
  constructor(message, callId, bytesBefore) {
    this.message = message;
    this.callId = callId;
    this.bytesBefore = bytesBefore;
    Object.freeze(this);
  }

  /** @returns {Json} */
  get json() { return { message: this.message.json, callId: this.callId, bytesBefore: this.bytesBefore }; }

  // The mark a row holds, or null for a row that is no mark.
  /** @param {string} key @param {any} value */
  static of(key, value) {
    const id = key.slice('runningTurn:'.length);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.keys(value).sort().join() !== 'bytesBefore,callId') return null;
    const { callId, bytesBefore } = value;
    if (!(callId === null || (typeof callId === 'string' && CALL_ID.test(callId)))) return null;
    if (!Number.isSafeInteger(bytesBefore) || bytesBefore < 0) return null;
    return new RunningMark(new Id(id, CoachMessage), callId, bytesBefore);
  }
}

// Coach's message while its writer has not ended it: this replica's, and running, or `interrupted` by another device
// while this device's mark names it.
/** @param {CoachMessageValue} message @param {string} replica @param {boolean} marked */
function writersOwn(message, replica, marked) {
  if (!message.isCoach || message.replica !== replica) return false;
  return message.state === 'running' || (message.state === 'interrupted' && marked);
}

// A write to a turn its writer can no longer make: another replica's, or ended.
/** @param {Id<CoachMessageValue>} message */
function turnFinal(message) {
  return ActDecision.refuse(RoadmapRefusals.ofRefused(new Refused('turn-final', message.ref, null, 'predicted')));
}

// Coach engine §5 step 3.2: a round begins, in one write: the text so far on Coach's message and the round's call and the
// bytes of text before it on the turn's mark.
export class BeginRound {
  /** @param {Id<CoachMessageValue>} message @param {{ callId: string, text: string }} round */
  constructor(message, { callId, text }) {
    precondition(CALL_ID.test(callId), 'a round is named by a call id of 22 characters');
    this.message = message;
    this.callId = callId;
    this.text = text;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  get bytesBefore() { return new TextEncoder().encode(this.text).length; }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => ({
      message: account.repository(CoachMessage).find(this.message, 'drawn'), mark: account.device(TurnMark.key(this.message)), replica: account.replica,
      moment: account.moment,
    }));
  }

  /** @param {ReturnType<BeginRound['load']>} loaded */
  decide({ message, mark, replica, moment }) {
    if (message === null || !message.isCoach) return gone(CoachMessage.type, this.message.record);
    if (mark === null || !writersOwn(message, replica, true)) return turnFinal(this.message);
    const row = { callId: this.callId, bytesBefore: this.bytesBefore };
    const held = /** @type {{ callId?: unknown, bytesBefore?: unknown }} */ (mark);
    const sameRow = held.callId === row.callId && held.bytesBefore === row.bytesBefore;
    if (sameRow && message.text === this.text) return ActDecision.unchanged(null);
    const plan = new Plan();
    if (message.text !== this.text) plan.update(new Valid(message.with({ text: this.text }), moment, ['text']), { fields: ['text'] });
    if (!sameRow) plan.device(TurnMark.key(this.message), row);
    return writeIn(RoadmapScopes.account, plan, null);
  }
}

// §8: the answer's text so far on Coach's message, while its writer has not ended the turn; a turn ended, or another
// replica's, takes nothing.
export class StreamTurnText {
  /** @param {Id<CoachMessageValue>} message @param {string} text */
  constructor(message, text) {
    this.message = message;
    this.text = text;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => ({
      message: account.repository(CoachMessage).find(this.message, 'drawn'), marked: account.device(TurnMark.key(this.message)) !== null,
      replica: account.replica, moment: account.moment,
    }));
  }

  /** @param {ReturnType<StreamTurnText['load']>} loaded */
  decide({ message, marked, replica, moment }) {
    if (message === null || !message.isCoach) return gone(CoachMessage.type, this.message.record);
    if (!writersOwn(message, replica, marked) || message.text === this.text) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.update(new Valid(message.with({ text: this.text }), moment, ['text']), { fields: ['text'] });
    return writeIn(RoadmapScopes.account, plan, null);
  }
}

// Coach engine §5, the process ends: every turn this device marks, in message id order, read back as its writer resumes
// it; a row that is no mark is let go of in the same write.
export class RecoverMark {
  constructor() {
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => ({ rows: account.devices('runningTurn:') }));
  }

  /** @param {ReturnType<RecoverMark['load']>} loaded */
  decide({ rows }) {
    const keys = Object.keys(rows).sort(compareText);
    const marks = keys.map((key) => RunningMark.of(key, rows[key])).filter((mark) => mark !== null);
    const malformed = keys.filter((key) => RunningMark.of(key, rows[key]) === null);
    const result = marks.map((mark) => mark.json);
    if (malformed.length === 0) return ActDecision.unchanged(result);
    const plan = new Plan();
    for (const key of malformed) plan.device(key, null);
    return writeIn(RoadmapScopes.account, plan, result);
  }
}

// A turn whose message is gone, as a conversation deleted on another device takes it: its mark is let go of.
export class ForgetRunningTurn {
  /** @param {Id<CoachMessageValue>} message */
  constructor(message) {
    this.message = message;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => ({ marked: account.device(TurnMark.key(this.message)) !== null }));
  }

  /** @param {ReturnType<ForgetRunningTurn['load']>} loaded */
  decide({ marked }) {
    if (!marked) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.device(TurnMark.key(this.message), null);
    return writeIn(RoadmapScopes.account, plan, null);
  }
}

// Coach engine §5, a turn nobody ends (R-5): a running Coach message that no write has reached for `TURN_STALE`, by the
// server's time of its last change and `serverNow`, the server's clock as this device's live sync connection measures it,
// takes `interrupted` and nothing else. A turn this device marks is its own to end. It answers whether it ended the turn.
export class InterruptStaleTurn {
  /** @param {Id<CoachMessageValue>} message @param {number} serverNow */
  constructor(message, serverNow) {
    this.message = message;
    this.serverNow = serverNow;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => {
      const confirmed = /** @type {any} */ (account.confirmed(CoachMessage, this.message));
      return { message: account.repository(CoachMessage).find(this.message, 'drawn'), marked: account.device(TurnMark.key(this.message)) !== null,
        changedAt: typeof confirmed?.ru === 'number' ? confirmed.ru : null, moment: account.moment };
    });
  }

  /** @param {ReturnType<InterruptStaleTurn['load']>} loaded */
  decide({ message, marked, changedAt, moment }) {
    if (message === null || !message.isCoach || message.state !== 'running' || marked || changedAt === null
      || this.serverNow - changedAt < TURN_STALE_MS) return ActDecision.unchanged(false);
    const plan = new Plan();
    plan.update(new Valid(message.with({ state: 'interrupted' }), moment, ['state']), { fields: ['state'] });
    return writeIn(RoadmapScopes.account, plan, true);
  }
}

// §6: what became of one receipt's write after its turn ended, so its receipt reads so on every device: undone, or refused
// by the server with its code. A receipt keeps one fate; the same one written again is unchanged, and a message with no
// such receipt, past its receipts or outside the registry's 0…5, is gone. It answers the fate's id.
export class RecordWriteFate {
  // The receipts a message can hold, one for each direct write a turn may make.
  static receipts = Object.freeze({ first: 0, last: 5 });

  /** @param {Id<CoachMessageValue>} message @param {{ receipt: number, fate: 'undone' | 'refused', code?: string | null }} fate */
  constructor(message, { receipt, fate, code = null }) {
    this.message = message;
    this.receipt = receipt;
    this.fate = fate;
    this.code = code;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => {
      const message = account.repository(CoachMessage).find(this.message, 'drawn');
      return { message, fates: message === null ? [] : account.repository(CoachWriteFate).children(this.message, 'messageId', 'drawn'), moment: account.moment };
    });
  }

  /** @param {ReturnType<RecordWriteFate['load']>} loaded @param {import('../../../platform/domain-kit/acts.js').ActIDSource} ids */
  decide({ message, fates, moment }, ids) {
    const { first, last } = RecordWriteFate.receipts;
    const held = Number.isInteger(this.receipt) && this.receipt >= first && this.receipt <= last && this.receipt < (message?.receipts ?? []).length;
    if (message === null || !message.isCoach || !held) return gone(CoachMessage.type, this.message.record);
    const kept = fates.filter((fate) => fate.receipt === this.receipt).sort((a, b) => Id.compare(a.id, b.id))[0];
    if (kept !== undefined) return ActDecision.unchanged(kept.id.record);
    const plan = new Plan();
    const id = ids.mint(CoachWriteFate);
    plan.create(new Valid(new CoachWriteFateValue(id, { messageId: this.message, receipt: this.receipt, fate: this.fate, code: this.code }), moment));
    return writeIn(RoadmapScopes.account, plan, id.record);
  }
}

// History's delete (board 11.7): a conversation and the proposals it minted go in one held write; its messages and their
// write fates are the server's consequence of the conversation's removal (engine A.1).
export class DeleteConversation {
  /** @param {Id<CoachThreadValue>} thread */
  constructor(thread) {
    this.thread = thread;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => ({
      thread: account.repository(CoachThread).find(this.thread, 'drawn'),
      proposals: account.repository(CoachProposal).all('drawn').filter((proposal) => proposal.threadId.equals(this.thread)),
    }));
  }

  /** @param {ReturnType<DeleteConversation['load']>} loaded */
  decide({ thread, proposals }) {
    if (thread === null) return gone(CoachThread.type, this.thread.record);
    const plan = new Plan();
    plan.remove(this.thread);
    for (const proposal of [...proposals].sort((a, b) => Id.compare(a.id, b.id))) plan.remove(proposal.id);
    return writeIn(RoadmapScopes.account, plan, null);
  }
}

// §9, board 11.7: every conversation the device draws, those about `current` first and then the rest, each newest first
// by the moment of its latest message, then by id; a conversation with no message last. Each row carries what it is about,
// its title, that moment, and the proposal it minted last, by birth, with its count of changes and its state.
export class CoachHistory {
  /**
   * @param {Reader} read
   * @param {string | null} current
   */
  static read(read, current) {
    const messages = read.repository(CoachMessage).all('drawn');
    const proposals = read.repository(CoachProposal);
    /** @param {CoachProposalValue} proposal */
    const born = (proposal) => proposals.record(proposal.id.record, 'drawn')?.born ?? Stamp.UNSET;
    const rows = read.repository(CoachThread).all('drawn').map((thread) => {
      const said = messages.filter((message) => message.threadId.equals(thread.id)).map((message) => message.at.ms);
      const minted = proposals.all('drawn').filter((proposal) => proposal.threadId.equals(thread.id))
        .sort((a, b) => Stamp.compare(born(b), born(a)) || compareText(String(b.id.record), String(a.id.record)))[0] ?? null;
      return { thread: thread.id.json, treeId: thread.treeId, stepId: thread.stepId, title: thread.title, at: said.length ? Math.max(...said) : null,
        proposal: minted === null ? null : { id: minted.id.json, changes: minted.changes.length, state: minted.state, undone: minted.undone } };
    });
    /** @param {typeof rows[number]} a @param {typeof rows[number]} b */
    const newest = (a, b) => (b.at ?? -1) - (a.at ?? -1) || compareText(String(a.thread), String(b.thread));
    const about = (/** @type {typeof rows[number]} */ row) => current !== null && row.treeId === current;
    return { current: rows.filter(about).sort(newest), other: rows.filter((row) => !about(row)).sort(newest) };
  }
}
