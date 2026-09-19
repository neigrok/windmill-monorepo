import test from 'node:test';
import assert from 'node:assert/strict';
import { GymError } from '../../../../src/products/gym/gymApi.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from '../harness.mjs';
import { coachDraftKey, readCoachDraft, useCoachConversation } from '../../../../src/products/gym/coach/useCoachConversation.js';

test('a timeout and reload retry the durable account-scoped request without another user message', async (t) => {
  browserWith();
  const sent = [];
  const api = {
    thread: async () => null,
    ask: async (thread, question, requestId) => {
      const saved = readCoachDraft('alice', thread);
      assert.equal(saved.request.requestId, requestId, 'saved before the send');
      sent.push({ thread, question, requestId });
      if (sent.length === 1) throw new Error('network gone');
      return { answer: 'Add one rep.', read: { sets: 5, sessions: 1, weeks: 1 } };
    },
  };
  const first = renderHook(t, () => useCoachConversation({ accountId: 'alice', api }));
  first.tree.setDraft('How can I progress?');
  await first.tree.send();
  assert.equal(first.tree.draft, 'How can I progress?');
  assert.equal(first.tree.turns.length, 1);
  first.unmount();
  const second = renderHook(t, () => useCoachConversation({ accountId: 'alice', api }));
  await settle();
  await second.tree.send();
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(second.tree.turns.map(({ from, text }) => ({ from, text })), [
    { from: 'lifter', text: 'How can I progress?' }, { from: 'ask', text: 'Add one rep.' },
  ]);
  assert.equal(second.tree.request, null);
  assert.equal(second.tree.draft, '');
  const bob = renderHook(t, () => useCoachConversation({ accountId: 'bob', api }));
  assert.equal(bob.tree.draft, '');
  assert.deepEqual(bob.tree.turns, []);
});

test('202 remains pending and retries with backoff using the same request', async (t) => {
  browserWith();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const api = { ask: async (thread, question, requestId) => {
    sent.push({ thread, question, requestId });
    return { pending: sent.length < 3, generation: { id: 'gen_1', requestId, question, at: 100,
      status: sent.length < 3 ? 'running' : 'completed', answer: sent.length < 3 ? '' : 'Ready.' } };
  } };
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api }));
  room.tree.setDraft('Help with my routine.');
  await room.tree.send();
  assert.equal(room.tree.pending, true);
  assert.ok(room.tree.request);
  t.mock.timers.tick(1999); await settle(); assert.equal(sent.length, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(sent.length, 2);
  t.mock.timers.tick(3999); await settle(); assert.equal(sent.length, 2);
  t.mock.timers.tick(1); await settle();
  assert.equal(room.tree.pending, false);
  assert.equal(room.tree.request, null);
  assert.deepEqual(sent, [sent[0], sent[0], sent[0]]);
  assert.deepEqual(room.tree.turns.map((turn) => turn.text), ['Help with my routine.', 'Ready.']);
});

test('failed routine creation preserves the result and retry updates the same historical positions', async (t) => {
  browserWith();
  const generation = { id: 'gen_1', requestId: 'ask_retry', question: 'Create Push.', at: 100, status: 'failed', answer: '',
    results: [{ kind: 'routine-created', operationId: 'op_1', routineId: 'rt_1', routineName: 'Push' }] };
  const turns = [
    { position: 0, from: 'lifter', text: generation.question, at: 100, requestId: 'ask_retry', generationId: 'gen_1' },
    { position: 1, from: 'ask', text: '', at: 100, requestId: 'ask_retry', generationId: 'gen_1', status: 'failed', results: generation.results },
  ];
  const sent = [];
  const api = { ask: async (...args) => { sent.push(args.slice(0, 3)); return { generation: { ...generation, status: 'completed', answer: 'Push is ready.' } }; } };
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api, initialThread: { id: 'thr_old', turns, generation } }));
  await room.tree.send();
  assert.deepEqual(sent, [['thr_old', 'Create Push.', 'ask_retry']]);
  assert.deepEqual(room.tree.turns.map((turn) => [turn.position, turn.text]), [[0, 'Create Push.'], [1, 'Push is ready.']]);
  assert.deepEqual(room.tree.turns[1].results, generation.results);
});

