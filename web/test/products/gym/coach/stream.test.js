import test from 'node:test';
import assert from 'node:assert/strict';
import { readCoachStream } from '../../../../src/products/gym/coach/stream.js';
import { gymApi, GymError } from '../../../../src/products/gym/gymApi.js';

const frame = (revision, status, answer) => `id: gen_1:${revision}\r\nevent: snapshot\r\ndata: ${JSON.stringify({ thread: 'thr_1', generation: { id: 'gen_1', requestId: 'ask_1', revision, status, question: 'Hello', answer, at: 10 } })}\r\n\r\n`;

test('SSE parses arbitrary UTF-8/network chunks and replaces text only on newer revisions', async () => {
  const wire = new TextEncoder().encode(': heartbeat\r\n\r\n' + frame(1, 'running', '') + frame(3, 'running', 'One 🏋')
    + frame(2, 'completed', 'stale') + frame(3, 'running', 'duplicate') + frame(4, 'completed', 'One 🏋\nTwo.'));
  const snapshots = [];
  const body = new ReadableStream({ start(controller) {
    for (let index = 0; index < wire.length; index += 3) controller.enqueue(wire.slice(index, index + 3));
    controller.close();
  } });
  const terminal = await readCoachStream(new Response(body), (snapshot) => snapshots.push(snapshot.generation), (body) => new Error(body.error));
  assert.deepEqual(snapshots.map(({ revision, status, answer }) => ({ revision, status, answer })), [
    { revision: 1, status: 'running', answer: '' },
    { revision: 3, status: 'running', answer: 'One 🏋' },
    { revision: 4, status: 'completed', answer: 'One 🏋\nTwo.' },
  ]);
  assert.equal(terminal.generation.answer, 'One 🏋\nTwo.');
});

test('a snapshot is observable before the server closes or supplies its terminal answer', async () => {
  let source;
  const response = new Response(new ReadableStream({ start(controller) { source = controller; } }));
  const snapshots = [];
  let complete = false;
  const read = readCoachStream(response, (snapshot) => snapshots.push(snapshot.generation.answer), (body) => new Error(body.error)).then(() => { complete = true; });
  source.enqueue(new TextEncoder().encode(frame(1, 'running', 'First words.')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(snapshots, ['First words.']);
  assert.equal(complete, false);
  source.enqueue(new TextEncoder().encode(frame(2, 'completed', 'First words. Final words.')));
  await read;
  assert.deepEqual(snapshots, ['First words.', 'First words. Final words.']);
});

test('an interrupted stream rejects while leaving its last snapshot available for same-request recovery', async () => {
  const snapshots = [];
  await assert.rejects(readCoachStream(new Response(frame(1, 'running', 'Partial answer.')),
    (snapshot) => snapshots.push(snapshot.generation.answer), (body) => new Error(body.error)), /Response interrupted/);
  assert.deepEqual(snapshots, ['Partial answer.']);
});

test('the real API sends immutable photo/request identity, consumes snapshots and preserves coded SSE refusals', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response(frame(2, 'completed', 'Done.'), { headers: { 'content-type': 'text/event-stream' } });
    return new Response('event: error\ndata: {"status":429,"code":"ask-daily-limit","error":"Try tomorrow."}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const snapshots = [];
  const reply = await gymApi.askStream('thr_1', 'Hello', 'ask_1', { attachmentIds: ['img_1'], onSnapshot: (snapshot) => snapshots.push(snapshot) });
  assert.deepEqual(JSON.parse(calls[0].options.body), { thread: 'thr_1', question: 'Hello', requestId: 'ask_1', stream: true, attachmentIds: ['img_1'] });
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(reply.generation.answer, 'Done.');
  assert.equal(snapshots.length, 1);
  await assert.rejects(gymApi.askStream('thr_1', 'Hello', 'ask_1', { onSnapshot() {} }), (error) => {
    assert.ok(error instanceof GymError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'ask-daily-limit');
    assert.equal(error.detail, 'Try tomorrow.');
    return true;
  });
});
