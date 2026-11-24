import { jcsBytes } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { JsonSchema } from '../../../platform/domain-kit/abilities.js';
import { Id } from '../../../platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../platform/domain-kit/runner.js';
import { ReplicaChanged } from '../../../platform/sync/engine.js';
import { HostUnavailable } from '../../../platform/agent/turn.js';
import { AbilityRefusals, CoachMessage, CoachThread, CoachTurnBounds, Conversation } from '../domain/coach/conversation.js';
import { AbilityRequest, RecordShareCall, RunAbility, SERVER_RUN } from '../domain/coach/runAbility.js';
import { BeginRound, CoachPictureRow, EndTurn, ForgetRunningTurn, RecoverMark, StreamTurnText, WithdrawTurn, writersOwn } from '../domain/coach/turn.js';
import { LogRead } from '../domain/coach/abilityReads.js';
import { TrainingLog } from '../domain/trainingReads.js';

// A call the turn makes of itself at its opening, before the model has asked for anything (gym Coach on the AI service §4.1).
export const CONTEXT_CALL_PREFIX = 'context-';

// Each context read as catalog/3 asks for it: the newest page, every routine.
const CONTEXT_INPUTS = Object.freeze({
  list_sessions: { before: null, beforeId: null, limit: LogRead.defaultPage },
  list_notes: {},
  list_exercises: {},
  list_routines: { routineId: null },
});

// A refusal of the turn's own record that is not the record gone or ended: a defect of this browser's turn, which the
// engine reports once, with this error, and ends `host-fault`.
export class TurnRecordRefused extends Error {
  constructor(code) { super(`the turn's record refused its own write: ${code}`); this.name = 'TurnRecordRefused'; this.code = code; }
}

// One turn's records and the replica it opened on: the engine's lease. Every write runs on that replica alone, so a
// write that outlives a change of account lands on no other.
export class GymTurn {
  /** @param {import('../domain/coach/turn.js').Turn} turn @param {string} replica */
  constructor(turn, replica) {
    this.turn = turn;
    this.replica = replica;
    this.turnId = /** @type {string} */ (turn.coach.record);
    this.opened = false;
    this.withdrawn = false;
    this.threadStands = true;
    this.committedText = '';
    this.committedAt = Number.NEGATIVE_INFINITY;
    this.trailing = null;
    // Resolved once the engine holds the turn's lock and has taken this lease, or the run ended without it.
    this.held = new Promise((resolve) => { this.hold = resolve; });
  }
}

// What gym does in a turn the engine runs (gym Coach on the AI service §4): it opens with the context reads, the history
// and the pictures; runs every call through the replica executor, or a share through the Share door; writes the text at
// the web's pace and the mark at each round; and ends, withdraws or recovers the turn, each in one local write on the
// turn's replica.
export class GymTurnHost {
  constructor({ engine, catalog, profile, shares, appBaseUrl, telemetry, zone, newPictureId, now = () => performance.now(),
    timers = globalThis, textEvery = 1000 }) {
    Object.assign(this, { engine, catalog, profile, shares, appBaseUrl, telemetry, zone, newPictureId, now, timers, textEvery });
    this.next = null;
    this.live = null;
    this.listeners = new Set();
  }

  // The turn the engine opens or recovers next under this id: written by the send that admitted it, or named by the mark
  // a closed tab left.
  prepare(lease) { this.next = lease; }

  // What the room draws on the running message at every delta, ahead of what its record holds.
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  answering(live) {
    this.live = live;
    for (const listener of this.listeners) listener();
  }

  // A write the engine refuses because the seat moved while it waited (`ReplicaChanged`) is the turn's seat ending too.
  runnerOn(replica) {
    const port = new EngineReplica(this.engine);
    const onSeat = (views) => { if (views.replica !== replica) throw new HostUnavailable('seat'); return views; };
    return new ActionRunner({
      commit: (scope, body) => port.commit(scope, (views) => body(onSeat(views))).catch((error) => {
        throw error instanceof ReplicaChanged ? new HostUnavailable('seat') : error;
      }),
      read: (scope) => onSeat(port.read(scope)),
      cancelHeld: (id) => port.cancelHeld(id),
      mintId: (type, taken) => port.mintId(type, taken),
      opaqueID: () => port.opaqueID(),
      physNow: () => port.physNow(),
      dismissNotice: (id) => port.dismissNotice(id),
    }, this.engine.registry, this.zone);
  }

