// The compose stream contract (F3): SSE frames decode incrementally — chunk boundaries
// land anywhere (mid-frame, mid-multibyte-glyph), heartbeats are ':' comment lines —
// and the reader hands deltas over verbatim, in order, until done / fail / a silent end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseFrames, readComposeStream } from '../../../src/skilltree/paste/composeStream.js';

const body = (...chunks) => {
  const queue = chunks.map((chunk) => (typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk));
  return {
    getReader: () => ({
      read: async () => (queue.length === 0 ? { done: true, value: undefined } : { done: false, value: queue.shift() }),
    }),
  };
};

test('parseSseFrames decodes complete frames, skips heartbeats, keeps the partial tail', () => {
  const wire = 'event: delta\ndata: {"text":"# Plan"}\n\n: heartbeat\n\nevent: delta\ndata: {"text":"\\n- step"}\n\nevent: do';
  assert.deepStrictEqual(parseSseFrames(wire), {
    events: [
      { event: 'delta', data: '{"text":"# Plan"}' },
      { event: 'delta', data: '{"text":"\\n- step"}' },
    ],
    rest: 'event: do',
  });
});

test('parseSseFrames tolerates CRLF line endings', () => {
  const wire = 'event: delta\r\ndata: {"text":"a"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n';
  assert.deepStrictEqual(parseSseFrames(wire), {
    events: [
      { event: 'delta', data: '{"text":"a"}' },
      { event: 'done', data: '{}' },
    ],
    rest: '',
  });
});

test('readComposeStream hands deltas over in order and resolves done', async () => {
  const deltas = [];
  const outcome = await readComposeStream(
    body(
      'event: delta\ndata: {"text":"# Learn WebGL"}\n\n',
      ': keep-alive\n\nevent: delta\ndata: {"text":"\\n- Draw a triangle"}\n\n',
      'event: done\ndata: {}\n\n',
    ),
    (chunk) => deltas.push(chunk),
  );
  assert.deepStrictEqual(deltas, ['# Learn WebGL', '\n- Draw a triangle']);
  assert.strictEqual(outcome, 'done');
});

test('readComposeStream reassembles frames split anywhere — even inside a multibyte glyph', async () => {
  const bytes = new TextEncoder().encode('event: delta\ndata: {"text":"héros → ✓"}\n\nevent: done\ndata: {}\n\n');
  const chunks = [];
  for (let at = 0; at < bytes.length; at += 7) chunks.push(bytes.slice(at, at + 7));
  const deltas = [];
  const outcome = await readComposeStream(body(...chunks), (chunk) => deltas.push(chunk));
  assert.deepStrictEqual(deltas, ['héros → ✓']);
  assert.strictEqual(outcome, 'done');
});

test('readComposeStream keeps what streamed and resolves fail on a mid-stream failure', async () => {
  const deltas = [];
  const outcome = await readComposeStream(
    body('event: delta\ndata: {"text":"# Plan\\n"}\n\n', 'event: fail\ndata: {"code":"compose-failed"}\n\n'),
    (chunk) => deltas.push(chunk),
  );
  assert.deepStrictEqual(deltas, ['# Plan\n']);
  assert.strictEqual(outcome, 'fail');
});

test('readComposeStream resolves end when the stream closes without done or fail', async () => {
  const deltas = [];
  const outcome = await readComposeStream(body('event: delta\ndata: {"text":"partial"}\n\n'), (chunk) => deltas.push(chunk));
  assert.deepStrictEqual(deltas, ['partial']);
  assert.strictEqual(outcome, 'end');
});

test('readComposeStream ignores unknown events and malformed delta payloads', async () => {
  const deltas = [];
  const outcome = await readComposeStream(
    body('event: warm\ndata: {}\n\nevent: delta\ndata: not-json\n\nevent: delta\ndata: {"text":"ok"}\n\nevent: done\ndata: {}\n\n'),
    (chunk) => deltas.push(chunk),
  );
  assert.deepStrictEqual(deltas, ['ok']);
  assert.strictEqual(outcome, 'done');
});
