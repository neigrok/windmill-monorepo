import { lengthIn } from '../../../../../packages/api-contract/sync/reference/core/values.js';
import { AiClient } from '../../../platform/ai/client.js';
import { HttpAiTransport } from '../../../platform/ai/wire.js';
import { accessState, HostUnavailable, TurnRunner } from '../../../platform/agent/turn.js';
import { browserRuntime, secureCallId } from '../../../platform/agent/runtime.js';
import { Decision, decision } from '../../../platform/domain-kit/actions.js';
import { Id } from '../../../platform/domain-kit/entities.js';
import { TextSpec } from '../../../platform/domain-kit/values.js';
import { API_BASE } from '../../../shell/apiBase.js';
import { CoachMessage, CoachRules } from '../domain/coach/conversation.js';
import { CoachPictureRow, coachRowsAtSignOut, DeleteConversation, EndTurnAtSignOut, ForgetPicture, ForgetRunningTurn, ForgetUnclaimedPictures,
  InterruptStaleTurn, KeepPicture, Mark, OpenTurn, writersOwn } from '../domain/coach/turn.js';
import { Picture } from '../domain/coach/conversation.js';
import { deviceZone } from '../gymRuntime.js';
import { gymApi } from '../gymApi.js';
import { sharedHref } from '../log.js';
import { PictureRefused } from './pictures.js';
import { GymProfile } from './profile.js';
import { GymTurn, GymTurnHost } from './turnHost.js';
import { GymTurnTelemetry } from './turnTelemetry.js';

// Why a send could not go, in the access states of Coach engine §7, or this browser's own: the answer running in
// another tab, a question past its bound. `resetsAt` is when a cap the AI service named ends.
/** @typedef {{ state: 'offline' | 'busy' | 'allowance' | 'capacity' | 'sign-in' | 'update' | 'off' | 'did-not-answer' | 'too-long', period?: 'day' | 'month', resetsAt?: number | null }} TurnRefusal */


// What one allowance or failure says to the lifter (Coach engine §7).
/** @param {{ source?: string, code: string | null, status?: number, allowance?: any }} failure @returns {TurnRefusal} */
export function refusalOf(failure) {
  const state = accessState(failure);
  if (state === 'allowance') return { state, resetsAt: failure.allowance?.resetsAt ?? null };
  if (state === 'capacity') return { state, period: failure.code === 'free_day_exhausted' ? 'day' : 'month', resetsAt: failure.allowance?.budgetResetsAt ?? null };
  return { state };
}

// The browser's gym Coach: one per page, never bound to a screen. It admits a question, records it, and runs the turn on
// the Coach engine's `TurnRunner` with gym's host and profile, each model round a call to the AI service; it recovers or
// ends what a closed tab left running, and ends what a sign-out cuts off. The room reads its snapshot.
export class CoachTurns {
  constructor({ engine, ai, runtime = browserRuntime(), shares = shareDoor(), telemetry, profile = new GymProfile(),
    appBaseUrl = globalThis.location?.origin ?? '', zone = deviceZone, online = () => globalThis.navigator?.onLine !== false,
    now = () => performance.now(), textEvery = 1000, timers = globalThis }) {
    this.engine = engine;
    this.runtime = runtime;
    this.profile = profile;
    this.catalog = profile.catalog;
    this.zone = zone;
    this.timers = timers;
    this.online = online;
    this.now = now;
    // The field's words while the page stays, by the seat they were typed under: nothing of an unsent question is
    // written to the browser's storage, so a sign-out leaves none behind.
    this.drafts = new Map();
    this.tells = telemetry ?? new GymTurnTelemetry({ catalog: this.catalog });
    this.host = new GymTurnHost({ engine, catalog: this.catalog, profile, shares, appBaseUrl, telemetry: this.tells, zone,
      newPictureId: () => runtime.newId(), now, timers, textEvery });
    this.ai = new Witnessed(ai);
    this.runner = new TurnRunner({ host: this.host, ai: this.ai, telemetry: this.tells, runtime });
    this.running = null;
    this.started = false;
    this.sweep = null;
    this.listeners = new Set();
    this.seatHeld = this.seatKey();
    this.snapshot = Object.freeze({ ...EMPTY, seat: this.seatHeld });
    this.host.subscribe(() => this.publish({ live: this.host.live }));
    engine.observeEngine?.(() => { if (this.seatKey() !== this.seatHeld) this.leaveSeat(); });
  }