test('a refusal returns the draft and exact server recovery without implying a new chat resets an allowance', async (t) => {
  browserWith();
  const api = { ask: async () => { throw new GymError(429, 'Thirty-day allowance spent.', 'ask-out-of-budget'); } };
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api }));
  room.tree.setDraft('Help me plan.'); await room.tree.send();
  assert.deepEqual(room.tree.turns, []);
  assert.equal(room.tree.request, null);
  assert.equal(room.tree.draft, 'Help me plan.');
  assert.equal(room.tree.note, 'Thirty-day allowance spent.');
});

test('a question is not sent if its identity cannot be persisted', async (t) => {
  browserWith();
  window.localStorage.setItem = () => { throw new Error('quota'); };
  let sends = 0;
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api: { ask: async () => { sends += 1; } } }));
  room.tree.setDraft('What next?'); await room.tree.send();
  assert.equal(sends, 0);
  assert.equal(room.tree.draft, 'What next?');
  assert.equal(room.tree.note, 'Your browser couldn’t save this question. Allow local storage and try again.');
});

test('saved conversations continue beyond four questions and load earlier pages without duplicate positions', async (t) => {
  browserWith();
  const turns = Array.from({ length: 260 }, (_, position) => ({ position, from: position % 2 ? 'ask' : 'lifter', text: String(position), at: position }));
  const pages = [];
  const api = {
    thread: async (id, page) => { pages.push([id, page]); return { turns: turns.slice(0, 210), nextCursor: null }; },
    ask: async (thread, question) => ({ answer: 'Keep going.', read: { sets: 3, sessions: 1, weeks: 1 } }),
  };
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api,
    initialThread: { id: 'thr_old', turns: turns.slice(200), nextCursor: 'opaque cursor' } }));
  await room.tree.older();
  assert.deepEqual(pages, [['thr_old', { limit: 50, before: 'opaque cursor' }]]);
  assert.deepEqual(room.tree.turns, turns);
  room.tree.setDraft('One more?'); await room.tree.send();
  assert.equal(room.tree.turns.length, 262);
  assert.equal(room.tree.turns.at(-1).text, 'Keep going.');
});

test('the empty room has a composer and only History and More navigation', async (t) => {
  browserWith();
  const { CoachRoom, CoachBody } = await loadScreen('products/gym/coach/CoachRoom.jsx');
  const room = renderHook(t, () => CoachRoom({ log: roomLog(), accountId: 'alice' }));
  assert.equal(textOf(findByClass(room.tree, 'gym-coach-head')[0]), 'CoachHistory');
  const menu = elementsOf(room.tree).find((element) => element.type?.name === 'Menu');
  assert.deepEqual(menu.props.items.map((item) => item.label), ['Notes', 'Connected log', 'Account']);
  const body = elementsOf(room.tree).find((element) => element.type === CoachBody);
  const drawn = renderHook(t, () => body.type(body.props)).tree;
  assert.equal(findByClass(drawn, 'gym-coach-input')[0].props.placeholder, 'Ask about your training');
  assert.equal(findByClass(drawn, 'gym-coach-note').length, 0);
});

