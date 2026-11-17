export class TransportFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

const refusalStatus = { invalid_request: 400, provider_rejected: 400, pass_missing: 401, pass_signature: 401,
  pass_audience: 401, pass_malformed: 401, pass_expired: 401, funding_required: 403, device_bound: 403,
  call_unknown: 404, conflict: 409, result_gone: 410, picture_gone: 410, too_large: 413,
  subject_exhausted: 429, free_month_exhausted: 429, free_day_exhausted: 429, concurrency_exhausted: 429,
  rate_limited: 429, busy: 503, paused: 503, accounting_unavailable: 503, provider_unavailable: 503 };
const passRefusalStatus = { invalid_request: 400, unauthenticated: 401, invalid_installation: 401, device_bound: 409,
  'client-update-required': 426, anonymous_ai_unavailable: 503, rate_limited: 429, unavailable: 503,
  'untrusted-origin': 403, 'unsupported-media-type': 415 };

function object(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join(' ') !== fields.split(' ').sort().join(' ')) throw new TransportFailure('invalid-answer');
}

export function validateRefusal(value, status) {
  try {
    object(value, 'code allowance');
    if (typeof value.code !== 'string' || !Object.hasOwn(refusalStatus, value.code) || refusalStatus[value.code] !== status) throw new TransportFailure('invalid-answer');
    if (value.allowance !== null) validateAllowance(value.allowance);
  } catch { throw new TransportFailure('lost'); }
}

export function validatePassRefusal(value, status) {
  try {
    object(value, 'code error');
    if (typeof value.code !== 'string' || !Object.hasOwn(passRefusalStatus, value.code) || passRefusalStatus[value.code] !== status || typeof value.error !== 'string') throw new TransportFailure('invalid-answer');
  } catch { throw new TransportFailure('lost'); }
}

export function validateAllowance(value) {
  object(value, 'tier period limit used reserved remaining resetsAt budgetResetsAt code capabilities');
  if (!['anonymous', 'free', 'one'].includes(value.tier) || !['lifetime', 'calendar_month_utc', 'billing_period'].includes(value.period)) throw new TransportFailure('invalid-answer');
  for (const key of ['limit', 'used', 'reserved', 'remaining']) if (typeof value[key] !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(value[key])) throw new TransportFailure('invalid-answer');
  for (const key of ['resetsAt', 'budgetResetsAt']) if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) throw new TransportFailure('invalid-answer');
  if (!['ok', 'device_bound', 'subject_exhausted', 'free_month_exhausted', 'free_day_exhausted', 'concurrency_exhausted'].includes(value.code)) throw new TransportFailure('invalid-answer');
  object(value.capabilities, 'text transcription'); object(value.capabilities.text, 'large medium small');
  if (typeof value.capabilities.transcription !== 'boolean' || !Object.values(value.capabilities.text).every((v) => ['large', 'medium', 'small'].includes(v))) throw new TransportFailure('invalid-answer');
}

export function validateEvent(value) {
  object(value, 'id event data');
  if (!Number.isSafeInteger(value.id) || value.id < 1) throw new TransportFailure('invalid-answer');
  const fields = { started: 'callId served maxTokens', text: 'delta', toolCall: 'id name input', ended: 'stop message charged allowance', failed: 'code charged allowance' };
  if (!fields[value.event]) throw new TransportFailure('invalid-answer');
  object(value.data, fields[value.event]);
  const data = value.data;
  if (value.event === 'started' && (!/^[A-Za-z0-9_-]{22,64}$/.test(data.callId) || !['large', 'medium', 'small'].includes(data.served) || !Number.isSafeInteger(data.maxTokens) || data.maxTokens < 1)) throw new TransportFailure('invalid-answer');
  if (value.event === 'text' && typeof data.delta !== 'string') throw new TransportFailure('invalid-answer');
  if (value.event === 'toolCall') validateCall(data);
  if (['ended', 'failed'].includes(value.event)) {
    if (data.charged !== null && (typeof data.charged !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(data.charged))) throw new TransportFailure('invalid-answer');
    if (data.allowance !== null) validateAllowance(data.allowance);
    if (value.event === 'failed') {
      if (!['provider_rejected', 'provider_unavailable', 'provider_failed', 'accounting_unavailable'].includes(data.code)) throw new TransportFailure('invalid-answer');
    } else {
      if (!['completed', 'tool_calls', 'truncated', 'declined'].includes(data.stop)) throw new TransportFailure('invalid-answer');
      object(data.message, 'role parts carry');
      if (data.message.role !== 'assistant' || typeof data.message.carry !== 'string' || !Array.isArray(data.message.parts)) throw new TransportFailure('invalid-answer');
      for (const part of data.message.parts) {
        if (Object.hasOwn(part, 'text')) { object(part, 'text'); if (typeof part.text !== 'string') throw new TransportFailure('invalid-answer'); }
        else if (part.toolCall) { object(part, 'toolCall'); validateCall(part.toolCall); }
        else throw new TransportFailure('invalid-answer');
      }
    }
  }
}

