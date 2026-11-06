import test from 'node:test';
import assert from 'node:assert/strict';
import { closuresIn } from '../sourceClosures.js';
import { renderHook, settle } from '../../gym/harness.mjs';
import { useRoomTend } from '../../../../src/products/roadmap/tending/useTend.js';
import { runFace } from '../../../../src/products/roadmap/tending/receipts.js';

const tending = await closuresIn('tending/useTend.js');

for (const run of [null, { status: 'failed' }, { status: 'done', edits: 0 }, { status: 'refused', refusal: 'rate-limited' }]) {
  test(`Ask AI ${run?.status ?? 'transport failure'} reopens the bar only on failure and keeps its answer event`, () => {
    const face = runFace(run);
    const calls = [];
    const onFace = tending.callback('onTendFace', {
      setTendOpen: (open) => calls.push(['open', open]),
      setTendFailure: (line) => calls.push(['failure', line]),
      setTendDraft: (draft) => calls.push(['draft', draft]),
      tendVisitRef: { current: { open: false, dismissed: false } },
      track: (name, props) => calls.push(['event', name, { ...props }]),
      showToast: (line, options) => calls.push(['toast', line, { ...options }]),
    });
    onFace(face);
    assert.deepEqual(calls, [
      ...(face.kind === 'failed' ? [['failure', face.line], ['open', true]] : [['draft', ''], ['failure', ''], ['open', false]]),
      ['event', 'roadmap_verb', { verb: 'askAI', step: 'answer', outcome: face.kind }],
      ['toast', face.line, { surface: 'tend', holdMs: face.kind === 'receipt' ? 6000 : 5000,
        detail: face.kind === 'receipt' ? face.detail : undefined, action: undefined }],
    ]);
  });
}


for (const dismissed of [false, true]) {
  test(`a failed submitted draft ${dismissed ? 'stays closed after explicit dismissal and returns on next open' : 'reopens after submit closes it'}`, async (t) => {
    let answer;
    const response = new Promise((resolve) => { answer = resolve; });
    const sent = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url.endsWith('/v1/tending')) return { ok: true, json: async () => ({ enabled: true }) };
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => response };
    });
    const toasts = [];
    const showToast = (line, options) => toasts.push({ line, options });
    const room = { sessionRef: { current: null }, sceneRef: { current: null } };
    const view = renderHook(t, () => useRoomTend({ treeId: 'sail', treeMine: true, status: 'signed-in', room, showToast }));
    await settle();
    assert.equal(view.tree.canTend, true);
    const sentence = '  Add a practice step  ';
    view.tree.setTendOpen(true);
    view.tree.setTendDraft(sentence);
    const submission = view.tree.submitTend(view.tree.tendDraft);
    const state = () => ({ open: view.tree.tendOpen, draft: view.tree.tendDraft, working: view.tree.tendWorking, failure: view.tree.tendFailure });
    assert.deepEqual(state(), { open: false, draft: sentence, working: true, failure: '' });
    assert.deepEqual(sent, [{ prompt: sentence.trim() }]);
    if (dismissed) {
      view.tree.setTendOpen((open) => !open);
      assert.equal(view.tree.tendOpen, true);
      view.tree.setTendOpen(false);
    }
    answer({ status: 'failed' });
    await submission;
    const failure = runFace({ status: 'failed' }).line;
    assert.deepEqual(state(), { open: !dismissed, draft: sentence, working: false, failure });
    assert.deepEqual(toasts, [{ line: failure, options: { surface: 'tend', holdMs: 5000, detail: undefined, action: undefined } }]);
    view.tree.setTendOpen(false);
    view.tree.setTendOpen(true);
    assert.deepEqual(state(), { open: true, draft: sentence, working: false, failure });
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ status: 'done', edits: 0 }) }));
    const retry = view.tree.submitTend(view.tree.tendDraft);
    assert.deepEqual(state(), { open: false, draft: sentence, working: true, failure: '' });
    await retry;
    assert.deepEqual(state(), { open: false, draft: '', working: false, failure: '' });
    view.tree.setTendOpen(true);
    assert.deepEqual(state(), { open: true, draft: '', working: false, failure: '' });
  });
}

test('only an accepted Ask AI submission closes the bar and saves the exact draft before sending trimmed text', async () => {
  for (const [working, prompt] of [[false, '  Try this again  '], [true, 'Try this again'], [false, '  ']]) {
    const calls = [];
    const face = runFace({ status: 'failed' });
    const submit = tending.callback('submit', {
      working, treeId: 'sail', aliveRef: { current: true },
      onStart: (value) => calls.push(['start draft', value]),
      setWorking: (value) => calls.push(['working', value]),
      track: (name, props) => calls.push(['event', name, { ...props }]),
      startTend: async (id, value) => { calls.push(['send', id, value]); return null; },
      runFace: () => face,
      onFace: (value) => calls.push(['face', value]),
    });
    await submit(prompt);
    assert.deepEqual(calls, working || !prompt.trim() ? [] : [
      ['start draft', prompt], ['working', true],
      ['event', 'roadmap_verb', { verb: 'askAI', step: 'send' }],
      ['send', 'sail', prompt.trim()], ['working', false], ['face', face],
    ]);
  }
});