test('both speakers copy only visible text with line breaks through long press, context menu and keyboard', async (t) => {
  browserWith();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const copied = [];
  navigator.clipboard = { writeText: async (text) => copied.push(text) };
  const { CoachMessage } = await loadScreen('products/gym/coach/CoachRoom.jsx');
  for (const from of ['lifter', 'ask']) {
    const turn = { from, text: 'First line.\nSecond line.', at: 9, receipt: { read: { sets: 3, sessions: 1, weeks: 1 } },
      results: [{ kind: 'routine-created', operationId: 'op_1', routineId: 'rt_1', routineName: 'Push' }] };
    const message = renderHook(t, () => CoachMessage({ turn, log: roomLog() }));
    const paragraph = () => findByClass(message.tree, 'gym-coach-text')[0];
    paragraph().props.onPointerDown({ button: 0, clientX: 1, clientY: 1 });
    t.mock.timers.tick(550);
    assert.ok(message.tree.props.className.includes('is-menu-open'));
    await findByClass(message.tree, 'gym-coach-copy')[0].props.onClick();
    paragraph().props.onContextMenu({ preventDefault() {} });
    assert.ok(message.tree.props.className.includes('is-menu-open'));
    await findByClass(message.tree, 'gym-coach-copy')[0].props.onClick();
    paragraph().props.onKeyDown({ key: 'F10', shiftKey: true, preventDefault() {} });
    await findByClass(message.tree, 'gym-coach-copy')[0].props.onClick();
    assert.equal(textOf(findByClass(message.tree, 'gym-coach-copy-notice')[0]), 'Message copied.');
    t.mock.timers.tick(2000);
    assert.equal(textOf(findByClass(message.tree, 'gym-coach-copy-notice')[0]), '');
  }
  assert.deepEqual(copied, Array(6).fill('First line.\nSecond line.'));
  const empty = renderHook(t, () => CoachMessage({ turn: { from: 'lifter', text: '' }, log: roomLog() }));
  assert.equal(findByClass(empty.tree, 'gym-coach-copy').length, 0);
});

test('an earlier completed generation does not erase a later request saved before a timeout', async (t) => {
  browserWith();
  const request = { thread: 'thr_1', requestId: 'ask_later', question: 'And tomorrow?', at: 20 };
  window.localStorage.setItem(coachDraftKey('alice', 'thr_1'), JSON.stringify({ thread: 'thr_1', turns: [], draft: request.question, request }));
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', initialThread: {
    id: 'thr_1', turns: [], generation: { id: 'gen_old', requestId: 'ask_old', question: 'Today?', at: 10, status: 'completed', answer: 'Rest.' },
  } }));
  assert.deepEqual(room.tree.request, request);
  assert.equal(room.tree.draft, request.question);
});

test('a deleted server conversation clears its cached messages and cannot be recreated by Retry', async (t) => {
  browserWith();
  window.localStorage.setItem(coachDraftKey('alice'), JSON.stringify({ thread: 'thr_gone', turns: [{ from: 'lifter', text: 'Old question.', at: 10 }], draft: '' }));
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api: { thread: async () => null } }));
  await settle();
  assert.deepEqual(room.tree.turns, []);
  assert.equal(room.tree.request, null);
  assert.equal(room.tree.thread, 'thr_gone');
  assert.equal(room.tree.closed, 'thread');
  assert.equal(room.tree.note, 'That conversation isn’t here any more.');
});

test('a retry refused after creation or an ambiguous send keeps its original immutable request', async (t) => {
  for (const accepted of [true, false]) {
    browserWith();
    const sent = [];
    const results = [{ kind: 'routine-created', operationId: 'op_1', routineId: 'rt_1', routineName: 'Push' }];
    const api = { ask: async (thread, question, requestId) => {
      sent.push({ thread, question, requestId });
      const generation = { id: 'gen_1', requestId, question, at: 100, status: 'failed', answer: '', results };
      if (sent.length === 1) {
        if (!accepted) throw new Error('network lost');
        throw new GymError(502, 'Response interrupted.', '', { generation });
      }
      if (sent.length === 2) throw new GymError(429, 'Try tomorrow.', 'ask-daily-limit');
      return { generation: { ...generation, status: 'completed', answer: 'Push is ready.' } };
    } };
    const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api }));
    room.tree.setDraft('Create Push.');
    await room.tree.send();
    await room.tree.send();
    assert.equal(room.tree.request.requestId, sent[0].requestId);
    if (accepted) assert.deepEqual(room.tree.turns[1].results, results);
    await room.tree.send();
    assert.deepEqual(sent, [sent[0], sent[0], sent[0]]);
    assert.equal(room.tree.turns.length, 2);
    assert.deepEqual(room.tree.turns[1].results, results);
    room.unmount();
  }
});