  // A refusal of the turn's own record is no outcome of any call: it ends the turn. Gone, a conversation deleted on
  // another device took it, and the mark lets go of it; ended, this browser already wrote its end; anything else is a
  // defect.
  async answered(outcome, runner, lease) {
    if (outcome.kind !== 'refused') return outcome.result;
    const refusal = outcome.refusal;
    const code = refusal.refused?.code ?? refusal.kind;
    if (refusal.kind === 'gone' || code === 'unknown-record' || code === 'record-dead') {
      await runner.run(new ForgetRunningTurn(lease.turn.coach));
      throw new HostUnavailable('gone');
    }
    if (code === 'message-final') throw new HostUnavailable('ended');
    throw new TurnRecordRefused(code);
  }

  async run(lease, action) {
    const runner = this.runnerOn(lease.replica);
    return this.answered(await runner.run(action), runner, lease);
  }

  async ability(lease, request) {
    return this.run(lease, new RunAbility(request, lease.turn.coach, 'bound', this.catalog, this.appBaseUrl));
  }

  async open(input) {
    const lease = this.next?.turnId === input.turnId ? this.next : null;
    this.next = null;
    if (lease === null) throw new HostUnavailable('gone');
    lease.hold();
    this.answering({ message: lease.turn.coach, text: '' });
    const runner = this.runnerOn(lease.replica);
    const workout = runner.read(CoachMessage.scope, (read) => new TrainingLog(read).open?.id ?? null);
    const reads = [...Object.entries(CONTEXT_INPUTS), ...(workout ? [['get_session', { sessionId: workout.json, review: false }]] : [])];
    const context = [];
    let bytes = 0;
    for (const [name, request] of reads) {
      const answered = await this.ability(lease, new AbilityRequest(CONTEXT_CALL_PREFIX + name, name, request));
      this.telemetry.ability({ name, outcome: answered.kind === 'result' ? 'ok' : 'refused', code: answered.kind === 'result' ? null : answered.code });
      if (answered.kind !== 'result' || bytes + answered.jcs.length > CoachTurnBounds.contextReadBytes) continue;
      bytes += answered.jcs.length;
      context.push(this.profile.context(name, answered.jcs));
    }
    const { history, rows } = runner.read(CoachMessage.scope, (read) => {
      const conversation = new Conversation(read.repository(CoachMessage).children(lease.turn.thread, 'threadId', 'drawn'));
      return { history: conversation.history(lease.turn.coach),
        rows: conversation.contextPictures(lease.turn.lifter).map((picture) => CoachPictureRow.decode(picture.id, read.device(CoachPictureRow.key(picture.id)))) };
    });
    // The AI service holds a picture for the turn under an id this turn mints, so each turn uploads its pictures once.
    const pictures = rows.filter((row) => row !== null).map((row) => ({ pictureId: this.newPictureId(), mediaType: row.model.mediaType,
      bytes: Uint8Array.from(atob(row.model.data), (character) => character.charCodeAt(0)) }));
    lease.opened = true;
    return { lease, history: this.profile.history(history), context, pictures };
  }

  // Coach engine §5, the process ends: the turn the mark names, while its writer has not ended it, with the round the
  // mark holds. A stale or malformed round row is cleared on the way.
  async recover(turnId) {
    const lease = this.next?.turnId === turnId ? this.next : null;
    this.next = null;
    if (lease === null) return null;
    lease.hold();
    const runner = this.runnerOn(lease.replica);
    const read = await runner.run(new RecoverMark());
    if (read.kind === 'refused' || read.result.turnId !== turnId) return null;
    const mark = read.result;
    const found = runner.read(CoachMessage.scope, (reader) => {
      const message = reader.repository(CoachMessage).find(new Id(turnId, CoachMessage), 'drawn');
      return message && { message, own: writersOwn(message, reader.replica, mark) };
    });
    if (!found) return null;
    lease.opened = true;
    lease.committedText = found.message.text;
    const state = found.own ? 'running' : found.message.state;
    if (state === 'running') this.answering({ message: found.message.id, text: found.message.text });
    return { lease, state, text: found.message.text, mark: { turnId, callId: mark.callId, textBytesBeforeRound: mark.textBytesBeforeRound } };
  }

