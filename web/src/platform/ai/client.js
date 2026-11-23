import { waitFor } from '../agent/runtime.js';
import { validateEvent, validateAllowance, validateRefusal, validatePassRefusal, TransportFailure } from './wire.js';
import { captureError } from '../../telemetry/sentry.js';

const TRANSIENT = new Set(['busy', 'paused', 'rate_limited', 'concurrency_exhausted', 'accounting_unavailable', 'provider_unavailable']);
const DEFECTS = new Set(['invalid_request', 'too_large', 'provider_rejected', 'funding_required', 'conflict', 'call_unknown', 'invalid-answer', 'untrusted-origin', 'unsupported-media-type']);
const uncertain = new Set(['busy', 'accounting_unavailable']);
const AFTER_LOSS = new Set(['rate_limited', 'busy', 'accounting_unavailable']);

async function untilStopped(signal, operation) {
  if (!signal) return await operation();
  if (signal.aborted) throw new TransportFailure('stopped');
  let stop;
  const stopped = new Promise((resolve, reject) => {
    stop = () => reject(new TransportFailure('stopped'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([stopped, Promise.resolve().then(() => {
      if (signal.aborted) throw new TransportFailure('stopped');
      return operation();
    })]);
  } finally { signal.removeEventListener('abort', stop); }
}

export class AiClient {
  constructor({ transport, telemetry, now = () => performance.now(), wait = waitFor, connected = () => globalThis.navigator?.onLine !== false, client = 'web' }) {
    Object.assign(this, { transport, now, wait, connected, client });
    this.telemetry = { failure: (operation) => {
      try {
        if (telemetry) telemetry.failure(operation);
        else captureError('ai', operation, '', '/coach');
      } catch { /* Reporting cannot interrupt the call. */ }
    } };
    this.generation = 0;
    this.pass = null;
    this.passTask = null;
    this.uploads = new Set();
  }

  clearPass() { this.generation++; this.pass = null; this.passTask = null; this.uploads.clear(); }

  async credential(use, version, generation, force = false, signal) {
    if (generation !== this.generation) throw new TransportFailure('seat-changed');
    if (signal?.aborted) throw new TransportFailure('stopped');
    if (!force && this.pass?.use === use && this.pass?.version === version && this.pass.until - this.now() >= 60_000) return this.pass.value;
    const key = `${generation}:${use}:${version}`;
    if (!force && this.passTask?.key === key && this.passTask.signal === signal) return this.passTask.promise;
    const promise = (async () => {
      let response;
      try { response = await this.transport.pass({ client: this.client, use, version }, { signal }); }
      catch (error) {
        if (generation !== this.generation) throw new TransportFailure('seat-changed');
        if (signal?.aborted || error?.code === 'stopped') throw new TransportFailure('stopped');
        if (error instanceof TransportFailure && ['offline', 'lost'].includes(error.code))
          return { failure: { source: 'transport', code: null, admission: 'none', allowance: null } };
        this.telemetry.failure('ai-pass');
        return { failure: { source: 'pass', code: null, admission: 'none', allowance: null } };
      }
      if (generation !== this.generation) throw new TransportFailure('seat-changed');
      if (signal?.aborted) throw new TransportFailure('stopped');
      if (response.status !== 200) {
        if (response.status === 404) return { failure: { source: 'pass', code: 'anonymous_ai_unavailable', admission: 'none', allowance: null } };
        // The door answered, so this is no lost connection: a body that is no refusal it knows says only that it did not answer.
        try { validatePassRefusal(response.body, response.status); }
        catch { return { failure: { source: 'pass', code: null, admission: 'none', allowance: null } }; }
        const code = response.body.code;
        if (DEFECTS.has(code)) this.telemetry.failure('ai-pass');
        return { failure: { source: 'pass', code, admission: 'none', allowance: null } };
      }
      if (typeof response.body?.pass !== 'string' || !response.body.pass || !Number.isSafeInteger(response.body.expiresIn) || response.body.expiresIn <= 0) {
        this.telemetry.failure('ai-pass');
        return { failure: { source: 'pass', code: 'invalid-answer', admission: 'none', allowance: null } };
      }
      this.pass = { value: response.body.pass, until: this.now() + response.body.expiresIn, use, version };
      return this.pass.value;
    })();
    this.passTask = { key, promise, signal };
    try { return await promise; }
    finally { if (this.passTask?.promise === promise) this.passTask = null; }
  }

  text(options) { return this.operation({ ...options, recover: false }); }
  result(options) { return this.operation({ ...options, recover: true }); }

  async allowance({ use, version }) {
    const generation = this.generation;
    try {
      let refreshed = false;
      while (true) {
        const pass = await this.credential(use, version, generation, refreshed);
        if (pass.failure) return pass;
        const response = await this.transport.request({ method: 'GET', path: '/v1/allowance', pass });
        if (generation !== this.generation) return { failure: { source: 'pass', code: null, admission: 'none', allowance: null } };
        if (response.status === 200) { validateAllowance(response.body); return response.body; }
        validateRefusal(response.body, response.status);
        if (response.body?.code === 'pass_expired' && !refreshed) { refreshed = true; continue; }
        return this.failure('text', response.body?.code ?? 'invalid-answer', 'none', response.body?.allowance ?? null);
      }
    } catch (error) {
      if (error instanceof TransportFailure && error.code === 'seat-changed')
        return { failure: { source: 'pass', code: null, admission: 'none', allowance: null } };
      return this.failure(error instanceof TransportFailure && error.code !== 'invalid-answer' ? 'transport' : 'wire', error instanceof TransportFailure && ['offline', 'lost'].includes(error.code) ? null : 'invalid-answer', 'none');
    }
  }

  failure(source, code, admission, allowance = null) {
    if (DEFECTS.has(code) || code?.startsWith('pass_') || code === 'picture_gone' || (source === 'transport' && code !== null)) this.telemetry.failure('ai-call');
    return { failure: { source, code, admission, allowance } };
  }

  async operation({ callId, request, pictures = [], label, use, version, signal, onText, recover }) {
    const generation = this.generation;
    const body = request === undefined ? undefined : JSON.stringify(request);
    let started = recover ? this.now() : null;
    let admission = recover ? 'admitted' : 'none';
    let uncertainDispatch = recover;
    let cursor = 0;
    let retry = 0;
    let refresh = false;
    let pictureRepair = false;
    let forcePass = false;
    let lastFailure = null;
    let retryDeadline = null;
    let callbackFailure;
    const promote = (value) => { if (['none', 'possible', 'admitted'].indexOf(value) > ['none', 'possible', 'admitted'].indexOf(admission)) admission = value; };
    const failed = (source, code, allowance = null) => recover && code === 'call_unknown'
      ? { failure: { source, code, admission, allowance } } : this.failure(source, code, admission, allowance);
    const deadlineFailure = () => {
      const now = this.now();
      if (started !== null && now >= started + 1_200_000) return failed('result', 'answer-timeout');
      if (retry > 0 && now >= retryDeadline) return lastFailure;
      return null;
    };
    operation: while (true) {
      if (generation !== this.generation) return { failure: { source: 'pass', code: null, admission, allowance: null } };
      if (signal?.aborted) return { failure: { source: 'result', code: 'stopped', admission, allowance: null } };
      const expired = deadlineFailure();
      if (expired) return expired;
      let preparation = true;
      let response;
      try {
        const pass = await untilStopped(signal, () => this.credential(use, version, generation, forcePass, signal));
        const expired = deadlineFailure();
        if (expired) return expired;
        if (pass.failure) {
          if (admission !== 'none' && (pass.failure.code === null || ['rate_limited', 'unavailable'].includes(pass.failure.code))) throw new TransportFailure('lost');
          return { failure: { ...pass.failure, admission } };
        }
        forcePass = false;
        for (const picture of pictures) {
          if (this.uploads.has(picture.pictureId)) continue;
          response = await untilStopped(signal, () => this.transport.request({ method: 'PUT', path: `/v1/pictures/${picture.pictureId}`, bytes: new Uint8Array(picture.bytes), mediaType: picture.mediaType, pass, signal }));
          if (generation !== this.generation) return { failure: { source: 'pass', code: null, admission, allowance: null } };
          const expired = deadlineFailure();
          if (expired) return expired;
          if (response.status !== 204) {
            validateRefusal(response.body, response.status);
            if (response.body?.code === 'pass_expired' && !refresh) { refresh = true; forcePass = true; continue operation; }
            return failed('text', response.body.code, response.body?.allowance ?? null);
          }
          this.uploads.add(picture.pictureId);
        }
        if (generation !== this.generation) return { failure: { source: 'pass', code: null, admission, allowance: null } };
        if (signal?.aborted) throw new TransportFailure('stopped');
        const read = recover || cursor > 0;
        const path = read ? `/v1/calls/${callId}/result${cursor ? `?after=${cursor}` : ''}` : `/v1/calls/${callId}/text?label=${encodeURIComponent(label)}`;
        const retrySignal = started === null ? undefined : signal;
        started ??= this.now();
        preparation = false;
        try { response = await this.transport.request({ method: read ? 'GET' : 'PUT', path, body: read ? undefined : body, pass, signal: retrySignal, timeoutMs: Math.max(1, started + 1_200_000 - this.now()) }); }
        catch (error) {
          if (error instanceof TransportFailure && error.code === 'stopped') throw error;
          promote('possible'); uncertainDispatch = true;
          if (!(error instanceof TransportFailure) || !['offline', 'lost'].includes(error.code)) return failed(error?.code === 'invalid-answer' ? 'wire' : 'transport', 'invalid-answer');
          throw error;
        }
        if (generation !== this.generation) return { failure: { source: 'pass', code: null, admission, allowance: null } };
        if (response.status !== 200) {
          try { validateRefusal(response.body, response.status); }
          catch (error) { promote('possible'); uncertainDispatch = true; throw error; }
          const code = response.body?.code;
          const allowance = response.body?.allowance ?? null;
          if (uncertain.has(code)) promote('possible');
          if (code === 'pass_expired' && !refresh) { refresh = true; forcePass = true; continue; }
          if (code === 'picture_gone' && !pictureRepair && pictures.length && !read) {
            pictureRepair = true; for (const picture of pictures) this.uploads.delete(picture.pictureId); continue;
          }
          const retryable = read ? AFTER_LOSS.has(code) : TRANSIENT.has(code);
          if (!retryable) return failed(read ? 'result' : 'text', code, allowance);
          const longRetry = uncertainDispatch && AFTER_LOSS.has(code);
          retryDeadline = started + (longRetry ? 1_200_000 : 30_000);
          lastFailure = longRetry ? failed('result', 'answer-timeout') : { failure: { source: read ? 'result' : 'text', code, admission, allowance } };
        } else {
          promote('possible');
          try {
            for await (const event of response.events) {
              if (generation !== this.generation) return { failure: { source: 'pass', code: null, admission, allowance: null } };
              validateEvent(event);
              if (event.id <= cursor) continue;
              cursor = event.id;
              promote('admitted');
              if (event.event === 'started' && event.data.callId !== callId) return failed('wire', 'invalid-answer');
              if (event.event === 'text') {
                try { await onText(event.data.delta); }
                catch (error) { callbackFailure = error; throw error; }
              }
              if (event.event === 'ended' || event.event === 'failed') {
                if (event.event === 'failed' && DEFECTS.has(event.data.code)) this.telemetry.failure('ai-call');
                return event;
              }
            }
          } catch (error) {
            if (!(error instanceof TransportFailure)) throw error;
            if (!['offline', 'lost'].includes(error.code)) return failed('wire', 'invalid-answer');
          }
          uncertainDispatch = true;
          throw new TransportFailure('lost');
        }
      } catch (error) {
        if (callbackFailure === error) throw error;
        if (error instanceof TransportFailure && error.code === 'seat-changed') return { failure: { source: 'pass', code: null, admission, allowance: null } };
        if (error instanceof TransportFailure && error.code === 'stopped') return { failure: { source: 'result', code: 'stopped', admission, allowance: null } };
        if (error?.name === 'HostUnavailable' || error?.reason === 'gone') throw error;
        if (preparation) {
          const expired = deadlineFailure();
          if (expired) return expired;
        }
        if (!(error instanceof TransportFailure) || !['offline', 'lost'].includes(error.code)) return failed('wire', 'invalid-answer');
        if (admission === 'none') return failed('transport', null);
        uncertainDispatch = true;
        retryDeadline = started + 1_200_000;
        lastFailure = failed('result', 'answer-timeout');
      } finally { await response?.dispose?.(); }
      const delay = Math.min(1000 * 2 ** Math.min(retry++, 3), Math.max(0, retryDeadline - this.now()));
      if (delay === 0) return lastFailure;
      if (!await this.wait(delay, signal)) return { failure: { source: 'result', code: 'stopped', admission, allowance: null } };
    }
  }
}