test('stream snapshots replace text monotonically and an interrupted reconnect keeps identity and completed actions', async (t) => {
  browserWith();
  const requests = [];
  let emit;
  let finish;
  let interrupt;
  const api = { askStream: (thread, question, requestId, options) => {
    requests.push({ thread, question, requestId, attachmentIds: options.attachmentIds });
    emit = (revision, status, answer) => {
      const reply = { thread, generation: { id: 'gen_1', requestId, question, revision, status, answer, at: 10,
        results: [{ kind: 'routine-created', operationId: 'op_1', routineId: 'rt_1', routineName: 'Push' }] } };
      options.onSnapshot(reply);
      return reply;
    };
    return new Promise((resolve, reject) => { finish = resolve; interrupt = reject; });
  } };
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api }));
  room.tree.setDraft('Create Push.');
  const first = room.tree.send();
  emit(1, 'running', 'Starting.');
  emit(3, 'running', 'Starting. Push is ready.');
  emit(2, 'running', 'stale');
  assert.equal(room.tree.turns.at(-1).text, 'Starting. Push is ready.');
  assert.equal(room.tree.busy, true);
  interrupt(new Error('connection closed'));
  await first;
  assert.equal(room.tree.note, 'Response interrupted.');
  assert.equal(room.tree.turns.at(-1).results[0].routineId, 'rt_1');
  const second = room.tree.send();
  emit(3, 'running', 'duplicate');
  assert.equal(room.tree.turns.at(-1).text, 'Starting. Push is ready.');
  const terminal = emit(4, 'completed', 'Push is ready.\nOpen it below.');
  finish(terminal);
  await second;
  assert.deepEqual(requests, [requests[0], requests[0]]);
  assert.equal(room.tree.turns.length, 2);
  assert.equal(room.tree.turns.at(-1).text, 'Push is ready.\nOpen it below.');
  assert.equal(room.tree.request, null);
});

test('Stop waits for a stopped snapshot, preserves partial text and results, then permits a new request', async (t) => {
  browserWith();
  let emit;
  let finish;
  const requests = [];
  const generation = { id: 'gen_1', question: 'Create Push.', at: 10, revision: 2, status: 'running', answer: 'Push is ready.',
    results: [{ kind: 'routine-created', operationId: 'op_1', routineId: 'rt_1', routineName: 'Push' }] };
  const api = {
    askStream: (thread, question, requestId, options) => {
      requests.push({ thread, question, requestId });
      generation.requestId = requestId;
      emit = (value) => options.onSnapshot({ thread, generation: value });
      emit(generation);
      return new Promise((resolve) => { finish = resolve; });
    },
    stopCoach: async (thread, requestId) => {
      assert.equal(requestId, requests[0].requestId);
      return { thread, generation: { ...generation, stopRequested: true } };
    },
  };
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api }));
  room.tree.setDraft('Create Push.');
  const send = room.tree.send();
  await room.tree.stop();
  assert.equal(room.tree.stopRequested, true);
  assert.equal(room.tree.request.requestId, requests[0].requestId);
  const stopped = { ...generation, revision: 3, status: 'stopped' };
  emit(stopped); finish({ thread: requests[0].thread, generation: stopped }); await send;
  assert.equal(room.tree.request, null);
  assert.equal(room.tree.turns.at(-1).status, 'stopped');
  assert.equal(room.tree.turns.at(-1).text, 'Push is ready.');
  assert.deepEqual(room.tree.turns.at(-1).results, generation.results);
  const { CoachMessage } = await loadScreen('products/gym/coach/CoachRoom.jsx');
  const message = renderHook(t, () => CoachMessage({ turn: room.tree.turns.at(-1), log: roomLog() }));
  assert.equal(textOf(findByClass(message.tree, 'gym-coach-note')[0]), 'Response stopped.');
  assert.equal(findByClass(message.tree, 'gym-coach-retry').length, 0);
});

