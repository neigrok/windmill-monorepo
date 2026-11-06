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
test('A test run holds no production DSN, so a failure a test provokes never reaches Sentry', () => {
  assert.equal(process.env.VITE_SENTRY_DSN, undefined);
});

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

test('Sentry takes frames from the last unbroken run, so no line of a message becomes a frame', () => {
  const { capture, events } = reporter();
  capture('roadmap', 'boundary', [
    "Error: Rig the boat at home (harbour:3:4)",
    'note at 12:30:45',
    'sam@example.com',
    '    at dock (marina.js:5:6)',
    'while at sea',
    '    at save (https://windmill.works/assets/app.js:12:4)',
    '    at Array.map (<anonymous>)',
    '    at boot (https://windmill.works/assets/app.js:1:1)',
  ].join('\n'), '#/app');
  assert.deepEqual(events()[0].exception.values[0].stacktrace.frames.map((frame) => ({ ...frame })), [
    { filename: 'https://windmill.works/assets/app.js', lineno: 1, colno: 1, function: 'boot', in_app: true },
    { filename: 'https://windmill.works/assets/app.js', lineno: 12, colno: 4, function: 'save', in_app: true },
  ]);
});

test('Sentry reads a Safari or Firefox stack, which has no head and can end in a newline', () => {
  const { capture, events } = reporter();
  capture('roadmap', 'boundary', 'save@https://windmill.works/assets/app.js:12:4\nmap@[native code]\nglobal code@https://windmill.works/assets/app.js:1:1\n', '#/app');
  assert.deepEqual(events()[0].exception.values[0].stacktrace.frames.map((frame) => ({ ...frame })), [
    { filename: 'https://windmill.works/assets/app.js', lineno: 1, colno: 1, function: 'global code', in_app: true },
    { filename: 'https://windmill.works/assets/app.js', lineno: 12, colno: 4, function: 'save', in_app: true },
  ]);
});

test('Sentry reads named and anonymous frames in both browser stack formats', () => {
  const stacks = [
    'Error: boundary\n    at qh (http://localhost:5173/assets/app.js:12:4)\n    at http://localhost:5173/assets/app.js:1:1',
    'qh@http://localhost:5173/assets/app.js:12:4\n@http://localhost:5173/assets/app.js:1:1',
  ];
  for (const browserStack of stacks) {
    const { capture, events } = reporter();
    capture('roadmap', 'boundary', browserStack, '#/app');
    assert.deepEqual(events()[0].exception.values[0].stacktrace.frames, [
      { filename: 'http://localhost:5173/assets/app.js', lineno: 1, colno: 1, function: '?', in_app: true },
      { filename: 'http://localhost:5173/assets/app.js', lineno: 12, colno: 4, function: 'qh', in_app: true },
    ]);
  }
});

test('Sentry preserves an at sign inside a Safari or Firefox frame filename', () => {
  const { capture, events } = reporter();
  capture('roadmap', 'boundary', 'save@https://windmill.works/assets/@scope/app.js:12:4', '#/app');
  assert.deepEqual(events()[0].exception.values[0].stacktrace.frames, [
    { filename: 'https://windmill.works/assets/@scope/app.js', lineno: 12, colno: 4, function: 'save', in_app: true },
  ]);
});

test('Sentry collapses a repeat of one crash but keeps different crashes under one static operation', () => {
  const { capture, events } = reporter();
  const crashAt = (line) => `Error\n    at save (https://windmill.works/assets/app.js:${line}:4)`;
  for (const line of [12, 30, 12]) capture('window', 'client-error', crashAt(line), '/app/roadmap', { failure_kind: 'TypeError' });
  assert.deepEqual(events().map(({ tags, exception }) => ({ tags: { ...tags }, line: exception.values[0].stacktrace.frames[0].lineno })), [
    { tags: { failure_kind: 'TypeError', kind: 'window' }, line: 12 },
    { tags: { failure_kind: 'TypeError', kind: 'window' }, line: 30 },
  ]);
});