  // The seat the page draws: the engine's binding, which a sign-in in place changes and a re-identify keeps.
  seatKey() { return this.engine.activeBinding(); }

  // The account in this page changed under Coach: a sign-out or a sign-in in this tab or another, or a session that ended
  // elsewhere. Nothing of the seat that left stays in the page: its pass, its allowance, its refusal, the field's words,
  // a question taken back with its picture. A turn still running here ends with the seat, and the room starts Coach
  // afresh for the seat that came.
  leaveSeat() {
    this.seatHeld = this.seatKey();
    this.ai.clearPass();
    this.runner.seatWillChange().catch((error) => { if (!(error instanceof HostUnavailable)) this.tells.fault('storage', error); });
    this.drafts.clear();
    this.started = false;
    if (this.sweep !== null) this.timers.clearInterval(this.sweep);
    this.sweep = null;
    this.snapshot = Object.freeze({ ...EMPTY, seat: this.seatHeld });
    for (const listener of this.listeners) listener();
  }

  listen = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;

  publish(patch) {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) listener();
  }

  get binding() { return this.engine.activeBinding(); }

  draft() { return this.drafts.get(this.binding) ?? ''; }

  setDraft(text) {
    if (text) this.drafts.set(this.binding, text);
    else this.drafts.delete(this.binding);
    this.publish({ draft: text });
  }
  get seat() { return { kind: 'bound', key: this.binding }; }

  // When the room first opens on this page: a turn a closed tab left in its last round is recovered, the pictures no
  // message claims go, and the allowance says whether a question could be asked.
  start() {
    if (this.started) return;
    this.started = true;
    this.settleLeft().catch((error) => this.storageFault(error));
    this.readAllowance();
    const sweep = () => this.endStale().catch((error) => this.storageFault(error));
    sweep();
    this.sweep = this.timers.setInterval(sweep, 60_000);
    this.sweep?.unref?.();
  }

  // A turn nobody ends (Coach engine §5): a running Coach message no write has reached for thirty minutes, by the
  // server's clock as the live sync connection measures it, ends `interrupted`. A device whose sync is not live ends none.
  async endStale() {
    const { syncLive, serverNow } = this.engine.freshness(CoachMessage.scope);
    if (!syncLive || !Number.isFinite(serverNow)) return;
    const runner = this.host.runnerOn(this.binding);
    const running = runner.read(CoachMessage.scope, (read) => read.repository(CoachMessage).all('drawn')
      .filter((message) => message.isCoach && message.state === 'running').map((message) => message.id));
    for (const id of running) {
      if (this.running?.lease.turn.coach.equals(id)) continue;
      await runner.run(new InterruptStaleTurn(id, serverNow));
    }
  }

  async readAllowance() {
    const seat = this.seatHeld;
    const allowance = await this.ai.allowance({ use: GymProfile.name, version: GymProfile.version });
    if (allowance?.failure || seat !== this.seatHeld) return;
    this.publish({ allowance, refusal: allowance.code === 'ok' ? this.standing() : refusalOf({ code: allowance.code, allowance }) });
  }

  // What still stands between the person and a question once a new one is asked, the allowance reads open or a turn
  // answers: the seat's own state (Coach switched off, an update, a sign-in). A refusal that answered one question (busy,
  // offline, too long, no answer) or a cap the allowance has since lifted stands no longer.
  standing() { return SEAT_REFUSALS.has(this.snapshot.refusal?.state) ? this.snapshot.refusal : null; }

  // Coach engine §5, the process ends: the turn the mark names, while its writer has not ended it, is recovered when its
  // last round's answer can still be read, and ended `interrupted` otherwise; the engine decides which. A mark naming a
  // message that ended lets go of it, and so does one naming a message gone from a replica caught up with its log.
  async settleLeft({ recover = true } = {}) {
    return this.runtime.withLock(OPENING, { ifAvailable: false }, () => this.settleLeftOpen(recover));
  }

  async settleLeftOpen(recover) {
    if (this.running) return;
    const binding = this.binding;
    const runner = this.host.runnerOn(binding);
    const named = runner.read(CoachMessage.scope, (read) => {
      const mark = Mark.read(read);
      if (mark.turnId === null) return null;
      const id = new Id(mark.turnId, CoachMessage);
      const message = read.repository(CoachMessage).find(id, 'drawn');
      const caughtUp = read.firstPullComplete() && read.checkpoint().cleanSeq !== null;
      return { id, message, own: writersOwn(message, read.replica, mark), caughtUp };
    });
    if (named !== null && named.message === null && named.caughtUp) await runner.run(new ForgetRunningTurn(named.id));
    if (named !== null && named.message !== null && !named.own) await runner.run(new ForgetRunningTurn(named.id));
    if (named?.own && recover) {
      const lease = new GymTurn({ thread: named.message.threadId, lifter: named.id, coach: named.id }, binding);
      this.launch({ lease, question: '', picture: null }, true);
      await lease.held;
    }
    await this.sweepPictures(runner);
  }

  async sweepPictures(runner = this.host.runnerOn(this.binding)) {
    const swept = await runner.run(new ForgetUnclaimedPictures());
    if (swept.kind === 'refused') this.tells.fault('refusal', new Error('picture sweep held by an unreadable message'));
  }

  // gym Coach on the AI service §4.1, in order: the turn it opened, or null with the reason in the snapshot and the draft
  // kept. A picture is `{ original, model }`, two `PictureCopy`s the room prepared.
  async send({ question, picture = null, thread = null }) {
    this.publish({ refusal: this.standing(), fault: null, withdrawn: null });
    if (this.running) return this.refusing({ state: 'busy' });
    if (this.snapshot.refusal) return this.refusing(this.snapshot.refusal);
    if (lengthIn('bytes', question) > CoachRules.maxQuestionBytes) return this.refusing({ state: 'too-long' });
    if (!this.online()) return this.refusing({ state: 'offline' });
    return this.runtime.withLock(OPENING, { ifAvailable: false }, () => this.open(question, picture, thread));
  }

  // A browser opens one turn at a time across its tabs: the open's write and the engine taking the turn's own lock happen
  // under one lock, so another tab's recovery never meets a fresh turn before its lock is held.
  async open(question, picture, thread) {
    if (this.running) return this.refusing({ state: 'busy' });
    const binding = this.binding;
    const runner = this.host.runnerOn(binding);
    let turn;
    try {
      const row = picture && new CoachPictureRow(secureCallId(), picture.original, picture.model);
      if (row) await runner.run(new KeepPicture(row));
      const pictures = row ? [new Picture(row.id, row.model.mediaType, true)] : [];
      const opened = await runner.run(openAlone(new OpenTurn({ thread, question, pictures })));
      if (opened.kind === 'refused') {
        if (row) await runner.run(new ForgetPicture(row.id));
        return opened.refusal.kind === 'busy' ? this.refusing({ state: 'busy' }) : this.faulted('unsaved');
      }
      turn = opened.result;
    } catch (error) {
      if (error instanceof HostUnavailable) return this.faulted('account-changing');
      this.tells.fault('storage', error);
      return this.faulted('unsaved');
    }
    this.tells.started();
    this.setDraft('');
    const lease = new GymTurn(turn, binding);
    this.launch({ lease, question, picture }, false);
    await lease.held;
    return turn;
  }

  launch(live, recover) {
    live.started = this.now();
    live.seat = this.seatHeld;
    this.running = live;
    this.host.prepare(live.lease);
    this.publish({ turn: live.lease.turn, stopping: false });
    const input = { turnId: live.lease.turnId, seat: this.seat, question: TextSpec.isBlank(live.question) ? '' : live.question };
    const run = this.runner.run(input, this.profile.of('bound'), { recover });
    // A run that ends before the engine took the lease lets the open's lock go all the same.
    run.then(live.lease.hold, live.lease.hold);
    live.done = run
      .then((end) => this.settled(end, live, recover), (error) => this.broke(error, live, recover))
      .catch((error) => this.tells.fault('settle', error))
      .finally(() => {
        if (this.running === live) this.running = null;
        this.publish({ turn: this.running?.lease.turn ?? null, stopping: false });
      });
  }

  // How the engine's run came back, as the room will say it: a turn withdrawn returns to the field with what refused it; a
  // failed end says what failed it. A run that wrote no end is the seat change's, or the record's that went, to settle.
  async settled(end, live, recover) {
    const failure = this.ai.failure;
    this.ai.failure = null;
    const durationMs = this.now() - live.started;
    if (end === null) {
      // A run that wrote no end: the seat changed under it, or its conversation was deleted elsewhere.
      if (!recover) this.tells.asked(live.seat === this.seatHeld ? 'gone' : 'interrupted', durationMs);
      if (recover && live.seat === this.seatHeld) await this.settleLeft({ recover: false });
      return;
    }
    if (live.seat !== this.seatHeld) {
      if (!recover) this.tells.asked('interrupted', durationMs);
      return;
    }
    if (live.lease.withdrawn) {
      const refusal = failure ? refusalOf(failure) : { state: 'offline' };
      if (!recover) this.tells.asked(['allowance', 'capacity'].includes(refusal.state) ? 'capped' : refusal.state === 'offline' ? 'offline'
        : refusal.state === 'off' ? 'absent' : 'refused', durationMs);
      this.setDraft(live.question);
      this.publish({ refusal, withdrawn: { question: live.question, picture: live.picture, thread: live.lease.threadStands ? live.lease.turn.thread : null, from: live.lease.turn.thread } });
      return;
    }
    if (end.state === 'failed' && end.code === 'host-fault') {
      if (!recover) this.tells.asked('failed', durationMs);
      this.publish({ fault: 'no-answer' });
      return;
    }
    const refusal = end.state === 'failed' ? refusalOf(failure?.code === end.code ? failure : { source: 'engine', code: end.code }) : null;
    if (!recover) this.tells.asked({ completed: 'answered', stopped: 'cancelled', declined: 'refused', interrupted: 'interrupted' }[end.state] ?? 'failed', durationMs);
    this.publish({ refusal: refusal && refusal.state !== 'did-not-answer' ? refusal : this.standing() });
    if (failure?.allowance) this.publish({ allowance: failure.allowance });
  }

  // A run that rejected: the engine reported the host's fault once. A turn whose record the host opened and never handed
  // the engine is taken back, so no record stays running and the question returns to the field (finding: a host failure
  // before the lease).
  async broke(error, live, recover) {
    if (live.seat !== this.seatHeld) return;
    if (!live.lease.opened && !live.lease.withdrawn) {
      try {
        await this.host.withdraw(live.lease);
        this.setDraft(live.question);
        this.publish({ withdrawn: { question: live.question, picture: live.picture, thread: live.lease.threadStands ? live.lease.turn.thread : null, from: live.lease.turn.thread } });
      } catch (withdrawing) {
        if (!(withdrawing instanceof HostUnavailable)) this.tells.fault('storage', withdrawing);
      }
    }
    if (!recover) this.tells.asked('failed', this.now() - live.started);
    this.publish({ fault: 'no-answer' });
  }

  // A store that failed; a write refused because the seat changed under it is no failure.
  storageFault(error) {
    if (!(error instanceof HostUnavailable)) this.tells.fault('storage', error);
  }

  // Coach engine §5: Stop takes effect before the next round or the next call; the round in flight is read to its end.
  stop() {
    if (!this.running) return;
    this.runner.stop();
    this.publish({ stopping: true });
  }

  // A sign-out begins (Coach engine §5): the running turn ends `interrupted` now, while the account's replica still takes
  // the write, before the sign-out sends what this browser holds, and the pass goes with the seat. What else Coach kept
  // goes when the seat itself changes (`leaveSeat`) and, of the rows, when the sign-out finishes (`coachRowsToForget`).
  async seatWillChange() {
    try { await this.runner.seatWillChange(); }
    catch (error) { if (!(error instanceof HostUnavailable)) throw error; }
  }

  // A conversation deleted from History, unless its turn is running on this page, which refuses it. Each delete is told;
  // a store that failed is reported, and the refusal or the failure leaves the conversation where it was.
  async deleteConversation(thread) {
    if (this.running?.lease.turn.thread.equals(thread)) {
      this.tells.deleted('answering');
      throw new Error('a conversation answering here stays');
    }
    let outcome;
    try { outcome = await this.host.runnerOn(this.binding).run(new DeleteConversation(thread)); }
    catch (error) {
      this.tells.deleted('failed');
      this.storageFault(error);
      throw error;
    }
    this.tells.deleted(outcome.kind === 'refused' ? 'refused' : 'deleted');
    if (outcome.kind === 'refused') throw new Error('the store refused the conversation\'s delete');
  }

  forget(kind) { this.publish({ [kind]: null }); }

  // A picture the browser could not prepare: said in the room, told, and reported when it was no picture the browser
  // refuses to read.
  pictureFailed(error) {
    this.tells.picture('failed');
    if (!(error instanceof PictureRefused)) this.tells.fault('picture', error);
    this.publish({ fault: 'picture' });
  }

  refusing(refusal) {
    this.tells.asked(refusal.state === 'offline' ? 'offline' : ['allowance', 'capacity'].includes(refusal.state) ? 'capped' : 'refused');
    this.publish({ refusal });
    return null;
  }

  faulted(fault) {
    this.tells.asked(fault === 'unsaved' ? 'failed' : 'refused');
    this.publish({ fault });
    return null;
  }
}

