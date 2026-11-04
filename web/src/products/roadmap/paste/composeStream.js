// POST /v1/compose with stream:true answers text/event-stream: `delta` frames carry verbatim plan
// text in order, `done` closes clean, `fail` means the model stopped mid-plan. Chunk boundaries
// land anywhere and heartbeats are ':' comment lines.

const SHAPE_FAILURE_REASONS = new Set(['unavailable', 'unreachable', 'failed', 'no-first-word', 'stopped-mid-plan']);

// What a failed shape may tell Sentry: a closed reason and a coarse size, never the text, a count or a status.
export function shapeFailureLabels(reason, bytes) {
  return {
    reason: SHAPE_FAILURE_REASONS.has(reason) ? reason : 'other',
    size: bytes < 1024 ? 'under-1kb' : (bytes < 8192 ? '1-8kb' : 'over-8kb'),
  };
}

export function parseSseFrames(buffered) {
  const events = [];
  let rest = buffered.replace(/\r\n/g, '\n');
  for (let cut = rest.indexOf('\n\n'); cut !== -1; cut = rest.indexOf('\n\n')) {
    const lines = rest.slice(0, cut).split('\n');
    rest = rest.slice(cut + 2);
    let event = 'message';
    const data = [];
    for (const line of lines) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
    }
    if (event !== 'message' || data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

export async function readComposeStream(body, onDelta) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return 'end';
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseFrames(buffer);
    buffer = parsed.rest;
    for (const { event, data } of parsed.events) {
      if (event === 'done') return 'done';
      if (event === 'fail') return 'fail';
      if (event !== 'delta') continue;
      let payload = null;
      try { payload = JSON.parse(data); } catch { continue; }
      if (typeof payload?.text === 'string') onDelta(payload.text);
    }
  }
}