  async beginRound(lease, text, mark) {
    await this.commit(lease, text);
    await this.run(lease, new BeginRound(lease.turn.coach, mark.callId, mark.textBytesBeforeRound));
  }

  // The room draws every delta; the record takes the words about once a second (gym Coach on the AI service §4.4), and the
  // words a pause leaves when that second comes round.
  async text(lease, text) {
    this.answering({ message: lease.turn.coach, text });
    const wait = lease.committedAt + this.textEvery - this.now();
    if (wait <= 0) return this.commit(lease, text);
    if (lease.trailing !== null) return undefined;
    lease.trailing = this.timers.setTimeout(() => {
      lease.trailing = null;
      const live = this.live?.message.equals(lease.turn.coach) ? this.live.text : null;
      if (live === null) return;
      this.commit(lease, live).catch((error) => {
        if (!(error instanceof HostUnavailable)) this.telemetry.fault('storage', error);
      });
    }, wait);
    return undefined;
  }

  async commit(lease, text) {
    lease.committedAt = this.now();
    if (text === lease.committedText) return;
    await this.run(lease, new StreamTurnText(lease.turn.coach, text));
    lease.committedText = text;
  }

  async check(lease, rule, call) {
    const ability = this.catalog.ability(call.name);
    if (ability === null) return AbilityRefusals.notOffered;
    if (rule === 'seat') return ability.admits('bound') ? null : AbilityRefusals.seatRequired;
    if (rule === 'shape') return new JsonSchema(ability.input).fault(call.input) === null ? null : AbilityRefusals.invalidInput;
    return null;
  }

  async execute(lease, identity, call) {
    const request = new AbilityRequest(call.id, call.name, call.input);
    const outcome = SERVER_RUN.includes(call.name) ? await this.share(lease, request) : await this.ability(lease, request);
    if (outcome.kind === 'result') return { ok: true, content: new TextDecoder().decode(outcome.jcs) };
    return { ok: false, code: outcome.code };
  }

  // §4.3: a share is the server's record, made through the door the Share sheet calls. The door answers one refusal for a
  // workout it does not know and one with no share, and the model reads that one code; a door this browser could not
  // reach is the same refusal, and a fault of the server's or this browser's is reported.
  async share(lease, request) {
    const sessionId = /** @type {string} */ (request.input.sessionId);
    let outcome;
    try {
      const answer = request.name === 'share_session'
        ? await this.shares.share(sessionId) : await this.shares.revoke(sessionId);
      outcome = { kind: 'result', jcs: jcsBytes(answer) };
    } catch (error) {
      const expected = (error?.status >= 400 && error?.status < 500) || error?.name === 'TypeError' || error?.name === 'AbortError';
      if (!expected) this.telemetry.fault('share', error);
      outcome = { kind: 'refused', code: AbilityRefusals.refused };
    }
    return this.run(lease, new RecordShareCall(request, lease.turn.coach, outcome));
  }

  async end(lease, end) {
    this.stopTrailing(lease);
    try {
      await this.run(lease, new EndTurn(lease.turn.coach, end.state, end.text, end.truncated));
    } finally {
      if (this.live?.message.equals(lease.turn.coach)) this.answering(null);
    }
  }

  async withdraw(lease) {
    this.stopTrailing(lease);
    lease.withdrawn = true;
    try {
      const runner = this.runnerOn(lease.replica);
      await this.answered(await runner.run(new WithdrawTurn(lease.turn)), runner, lease);
      lease.threadStands = runner.read(CoachMessage.scope, (read) => read.repository(CoachThread).find(lease.turn.thread, 'drawn') !== null);
    } finally {
      if (this.live?.message.equals(lease.turn.coach)) this.answering(null);
    }
  }

  stopTrailing(lease) {
    if (lease.trailing === null) return;
    this.timers.clearTimeout(lease.trailing);
    lease.trailing = null;
  }
}