test('a tombstoned known conversation exposes New chat recovery and never mints a replacement request on Retry', async (t) => {
  browserWith();
  const calls = [];
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', initialThread: { id: 'thr_old', turns: [] }, api: {
    ask: async (...args) => { calls.push(args.slice(0, 3)); throw new GymError(409, 'That conversation is unavailable.', 'ask-thread-taken'); },
  } }));
  room.tree.setDraft('Continue.'); await room.tree.send();
  assert.equal(room.tree.thread, 'thr_old');
  assert.equal(room.tree.closed, 'thread');
  await room.tree.send();
  assert.equal(calls.length, 1);
});

test('photo upload failure, reload and image-only send retain bytes, photo identity and account isolation', async (t) => {
  browserWith();
  const blobs = new Map();
  const photos = {
    prepare: async (blob) => ({ blob, mediaType: 'image/png', bytes: blob.size, width: 2, height: 3 }),
    save: async (account, thread, id, blob) => blobs.set(JSON.stringify([account, thread, id]), blob),
    load: async (account, thread, id) => blobs.get(JSON.stringify([account, thread, id])),
    remove: async (account, thread, id) => blobs.delete(JSON.stringify([account, thread, id])),
  };
  const uploads = [];
  const questions = [];
  const api = {
    thread: async () => null,
    uploadCoachPhoto: async (thread, id, blob, { onProgress }) => {
      uploads.push({ thread, id, blob });
      onProgress(0.5);
      if (uploads.length === 1) throw new Error('connection closed');
      return { id, mediaType: 'image/png', bytes: blob.size, width: 2, height: 3 };
    },
    askStream: async (thread, question, requestId, { attachmentIds, onSnapshot }) => {
      questions.push({ thread, question, requestId, attachmentIds });
      const reply = { thread, generation: { id: 'gen_1', requestId, question, at: 100, revision: 1, status: 'completed', answer: 'That is a barbell.',
        attachments: [{ id: attachmentIds[0], mediaType: 'image/png', width: 2, height: 3, bytes: 4 }] } };
      onSnapshot(reply); return reply;
    },
  };
  const blob = new Blob(['PNG!'], { type: 'image/png' });
  const first = renderHook(t, () => useCoachConversation({ accountId: 'alice', api, photos }));
  await first.tree.selectPhoto(blob);
  const photo = first.tree.photo;
  assert.equal(photo.status, 'failed');
  assert.equal(await photos.load('alice', first.tree.thread, photo.id), blob);
  assert.equal(await photos.load('bob', first.tree.thread, photo.id), undefined);
  assert.equal(JSON.stringify(readCoachDraft('alice')).includes('PNG!'), false);
  first.unmount();
  const second = renderHook(t, () => useCoachConversation({ accountId: 'alice', api, photos }));
  await settle();
  assert.equal(second.tree.photo.id, photo.id);
  assert.equal(second.tree.draft, '');
  await second.tree.send();
  assert.deepEqual(uploads, [uploads[0], uploads[0]]);
  assert.deepEqual(questions.map(({ thread, question, attachmentIds }) => ({ thread, question, attachmentIds })), [
    { thread: second.tree.thread, question: '', attachmentIds: [photo.id] },
  ]);
  assert.equal(second.tree.turns[0].text, '');
  assert.equal(second.tree.turns[0].attachments[0].id, photo.id);
  assert.equal(second.tree.photo, null);
  await settle();
  assert.equal(blobs.size, 0);
});

