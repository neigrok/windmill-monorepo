const bytes = (text) => new TextEncoder().encode(text).length;
const endStates = new Set(['completed', 'declined', 'failed', 'stopped', 'interrupted']);

export class HostUnavailable extends Error {
  constructor(reason = 'gone') { super(reason); this.name = 'HostUnavailable'; this.reason = reason; }
}

export function validateProfile(profile) {
  const positive = (n) => Number.isSafeInteger(n) && n > 0;
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  if (!profile || !/^[a-z][a-z0-9.-]{0,63}$/.test(profile.name) || !positive(profile.version)
    || !Array.isArray(profile.system) || !profile.system.every((v) => typeof v === 'string')
    || !['large', 'medium', 'small'].includes(profile.model) || !['low', 'medium', 'high', 'xhigh', 'max'].includes(profile.effort)
    || !positive(profile.output?.maxTokens) || (profile.output.minTokens !== null && (!positive(profile.output.minTokens) || profile.output.minTokens > profile.output.maxTokens))
    || !positive(profile.limits?.modelCalls) || !['abilityCalls', 'writes'].every((key) => count(profile.limits?.[key]))
    || !['historyPrefix', 'contextPrefix', 'questionPrefix', 'emptyQuestion'].every((key) => typeof profile.firstContent?.[key] === 'string')
    || typeof profile.label !== 'string' || !Array.isArray(profile.tools) || !Array.isArray(profile.groups)
    || !profile.refusals || !Object.entries(profile.refusals).every(([code, sentence]) => /^[a-z][a-z0-9-]{0,63}$/.test(code) && typeof sentence === 'string')) throw new TypeError('invalid profile');
  const names = new Set();
  for (const tool of profile.tools) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name) || typeof tool.description !== 'string'
      || tool.input?.type !== 'object' || typeof tool.countsAsWrite !== 'boolean') throw new TypeError('invalid profile tool');
    names.add(tool.name);
  }
  const groups = new Set();
  for (const group of profile.groups) {
    if (typeof group.name !== 'string' || groups.has(group.name) || !count(group.maxSuccesses)
      || !Array.isArray(group.tools) || !group.tools.every((name) => names.has(name)) || typeof profile.refusals[group.code] !== 'string') throw new TypeError('invalid profile group');
    groups.add(group.name);
  }
  for (const code of ['not-offered', 'seat-required', 'invalid-input', 'coach-turn-volume', 'stopped']) {
    if (typeof profile.refusals[code] !== 'string') throw new TypeError('missing refusal');
  }
  return profile;
}

export function isStaleTurn({ state, serverUpdatedAt }, { syncLive, serverNow }) {
  return state === 'running' && syncLive === true && Number.isFinite(serverNow) && Number.isFinite(serverUpdatedAt)
    && serverNow - serverUpdatedAt >= 1_800_000;
}

export function accessState(failure) {
  const code = failure?.code;
  if (code === 'subject_exhausted') return 'allowance';
  if (['free_day_exhausted', 'free_month_exhausted'].includes(code)) return 'capacity';
  if (['concurrency_exhausted', 'rate_limited', 'busy', 'paused'].includes(code)) return 'busy';
  if (['unauthenticated', 'invalid_installation', 'device_bound'].includes(code)) return 'sign-in';
  if (code === 'client-update-required') return 'update';
  if (code === 'anonymous_ai_unavailable' || (failure?.source === 'pass' && failure.status === 404)) return 'off';
  if (failure?.source === 'transport' && code === null) return 'offline';
  return 'did-not-answer';
}

export class TurnRunner {
  constructor({ host, ai, telemetry, runtime }) {
    Object.assign(this, { host, ai, runtime });
    this.telemetry = Object.fromEntries(['turn', 'ability', 'failure'].map((name) => [name, (value) => {
      try { telemetry?.[name]?.(value); } catch { /* Observers cannot interrupt a write. */ }
    }]));
    this.active = null;
    this.barrier = Promise.resolve();
  }

  stop() { if (this.active) { this.active.stop = true; this.active.wait.abort(); } }

  async seatWillChange() {
    const turn = this.active;
    this.ai.clearPass();
    if (!turn) return;
    turn.seatChanged = true;
    turn.wait.abort();
    await this.barrier.catch(() => {});
    try { if (turn.lease && !turn.done) await this.finish(turn, 'interrupted'); }
    catch (error) {
      if (!(error instanceof HostUnavailable)) this.reportHostFailure(turn);
      throw error;
    }
    if (this.active === turn) this.active = null;
  }

  mutate(operation) {
    const next = this.barrier.then(operation);
    this.barrier = next.catch(() => {});
    return next;
  }

