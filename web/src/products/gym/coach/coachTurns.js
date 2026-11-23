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
import { CoachPictureRow, DeleteConversation, EndTurn, ForgetCoachAtSignOut, ForgetPicture, ForgetRunningTurn, ForgetUnclaimedPictures,
  KeepPicture, Mark, OpenTurn, writersOwn } from '../domain/coach/turn.js';
import { Picture } from '../domain/coach/conversation.js';
import { deviceZone } from '../gymRuntime.js';
import { gymApi } from '../gymApi.js';
import { sharedHref } from '../log.js';
import { GymProfile } from './profile.js';
import { GymTurn, GymTurnHost } from './turnHost.js';
import { GymTurnTelemetry } from './turnTelemetry.js';

// Why a send could not go, in the access states of Coach engine §7, or this browser's own: the answer running in
// another tab, a question past its bound. `resetsAt` is when a cap the AI service named ends.
/** @typedef {{ state: 'offline' | 'busy' | 'allowance' | 'capacity' | 'sign-in' | 'update' | 'off' | 'did-not-answer' | 'too-long', period?: 'day' | 'month', resetsAt?: number | null }} TurnRefusal */

const DRAFT_KEY = 'windmill.gym.coach.draft';

// What one allowance or failure says to the lifter (Coach engine §7).
/** @param {{ source?: string, code: string | null, status?: number, allowance?: any }} failure @returns {TurnRefusal} */
export function refusalOf(failure) {
  const state = accessState(failure);
  if (state === 'allowance') return { state, resetsAt: failure.allowance?.resetsAt ?? null };
  if (state === 'capacity') return { state, period: failure.code === 'free_day_exhausted' ? 'day' : 'month', resetsAt: failure.allowance?.budgetResetsAt ?? null };
  return { state };
}

// The send as the lifter wrote it, kept while the browser holds the person's unsent work: the field's words, and the
// picture chosen for it while the page stays.
export const composerDrafts = {
  read() {
    try { return globalThis.localStorage?.getItem(DRAFT_KEY) ?? ''; } catch { return ''; }
  },
  write(text) {
    try {
      if (text) globalThis.localStorage?.setItem(DRAFT_KEY, text);
      else globalThis.localStorage?.removeItem(DRAFT_KEY);
    } catch { /* A browser that keeps nothing keeps the words on the screen alone. */ }
  },
};

// The browser's gym Coach: one per page, never bound to a screen. It admits a question, records it, and runs the turn on
// the Coach engine's `TurnRunner` with gym's host and profile, each model round a call to the AI service; it recovers or
// ends what a closed tab left running, and ends what a sign-out cuts off. The room reads its snapshot.
export class CoachTurns {
  constructor({ engine, ai, runtime = browserRuntime(), shares = shareDoor(), telemetry, profile = new GymProfile(),
    appBaseUrl = globalThis.location?.origin ?? '', zone = deviceZone, online = () => globalThis.navigator?.onLine !== false,
    now = () => performance.now(), drafts = composerDrafts, textEvery = 1000, timers = globalThis }) {
    this.engine = engine;
    this.profile = profile;
    this.catalog = profile.catalog;
    this.zone = zone;
    this.online = online;
    this.now = now;
    this.drafts = drafts;
    this.tells = telemetry ?? new GymTurnTelemetry({ catalog: this.catalog });
    this.host = new GymTurnHost({ engine, catalog: this.catalog, profile, shares, appBaseUrl, telemetry: this.tells, zone,
      newPictureId: () => runtime.newId(), now, timers, textEvery });
    this.ai = new Witnessed(ai);
    this.runner = new TurnRunner({ host: this.host, ai: this.ai, telemetry: this.tells, runtime });
    this.running = null;
    this.started = false;
    this.listeners = new Set();
    this.snapshot = Object.freeze({ turn: null, stopping: false, refusal: null, fault: null, withdrawn: null, allowance: null, live: null });
    this.host.subscribe(() => this.publish({ live: this.host.live }));
  }

  subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;

  publish(patch) {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) listener();
  }

  get replica() { return this.engine.activeReplica(); }
  get seat() { return { kind: 'bound', key: this.replica }; }

  // When the room first opens on this page: a turn a closed tab left in its last round is recovered, the pictures no
  // message claims go, and the allowance says whether a question could be asked.
  start() {
    if (this.started) return;
    this.started = true;
    this.settleLeft().catch((error) => this.tells.fault('storage', error));
    this.readAllowance();
  }

  async readAllowance() {
    const allowance = await this.ai.allowance({ use: GymProfile.name, version: GymProfile.version });
    if (allowance?.failure) return;
    this.publish({ allowance, refusal: allowance.code === 'ok' ? this.unlessCapped() : refusalOf({ code: allowance.code, allowance }) });
  }

  unlessCapped() { return ['allowance', 'capacity'].includes(this.snapshot.refusal?.state) ? null : this.snapshot.refusal; }

  // Coach engine §5, the process ends: the turn the mark names, while its writer has not ended it, is recovered when its
  // last round's answer can still be read, and ended `interrupted` otherwise; the engine decides which. A mark naming a
  // message that ended lets go of it, and so does one naming a message gone from a replica caught up with its log.
  async settleLeft({ recover = true } = {}) {
    if (this.running) return;
    const replica = this.replica;
    const runner = this.host.runnerOn(replica);
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
      const lease = new GymTurn({ thread: named.message.threadId, lifter: named.id, coach: named.id }, replica);
      this.launch({ lease, question: '', picture: null }, true);
    }
    await this.sweepPictures(runner);
  }

  async sweepPictures(runner = this.host.runnerOn(this.replica)) {
    const swept = await runner.run(new ForgetUnclaimedPictures());
    if (swept.kind === 'refused') this.tells.fault('refusal', new Error('picture sweep held by an unreadable message'));
  }

  // gym Coach on the AI service §4.1, in order: the turn it opened, or null with the reason in the snapshot and the draft
  // kept. A picture is `{ original, model }`, two `PictureCopy`s the room prepared.
  async send({ question, picture = null, thread = null }) {
    this.publish({ refusal: this.unlessCapped(), fault: null, withdrawn: null });
    if (this.running) return this.refusing({ state: 'busy' });
    if (this.snapshot.refusal) return this.refusing(this.snapshot.refusal);
    if (lengthIn('bytes', question) > CoachRules.maxQuestionBytes) return this.refusing({ state: 'too-long' });
    if (!this.online()) return this.refusing({ state: 'offline' });
    const replica = this.replica;
    const runner = this.host.runnerOn(replica);
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
    this.drafts.write('');
    this.launch({ lease: new GymTurn(turn, replica), question, picture }, false);
    return turn;
  }

  launch(live, recover) {
    live.started = this.now();
    this.running = live;
    this.host.prepare(live.lease);
    this.publish({ turn: live.lease.turn, stopping: false });
    const input = { turnId: live.lease.turnId, seat: this.seat, question: TextSpec.isBlank(live.question) ? '' : live.question };
    live.done = this.runner.run(input, this.profile.of('bound'), { recover })
      .then((end) => this.settled(end, live, recover), (error) => this.broke(error, live))
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
      if (recover) await this.settleLeft({ recover: false });
      return;
    }
    if (live.lease.withdrawn) {
      const refusal = failure ? refusalOf(failure) : { state: 'offline' };
      if (!recover) this.tells.asked(['allowance', 'capacity'].includes(refusal.state) ? 'capped' : refusal.state === 'offline' ? 'offline'
        : refusal.state === 'off' ? 'absent' : 'refused', durationMs);
      this.drafts.write(live.question);
      this.publish({ refusal, withdrawn: { question: live.question, picture: live.picture, thread: live.lease.threadStands ? live.lease.turn.thread : null } });
      return;
    }
    if (end.state === 'failed' && end.code === 'host-fault') {
      if (!recover) this.tells.asked('failed', durationMs);
      this.publish({ fault: 'no-answer' });
      return;
    }
    const refusal = end.state === 'failed' ? refusalOf(failure?.code === end.code ? failure : { source: 'engine', code: end.code }) : null;
    if (!recover) this.tells.asked({ completed: 'answered', stopped: 'cancelled', declined: 'refused' }[end.state] ?? 'failed', durationMs);
    this.publish({ refusal: refusal && refusal.state !== 'did-not-answer' ? refusal : this.unlessCapped() });
    if (failure?.allowance) this.publish({ allowance: failure.allowance });
  }

  // A run that rejected: the engine reported the host's fault once. A turn whose record the host opened and never handed
  // the engine is taken back, so no record stays running and the question returns to the field (finding: a host failure
  // before the lease).
  async broke(error, live) {
    if (!live.lease.opened && !live.lease.withdrawn) {
      try {
        await this.host.withdraw(live.lease);
        this.drafts.write(live.question);
        this.publish({ withdrawn: { question: live.question, picture: live.picture, thread: live.lease.threadStands ? live.lease.turn.thread : null } });
      } catch (withdrawing) {
        if (!(withdrawing instanceof HostUnavailable)) this.tells.fault('storage', withdrawing);
      }
    }
    this.tells.asked('failed', this.now() - live.started);
    this.publish({ fault: 'no-answer' });
  }

  // Coach engine §5: Stop takes effect before the next round or the next call; the round in flight is read to its end.
  stop() {
    if (!this.running) return;
    this.runner.stop();
    this.publish({ stopping: true });
  }

  // The seat is about to change (Coach engine §5): the running turn ends `interrupted` now, while the account's replica
  // still takes the write, before a sign-out sends what this browser holds, and the pass goes with the seat. Then what
  // Coach kept in the browser goes (gym Coach on the AI service §5): the mark, the pictures no unsent message names, and
  // the field's words.
  async seatWillChange() {
    try { await this.runner.seatWillChange(); }
    catch (error) { if (!(error instanceof HostUnavailable)) throw error; }
    await forgetCoachAtSignOut(this.engine);
    this.drafts.write('');
    this.publish({ refusal: null, fault: null, withdrawn: null, allowance: null });
  }

  // A conversation deleted from History, unless its turn is running on this page.
  async deleteConversation(thread) {
    if (this.running?.lease.turn.thread.equals(thread)) return false;
    const outcome = await this.host.runnerOn(this.replica).run(new DeleteConversation(thread));
    return outcome.kind !== 'refused';
  }

  forget(kind) { this.publish({ [kind]: null }); }

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