test('canceling an upload keeps the photo and caption, retry reuses its ID, and Remove drops only the draft', async (t) => {
  browserWith();
  const blobs = new Map();
  const photos = {
    prepare: async (blob) => ({ blob, mediaType: 'image/jpeg', bytes: blob.size, width: 2, height: 3 }),
    save: async (account, thread, id, blob) => blobs.set(id, blob),
    load: async (account, thread, id) => blobs.get(id),
    remove: async (account, thread, id) => blobs.delete(id),
  };
  const ids = [];
  const api = { uploadCoachPhoto: async (thread, id, blob, { signal }) => {
    ids.push(id);
    if (ids.length === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError'))));
    return { id, mediaType: 'image/jpeg', bytes: blob.size, width: 2, height: 3 };
  } };
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api, photos }));
  room.tree.setDraft('Is this the right equipment?');
  const upload = room.tree.selectPhoto(new Blob(['jpeg'], { type: 'image/jpeg' }));
  await settle();
  assert.equal(room.tree.photo.status, 'uploading');
  room.tree.cancelUpload(); await upload;
  assert.equal(room.tree.photo.status, 'failed');
  assert.equal(room.tree.photo.note, 'Upload canceled.');
  assert.equal(room.tree.draft, 'Is this the right equipment?');
  await room.tree.uploadPhoto();
  assert.deepEqual(ids, [ids[0], ids[0]]);
  await room.tree.removePhoto();
  assert.equal(room.tree.photo, null);
  assert.equal(room.tree.draft, 'Is this the right equipment?');
  assert.equal(blobs.size, 0);
});

test('an older Retry cannot replace the unresolved saved question', async (t) => {
  browserWith();
  const calls = [];
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', initialThread: { id: 'thr_1', turns: [
    { position: 0, from: 'lifter', requestId: 'ask_old', text: 'Old question.', at: 10 },
    { position: 1, from: 'ask', requestId: 'ask_old', text: '', at: 10, status: 'failed' },
  ] }, api: { ask: async (...args) => { calls.push(args); throw new Error('network gone'); } } }));
  room.tree.setDraft('New question.'); await room.tree.send();
  const saved = room.tree.request;
  await room.tree.send(room.tree.turns[1]);
  assert.deepEqual(room.tree.request, saved);
  assert.equal(calls.length, 1);
  assert.equal(room.tree.note, 'Retry your saved question before retrying another response.');
});

test('a disconnect after accepted Stop reconnects to the same request until stopped', async (t) => {
  browserWith();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let interrupt;
  const requests = [];
  let generation;
  const api = {
    askStream: (thread, question, requestId, options) => {
      requests.push({ thread, question, requestId });
      generation = { id: 'gen_1', requestId, question, at: 10, revision: requests.length, status: requests.length === 1 ? 'running' : 'stopped', answer: 'Partial.' };
      options.onSnapshot({ thread, generation });
      if (requests.length > 1) return Promise.resolve({ thread, generation });
      return new Promise((resolve, reject) => { interrupt = reject; });
    },
    stopCoach: async (thread) => ({ thread, generation: { ...generation, stopRequested: true } }),
  };
  const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api }));
  room.tree.setDraft('Help.');
  const first = room.tree.send(); await room.tree.stop();
  interrupt(new Error('connection closed')); await first;
  assert.equal(room.tree.pending, true);
  t.mock.timers.tick(2000); await settle();
  assert.deepEqual(requests, [requests[0], requests[0]]);
  assert.equal(room.tree.turns.at(-1).status, 'stopped');
  assert.equal(room.tree.request, null);
  assert.equal(room.tree.pending, false);
});