  async run(input, profile, { recover = false } = {}) {
    profile = structuredClone(validateProfile(profile));
    if (this.active) throw new Error('turn already active');
    if (!input || !['anon', 'bound'].includes(input.seat?.kind) || typeof input.seat.key !== 'string') throw new TypeError('invalid seat');
    const turn = { input, profile, text: '', start: this.runtime.now(), rounds: 0, abilities: 0, writes: 0, refusals: 0,
      groups: new Map(), identities: new Set(), wait: new AbortController(), stop: false, seatChanged: false, done: false, hostFailureReported: false };
    this.active = turn;
    try {
      return await this.runtime.withLock(input.turnId, { ifAvailable: recover }, async (acquired) => {
        if (!acquired) return null;
        if (turn.seatChanged) { turn.done = true; turn.end = null; this.report(turn, 'interrupted', null); return null; }
        if (recover) return await this.recover(turn);
        const opened = await this.mutate(() => this.host.open(input));
        turn.lease = opened.lease;
        if (turn.seatChanged) return await this.finish(turn, 'interrupted');
        const words = profile.firstContent;
        const parts = [];
        if (opened.history) parts.push({ text: words.historyPrefix + opened.history });
        for (const context of opened.context) if (context) parts.push({ text: words.contextPrefix + context });
        for (const picture of opened.pictures) parts.push({ image: { picture: picture.pictureId } });
        parts.push({ text: input.question ? words.questionPrefix + input.question : words.emptyQuestion });
        const messages = [{ role: 'user', parts }];
        for (let round = 0; round < profile.limits.modelCalls; round++) {
          if (turn.done) return turn.end;
          if (turn.stop) return await this.finish(turn, 'stopped');
          if (turn.seatChanged) return await this.finish(turn, 'interrupted');
          const callId = this.runtime.newId();
          const mark = { turnId: input.turnId, callId, textBytesBeforeRound: bytes(turn.text) };
          await this.mutate(() => this.host.beginRound(turn.lease, turn.text, mark));
          if (turn.done) return turn.end;
          if (turn.seatChanged) return await this.finish(turn, 'interrupted');
          if (turn.stop) return await this.finish(turn, 'stopped');
          turn.rounds++;
          const answer = await this.ai.text({ callId, request: { model: profile.model, system: profile.system,
            tools: profile.tools.map(({ name, description, input }) => ({ name, description, input })), messages,
            output: { ...profile.output, schema: null }, effort: profile.effort, cache: true }, pictures: opened.pictures,
            label: profile.label, use: profile.name, version: profile.version, signal: turn.wait.signal,
            onText: (delta) => this.append(turn, delta) });
          if (turn.done) return turn.end;
          if (turn.seatChanged) return await this.finish(turn, 'interrupted');
          if (answer.failure) {
            if (answer.failure.code === 'stopped') return await this.finish(turn, 'stopped');
            return await this.finish(turn, answer.failure.code === null ? 'interrupted' : 'failed', {
              code: answer.failure.code, withdraw: round === 0 && answer.failure.admission === 'none' });
          }
          if (answer.event === 'failed') return await this.finish(turn, 'failed', { code: answer.data.code });
          const { stop, message } = answer.data;
          if (stop === 'completed' || stop === 'truncated') return await this.finish(turn, 'completed', { truncated: stop === 'truncated' });
          if (stop === 'declined') return await this.finish(turn, 'declined');
          if (turn.stop) return await this.finish(turn, 'stopped');
          const calls = message.parts.filter((part) => part.toolCall).map((part) => part.toolCall);
          if (new Set(calls.map((call) => call.id)).size !== calls.length) {
            this.telemetry.failure('ai-call');
            return await this.finish(turn, 'failed', { code: 'invalid-answer' });
          }
          messages.push(message);
          const results = [];
          for (const call of calls) {
            if (turn.stop) return await this.finish(turn, 'stopped');
            if (turn.seatChanged) return await this.finish(turn, 'interrupted');
            const identity = `${callId}:${call.id}`;
            if (turn.identities.has(identity)) throw new Error('duplicate dispatch');
            turn.identities.add(identity);
            const tool = profile.tools.find((tool) => tool.name === call.name);
            let code = tool ? null : 'not-offered';
            if (!code) code = await this.host.check(turn.lease, 'seat', call);
            if (!code) code = await this.host.check(turn.lease, 'shape', call);
            if (!code) code = profile.groups.find((group) => group.tools.includes(call.name) && (turn.groups.get(group.name) ?? 0) >= group.maxSuccesses)?.code ?? null;
            if (!code && (turn.abilities >= profile.limits.abilityCalls || (tool.countsAsWrite && turn.writes >= profile.limits.writes))) code = 'coach-turn-volume';
            if (!code) code = await this.host.check(turn.lease, 'product', call);
            if (turn.done) return turn.end;
            if (turn.seatChanged) return await this.finish(turn, 'interrupted');
            if (!code && turn.stop) code = 'stopped';
            let outcome;
            if (code) {
              turn.refusals++;
              this.host.refused?.({ id: call.id, code });
              outcome = { ok: false, code };
            } else {
              outcome = await this.mutate(() => {
                if (turn.done || turn.seatChanged || turn.stop) return null;
                turn.abilities++;
                if (tool.countsAsWrite) turn.writes++;
                return this.host.execute(turn.lease, { turnId: input.turnId, callId, toolCallId: call.id }, call);
              });
              if (outcome === null) return await this.finish(turn, turn.seatChanged ? 'interrupted' : 'stopped');
              if (outcome.ok) for (const group of profile.groups) if (group.tools.includes(call.name)) turn.groups.set(group.name, (turn.groups.get(group.name) ?? 0) + 1);
            }
            const boundedCode = outcome.ok ? null : Object.hasOwn(profile.refusals, outcome.code) ? outcome.code : 'product-refused';
            this.telemetry.ability({ name: tool?.name ?? 'unoffered', outcome: outcome.ok ? 'ok' : 'refused', code: boundedCode });
            results.push({ id: call.id, content: outcome.ok ? outcome.content : JSON.stringify({ code: boundedCode, message: profile.refusals[boundedCode] ?? '' }), isError: !outcome.ok });
          }
          messages.push({ role: 'tool', results });
        }
        return await this.finish(turn, turn.stop ? 'stopped' : 'failed', { code: turn.stop ? null : 'model-call-limit' });
      });
    } catch (error) {
      if (error instanceof HostUnavailable) {
        if (!turn.done) { turn.done = true; turn.end = null; this.report(turn, 'interrupted', null); }
        return null;
      }
      this.reportHostFailure(turn);
      if (turn.lease && !turn.done) return await this.finish(turn, 'failed', { code: 'invalid-answer' });
      throw error;
    } finally { if (this.active === turn) this.active = null; }
  }