const OPENING = 'gym-opening';
const SEAT_REFUSALS = new Set(['off', 'update', 'sign-in']);
const EMPTY = Object.freeze({ draft: '', turn: null, stopping: false, refusal: null, fault: null, withdrawn: null, allowance: null, live: null });

// The account's replica, read and written as Coach's turns are, with no page Coach to run them.
function replicaRunner(engine) { return new GymTurnHost({ engine, zone: deviceZone }).runnerOn(engine.activeBinding()); }

// The open, refused as busy while the browser's mark names a turn its writer has not ended: one gym turn at a time
// across a browser's tabs (gym Coach on the AI service §5).
function openAlone(open) {
  return {
    scope: open.scope,
    refusals: open.refusals,
    load: (read) => {
      const mark = Mark.read(read);
      const named = mark.turnId === null ? null : read.repository(CoachMessage).find(new Id(mark.turnId, CoachMessage), 'drawn');
      return { open: open.load(read), busy: named !== null && named.state === 'running' && writersOwn(named, read.replica, mark) };
    },
    decide: (loaded, ids) => (loaded.busy ? Decision.refuse({ kind: 'busy' }) : decision(open, loaded.open, ids)),
  };
}

// The AI client the engine calls, which remembers the last failure it answered: the allowance a refusal carries, which
// says what holds a request and when a cap ends, is the product's to read, never the engine's.
class Witnessed {
  constructor(client) {
    this.client = client;
    this.failure = null;
  }

