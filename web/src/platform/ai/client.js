import { waitFor } from '../agent/runtime.js';
import { validateEvent, validateAllowance, TransportFailure } from './wire.js';
import { captureError } from '../../telemetry/sentry.js';

const TRANSIENT = new Set(['busy', 'paused', 'rate_limited', 'concurrency_exhausted', 'accounting_unavailable', 'provider_unavailable']);
const DEFECTS = new Set(['invalid_request', 'too_large', 'provider_rejected', 'funding_required', 'conflict', 'call_unknown', 'invalid-answer', 'untrusted-origin', 'unsupported-media-type']);
const uncertain = new Set(['busy', 'accounting_unavailable']);
const CODES = new Set([...TRANSIENT, ...DEFECTS, 'subject_exhausted', 'free_day_exhausted', 'free_month_exhausted', 'device_bound',
  'result_gone', 'pass_missing', 'pass_signature', 'pass_audience', 'pass_malformed', 'pass_expired', 'picture_gone', 'provider_failed']);
const PASS_CODES = new Set(['invalid_request', 'unauthenticated', 'invalid_installation', 'device_bound', 'client-update-required',
  'rate_limited', 'anonymous_ai_unavailable', 'untrusted-origin', 'unsupported-media-type']);

export class AiClient {
  constructor({ transport, telemetry, now = () => performance.now(), wait = waitFor, client = 'web' }) {
    Object.assign(this, { transport, now, wait, client });
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

  async credential(use, version, generation, force = false) {
    if (generation !== this.generation) throw new TransportFailure('seat-changed');
    if (!force && this.pass?.use === use && this.pass?.version === version && this.pass.until - this.now() >= 60_000) return this.pass.value;
    const key = `${generation}:${use}:${version}`;
    if (!force && this.passTask?.key === key) return this.passTask.promise;
    const promise = (async () => {
      let response;
      try { response = await this.transport.pass({ client: this.client, use, version }); }
      catch (error) {
        if (generation !== this.generation) throw new TransportFailure('seat-changed');
        if (error instanceof TransportFailure && ['offline', 'lost'].includes(error.code))
          return { failure: { source: 'transport', code: null, admission: 'none', allowance: null } };
        this.telemetry.failure('ai-pass');
        return { failure: { source: 'pass', code: null, admission: 'none', allowance: null } };
      }
      if (generation !== this.generation) throw new TransportFailure('seat-changed');
      if (response.status !== 200) {
        const code = PASS_CODES.has(response.body?.code) ? response.body.code : response.status === 404 ? 'anonymous_ai_unavailable' : 'invalid-answer';
        if (DEFECTS.has(code) || (response.status >= 500 && code !== 'anonymous_ai_unavailable')) this.telemetry.failure('ai-pass');
        return { failure: { source: 'pass', code, admission: 'none', allowance: null } };
      }
      if (typeof response.body?.pass !== 'string' || !response.body.pass || !Number.isSafeInteger(response.body.expiresIn) || response.body.expiresIn <= 0) {
        this.telemetry.failure('ai-pass');
        return { failure: { source: 'pass', code: 'invalid-answer', admission: 'none', allowance: null } };
      }
      this.pass = { value: response.body.pass, until: this.now() + response.body.expiresIn, use, version };
      return this.pass.value;
    })();
    this.passTask = { key, promise };
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
        if (!CODES.has(response.body?.code)) return this.failure('wire', 'invalid-answer', 'none');
        if (response.body.allowance !== null && response.body.allowance !== undefined) validateAllowance(response.body.allowance);
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
    let lost = recover;
    let cursor = 0;
    let retry = 0;
    let refresh = false;
    let pictureRepair = false;
    let forcePass = false;
    let lastFailure = null;
    let callbackFailure;
    const promote = (value) => { if (['none', 'possible', 'admitted'].indexOf(value) > ['none', 'possible', 'admitted'].indexOf(admission)) admission = value; };
    const failed = (source, code, allowance = null) => this.failure(source, code, admission, allowance);
    operation: while (true) {
      if (generation !== this.generation) return { failure: { source: 'pass', code: null, admission, allowance: null } };
      if (retry > 0 && this.now() >= started + (lost ? 1_200_000 : 30_000)) return lost ? failed('result', 'answer-timeout') : lastFailure;
      try {
        const pass = await this.credential(use, version, generation, forcePass);
        forcePass = false;
        if (pass.failure) { pass.failure.admission = admission; return pass; }
        for (const picture of pictures) {
          if (this.uploads.has(picture.pictureId)) continue;
          const response = await this.transport.request({ method: 'PUT', path: `/v1/pictures/${picture.pictureId}`, bytes: new Uint8Array(picture.bytes), mediaType: picture.mediaType, pass });
          if (generation !== this.generation) return { failure: { source: 'pass', code: null, admission, allowance: null } };
          if (response.status !== 204) {
            if (response.body?.code === 'pass_expired' && !refresh) { refresh = true; forcePass = true; continue operation; }
            return failed('text', CODES.has(response.body?.code) ? response.body.code : 'invalid-answer', response.body?.allowance ?? null);
          }
          this.uploads.add(picture.pictureId);
        }
        const read = recover || cursor > 0;
        const path = read ? `/v1/calls/${callId}/result${cursor ? `?after=${cursor}` : ''}` : `/v1/calls/${callId}/text?label=${encodeURIComponent(label)}`;
        started ??= this.now();
        let response;
        try { response = await this.transport.request({ method: read ? 'GET' : 'PUT', path, body: read ? undefined : body, pass, timeoutMs: Math.max(1, started + 1_200_000 - this.now()) }); }
        catch (error) {
          promote('possible'); lost = true;
          if (!(error instanceof TransportFailure) || !['offline', 'lost'].includes(error.code)) return failed('transport', 'invalid-answer');
        }
        if (generation !== this.generation) return { failure: { source: 'pass', code: null, admission, allowance: null } };
        if (response && response.status !== 200) {
          const code = response.body?.code;
          if (!CODES.has(code)) return failed('wire', 'invalid-answer');
          const allowance = response.body?.allowance ?? null;
          if (allowance !== null) validateAllowance(allowance);
          if (uncertain.has(code)) promote('possible');
          if (code === 'pass_expired' && !refresh) { refresh = true; forcePass = true; continue; }
          if (code === 'picture_gone' && !pictureRepair && pictures.length && !read) {
            pictureRepair = true; for (const picture of pictures) this.uploads.delete(picture.pictureId); continue;
          }
          const retryable = lost ? ['rate_limited', 'busy', 'accounting_unavailable'].includes(code) : TRANSIENT.has(code);
          if (!retryable) return failed(read ? 'result' : 'text', code, allowance);
          lastFailure = { failure: { source: read ? 'result' : 'text', code, admission, allowance } };
        } else if (response) {
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
          lost = true;
        }
      } catch (error) {
        if (callbackFailure === error) throw error;
        if (error instanceof TransportFailure && error.code === 'seat-changed') return { failure: { source: 'pass', code: null, admission, allowance: null } };
        if (error instanceof TransportFailure && ['offline', 'lost'].includes(error.code)) return failed('transport', null);
        if (error?.name === 'HostUnavailable' || error?.reason === 'gone') throw error;
        return failed('wire', 'invalid-answer');
      }
      const deadline = started + (lost ? 1_200_000 : 30_000);
      const delay = Math.min(1000 * 2 ** Math.min(retry++, 3), Math.max(0, deadline - this.now()));
      if (delay === 0) return lost ? failed('result', 'answer-timeout') : lastFailure;
      if (!await this.wait(delay, signal)) return { failure: { source: 'result', code: 'stopped', admission, allowance: null } };
    }
  }
}