// The account's replica as a sign-out begins: the mark, a running turn of this replica ended `interrupted` in the same
// write, and every picture but those an unsent message names.
export async function forgetCoachAtSignOut(engine) {
  const host = new GymTurnHost({ engine, zone: deviceZone });
  await host.runnerOn(engine.activeReplica()).run(new ForgetCoachAtSignOut());
}

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

// The door the Share sheet calls (gym Coach on the AI service §4.3), answering as catalog/3 states each share's result.
export function shareDoor(api = gymApi, origin = globalThis.location?.origin ?? '') {
  return {
    async share(sessionId) {
      const made = await api.shareSession(sessionId);
      return { url: made.url || `${origin}/${sharedHref(made.token)}`, token: made.token, expiresAt: made.expiresAt };
    },
    async revoke(sessionId) {
      const ended = await api.revokeShare(sessionId);
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
    turns = new CoachTurns({ engine, ai: new AiClient({ transport: new HttpAiTransport({ base: API_BASE }) }) });
    pages.set(engine, turns);
  }
  return turns;
}

// The page's Coach as the seat changes, when one is running on it; otherwise what Coach kept goes all the same.
export async function coachSeatWillChange(engine) {
  const turns = pages.get(engine);
  if (turns) return turns.seatWillChange();
  await forgetCoachAtSignOut(engine);
  composerDrafts.write('');
}