  async append(turn, delta) {
    if (turn.done || turn.seatChanged) return;
    turn.text += delta;
    await this.mutate(() => {
      if (turn.done || turn.seatChanged) return;
      return this.host.text(turn.lease, turn.text);
    });
  }

  async recover(turn) {
    const record = await this.mutate(() => this.host.recover(turn.input.turnId, turn.input.seat));
    if (!record || record.state !== 'running') return null;
    turn.lease = record.lease;
    turn.text = record.text;
    if (!record.mark.callId || turn.seatChanged) return await this.finish(turn, 'interrupted');
    const prefix = new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(record.text).slice(0, record.mark.textBytesBeforeRound));
    let first = true;
    const answer = await this.ai.result({ callId: record.mark.callId, use: turn.profile.name, version: turn.profile.version,
      signal: turn.wait.signal, onText: (delta) => { if (first) { turn.text = prefix; first = false; } return this.append(turn, delta); } });
    if (turn.done) return turn.end;
    if (turn.seatChanged || answer.failure) return await this.finish(turn, 'interrupted');
    if (answer.event === 'failed') return await this.finish(turn, 'failed', { code: answer.data.code });
    if (answer.data.stop === 'tool_calls') return await this.finish(turn, 'interrupted');
    return await this.finish(turn, answer.data.stop === 'declined' ? 'declined' : 'completed', { truncated: answer.data.stop === 'truncated' });
  }

  report(turn, state, code) {
    this.telemetry.turn({ state, seat: turn.input.seat.kind, code, rounds: turn.rounds, abilityCalls: turn.abilities,
      refusals: turn.refusals, answerBytes: bytes(turn.text), durationMs: Math.max(0, this.runtime.now() - turn.start) });
  }

  reportHostFailure(turn) {
    if (turn.hostFailureReported) return;
    turn.hostFailureReported = true;
    this.telemetry.failure('agent-host');
  }

  async finish(turn, state, { code = null, truncated = false, withdraw = false } = {}) {
    if (turn.done) return turn.end;
    if (!endStates.has(state)) throw new Error('invalid end state');
    const end = { state, text: turn.text, truncated, code };
    await this.mutate(async () => {
      if (turn.done) return;
      try {
        if (withdraw) await this.host.withdraw(turn.lease);
        else await this.host.end(turn.lease, end);
      } catch (error) {
        if (!(error instanceof HostUnavailable)) throw error;
        turn.done = true;
        turn.end = null;
        this.report(turn, 'interrupted', null);
        return;
      }
      turn.done = true;
      turn.end = end;
      this.report(turn, state, code);
    });
    return turn.end;
  }
}