test('a delayed Stop response never retries a generation that failed while Stop was in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const responseStatus of ['failed', 'running']) {
    browserWith();
    const requests = [];
    let interrupt;
    let finishStop;
    let generation;
    const api = {
      askStream: (thread, question, requestId, { onSnapshot }) => {
        requests.push({ thread, question, requestId });
        generation = { id: 'gen_1', requestId, question, at: 10, revision: 1, status: 'running', answer: 'Push is ready.',
          results: [{ kind: 'routine-created', operationId: 'op_1', routineId: 'rt_1', routineName: 'Push' }] };
        onSnapshot({ thread, generation });
        return new Promise((resolve, reject) => { interrupt = reject; });
      },
      stopCoach: () => new Promise((resolve) => { finishStop = resolve; }),
    };
    const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api }));
    room.tree.setDraft('Create Push.');
    const send = room.tree.send();
    const stop = room.tree.stop();
    const failed = { ...generation, revision: 2, status: 'failed', stopRequested: true };
    interrupt(new GymError(502, 'Response interrupted.', '', { generation: failed }));
    await send;
    finishStop({ thread: room.tree.thread, generation: responseStatus === 'failed' ? failed : { ...generation, stopRequested: true } });
    await stop;
    t.mock.timers.tick(60000); await settle();
    assert.equal(requests.length, 1, responseStatus);
    assert.equal(room.tree.pending, false);
    assert.equal(room.tree.stopRequested, false);
    assert.equal(room.tree.busy, false);
    assert.equal(room.tree.request.requestId, requests[0].requestId);
    assert.equal(room.tree.turns.at(-1).status, 'failed');
    assert.equal(room.tree.turns.at(-1).text, 'Push is ready.');
    assert.deepEqual(room.tree.turns.at(-1).results, generation.results);
    room.unmount();
  }
});

test('a missing photo refusal reuploads retained bytes and retries the same immutable question', async (t) => {
  for (const ambiguous of [false, true]) {
    browserWith();
    const blobs = new Map();
    const photos = {
      prepare: async (blob) => ({ blob, mediaType: 'image/png', bytes: blob.size, width: 2, height: 3 }),
      save: async (account, thread, id, blob) => blobs.set(JSON.stringify([account, thread, id]), blob),
      load: async (account, thread, id) => blobs.get(JSON.stringify([account, thread, id])),
      remove: async (account, thread, id) => blobs.delete(JSON.stringify([account, thread, id])),
    };
    const uploads = [];
    const requests = [];
    let available = false;
    const api = {
      uploadCoachPhoto: async (thread, id, blob) => {
        uploads.push({ thread, id, blob });
        available = true;
        return { id, mediaType: 'image/png', bytes: blob.size, width: 2, height: 3 };
      },
      askStream: async (thread, question, requestId, { attachmentIds }) => {
        requests.push({ thread, question, requestId, attachmentIds });
        if (ambiguous && requests.length === 1) throw new Error('network closed');
        if (!available) throw new GymError(400, 'upload a valid photo for this conversation', 'ask-attachment-invalid');
        return { thread, generation: { id: 'gen_1', requestId, question, at: 100, revision: 1, status: 'completed', answer: 'That is a barbell.',
          attachments: [{ id: attachmentIds[0], mediaType: 'image/png', width: 2, height: 3, bytes: 4 }] } };
      },
    };
    const room = renderHook(t, () => useCoachConversation({ accountId: 'alice', api, photos }));
    const blob = new Blob(['PNG!'], { type: 'image/png' });
    room.tree.setDraft('What is this?');
    await room.tree.selectPhoto(blob);
    const photo = room.tree.photo;
    available = false;
    if (ambiguous) await room.tree.send();
    await room.tree.send();
    assert.equal(room.tree.photo.status, 'failed');
    assert.equal(room.tree.photo.id, photo.id);
    assert.equal(room.tree.request.requestId, requests[0].requestId);
    assert.equal(readCoachDraft('alice').request.requestId, requests[0].requestId);
    assert.equal(room.tree.draft, 'What is this?');
    assert.equal(await photos.load('alice', room.tree.thread, photo.id), blob);
    await room.tree.send();
    assert.deepEqual(uploads, [uploads[0], uploads[0]]);
    assert.deepEqual(requests, Array(ambiguous ? 3 : 2).fill(requests[0]));
    assert.equal(room.tree.turns.length, 2);
    assert.equal(room.tree.turns[0].attachments[0].id, photo.id);
    assert.equal(room.tree.turns[1].text, 'That is a barbell.');
    assert.equal(room.tree.request, null);
    assert.equal(room.tree.photo, null);
    room.unmount();
  }
});