function validateCall(call) {
  object(call, 'id name input');
  if (typeof call.id !== 'string' || !call.id || !/^[A-Za-z0-9_-]{1,64}$/.test(call.name) || !call.input || Array.isArray(call.input) || typeof call.input !== 'object') throw new TransportFailure('invalid-answer');
}

export async function* decodeEvents(body) {
  if (!body) throw new TransportFailure('invalid-answer');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    for await (const chunk of body) {
      try { buffer += decoder.decode(chunk, { stream: true }); }
      catch { throw new TransportFailure('invalid-answer'); }
      if (buffer.length > 1_048_576) throw new TransportFailure('invalid-answer');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const fields = { data: [] };
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith(':') || !line) continue;
          const colon = line.indexOf(':');
          const key = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (key === 'data') fields.data.push(value);
          else if (key === 'id' || key === 'event') fields[key] = value;
        }
        if (!fields.data.length) continue;
        if (!/^[1-9][0-9]*$/.test(fields.id ?? '')) throw new TransportFailure('invalid-answer');
        let data;
        try { data = JSON.parse(fields.data.join('\n')); }
        catch { throw new TransportFailure('invalid-answer'); }
        const event = { id: Number(fields.id), event: fields.event, data };
        validateEvent(event); yield event;
      }
    }
    try { buffer += decoder.decode(); }
    catch { throw new TransportFailure('invalid-answer'); }
    if (buffer.trim()) throw new TransportFailure('lost');
  } catch (error) {
    if (error instanceof TransportFailure) throw error;
    throw new TransportFailure('lost');
  }
}

export class HttpAiTransport {
  constructor({ base = '', fetch = globalThis.fetch, installation = () => null, timers = globalThis }) {
    Object.assign(this, { base, fetch: fetch.bind(globalThis), installation, timers });
  }

  async pass(body, { signal } = {}) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = this.timers.setTimeout(() => controller.abort(), 30_000);
    try {
      const installation = await this.installation();
      if (signal?.aborted) throw new TransportFailure('stopped');
      let response;
      try {
        response = await this.fetch(`${this.base}/v1/ai/passes`, { method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'manual', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(installation ? { 'X-Windmill-Installation': installation } : {}) }, body: JSON.stringify(body) });
      } catch { throw new TransportFailure(signal?.aborted ? 'stopped' : globalThis.navigator?.onLine === false ? 'offline' : 'lost'); }
      if (response.status === 404) return { status: 404, body: null };
      try { return { status: response.status, body: await response.json() }; }
      catch { throw new TransportFailure(signal?.aborted ? 'stopped' : response.status === 200 ? 'invalid-answer' : 'lost'); }
    } finally { signal?.removeEventListener('abort', stop); this.timers.clearTimeout(timer); }
  }

  async request({ method, path, body, bytes, mediaType, pass, signal, timeoutMs = 30_000 }) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = this.timers.setTimeout(() => controller.abort(), timeoutMs);
    let liveStream = false;
    try {
      if (signal?.aborted) throw new TransportFailure('stopped');
      let response;
      try {
        response = await this.fetch(`${this.base}${path}`, { method, credentials: 'omit', redirect: 'manual', cache: 'no-store',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${pass}`, ...(body ? { 'Content-Type': 'application/json' } : bytes ? { 'Content-Type': mediaType } : {}) },
          ...(body !== undefined || bytes ? { body: body ?? bytes } : {}) });
      } catch { throw new TransportFailure(signal?.aborted ? 'stopped' : globalThis.navigator?.onLine === false ? 'offline' : 'lost'); }
      if (signal?.aborted) throw new TransportFailure('stopped');
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw new TransportFailure('redirect');
      if (response.status === 200 && path !== '/v1/allowance') {
        if (!response.headers.get('Content-Type')?.startsWith('text/event-stream')) throw new TransportFailure('invalid-answer');
        liveStream = true;
        const timers = this.timers;
        return { status: 200, events: (async function* () {
          try { yield* decodeEvents(response.body); }
          finally { timers.clearTimeout(timer); }
        })() };
      }
      if (response.status === 204) return { status: 204, body: null };
      try { return { status: response.status, body: await response.json() }; }
      catch { throw new TransportFailure(signal?.aborted ? 'stopped' : response.status === 200 ? 'invalid-answer' : 'lost'); }
    } finally {
      signal?.removeEventListener('abort', stop);
      if (!liveStream) this.timers.clearTimeout(timer);
    }
  }
}