  connected() { return this.client.connected(); }
  clearPass() { this.client.clearPass(); }
  allowance(options) { return this.client.allowance(options); }
  async text(options) { return this.witnessed(await this.client.text(options)); }
  async result(options) { return this.witnessed(await this.client.result(options)); }

  witnessed(answer) {
    this.failure = answer.failure ?? (answer.event === 'failed'
      ? { source: 'text', code: answer.data.code, admission: 'admitted', allowance: answer.data.allowance } : null);
    return answer;
  }
}

// The door the Share sheet calls (gym Coach on the AI service §4.3), answering as catalog/3 states each share's result. A
// door that has not answered in fifteen seconds is a door the browser could not reach, so a sign-out never waits on one.
export function shareDoor(api = gymApi, origin = globalThis.location?.origin ?? '', timers = globalThis, waitMs = 15_000) {
  const bounded = (call) => new Promise((resolve, reject) => {
    const timer = timers.setTimeout(() => reject(Object.assign(new Error('share door timed out'), { name: 'TimeoutError' })), waitMs);
    call.then(resolve, reject).finally(() => timers.clearTimeout(timer));
  });
  return {
    async share(sessionId) {
      const made = await bounded(api.shareSession(sessionId));
      return { url: made.url || `${origin}/${sharedHref(made.token)}`, token: made.token, expiresAt: made.expiresAt };
    },
    async revoke(sessionId) {
      const ended = await bounded(api.revokeShare(sessionId));
      if (ended === null) throw Object.assign(new Error('no share'), { status: 404 });
      return { revoked: true, sessionId };
    },
  };
}

// The page's one gym Coach over the shell's sync engine.
const pages = new WeakMap();
export function coachTurnsOf(engine) {
  let turns = pages.get(engine);
  if (!turns) {
    const tells = new GymTurnTelemetry({ catalog: new GymProfile().catalog });
    turns = new CoachTurns({ engine, telemetry: tells, ai: new AiClient({ transport: new HttpAiTransport({ base: API_BASE }), telemetry: tells }) });
    pages.set(engine, turns);
  }
  return turns;
}

// A sign-out begins: the page's Coach ends the turn it runs, or, with none running here, the turn the mark names ends as
// its record holds it.
export async function coachSeatWillChange(engine) {
  const turns = pages.get(engine);
  if (turns?.running) return turns.seatWillChange();
  await replicaRunner(engine).run(new EndTurnAtSignOut());
}

// A sign-out is decided: the rows Coach keeps on the account's replica that the finished sign-out takes with it.
export function coachRowsToForget(engine) {
  return replicaRunner(engine).read(CoachMessage.scope, coachRowsAtSignOut);
}
