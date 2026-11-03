import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../src/telemetry/sentry.js', import.meta.url), 'utf8');
function reporter() {
  const sent = [];
  const code = source.replaceAll('import.meta.env', 'environment').replace('export function captureError', 'function captureError');
  const capture = runInNewContext(`${code}\ncaptureError`, {
    environment: { VITE_SENTRY_DSN: 'https://abc@errors.example/42', PROD: true },
    window: { location: { hostname: 'windmill.works' } },
    crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000001' },
    fetch: (url, request) => { sent.push({ url, ...request }); return Promise.resolve(); },
  });
  return { capture, sent, events: () => sent.map(({ body }) => JSON.parse(body.split('\n')[2])) };
}

const stack = 'Error: boundary\n    at save (https://windmill.works/assets/app.js:12:4)';
test('Sentry preserves its legacy envelope and static operation when no labels are passed', () => {
  const { capture, sent, events } = reporter();
  capture('roadmap', 'roadmap-sync-refused', stack, '#/app');
  const event = events()[0];
  assert.deepEqual(event, {
    event_id: '00000000000000000000000000000001', timestamp: event.timestamp,
    platform: 'javascript', level: 'error', logger: 'windmill-web', environment: 'production',
    tags: { kind: 'roadmap' }, request: { url: '#/app' },
    exception: { values: [{ type: 'roadmap', value: 'roadmap-sync-refused', stacktrace: { frames: [
      { filename: 'https://windmill.works/assets/app.js', lineno: 12, colno: 4, function: 'save', in_app: true },
    ] } }] },
  });
  assert.equal(sent[0].url, 'https://errors.example/api/42/envelope/');
});

test('Sentry serializes bounded code labels and deduplicates distinct codes independently', () => {
  const { capture, events } = reporter();
  for (const code of ['bad-frame', 'server-error', 'bad-frame']) capture('roadmap', 'roadmap-sync-refused', stack, '#/app', { code });
  assert.deepEqual(events().map(({ tags, exception }) => ({ tags, operation: exception.values[0].value })), [
    { tags: { code: 'bad-frame', kind: 'roadmap' }, operation: 'roadmap-sync-refused' },
    { tags: { code: 'server-error', kind: 'roadmap' }, operation: 'roadmap-sync-refused' },
  ]);
});

test('Sentry rejects unbounded tag syntax and preserves its reserved kind tag', () => {
  const { capture, events } = reporter();
  capture('roadmap', 'boundary', stack, '#/app', {
    code: 'other', sentence: 'A server reason', secret: 'a@example.com', huge: 'a'.repeat(81),
    nested: {}, kind: 'replacement', 'invalid-key': 'value',
  });
  assert.deepEqual(events().map(({ tags }) => tags), [{ code: 'other', kind: 'roadmap' }]);
});
