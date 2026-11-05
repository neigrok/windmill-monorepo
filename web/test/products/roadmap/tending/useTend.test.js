import test from 'node:test';
import assert from 'node:assert/strict';
import { closuresIn } from '../sourceClosures.js';
import { runFace } from '../../../../src/products/roadmap/tending/receipts.js';

const tending = await closuresIn('tending/useTend.js');

for (const run of [null, { status: 'failed' }, { status: 'done', edits: 0 }, { status: 'refused', refusal: 'rate-limited' }]) {
  test(`Ask AI ${run?.status ?? 'transport failure'} preserves the bar only on failure and keeps its answer event`, () => {
    const face = runFace(run);
    const calls = [];
    const onFace = tending.callback('onTendFace', {
      setTendOpen: (open) => calls.push(['open', open]),
      setTendFailure: (line) => calls.push(['failure', line]),
      track: (name, props) => calls.push(['event', name, { ...props }]),
      showToast: (line, options) => calls.push(['toast', line, { ...options }]),
    });
    onFace(face);
    assert.deepEqual(calls, [
      ...(face.kind === 'failed' ? [['failure', face.line]] : [['open', false]]),
      ['event', 'roadmap_verb', { verb: 'askAI', step: 'answer', outcome: face.kind }],
      ['toast', face.line, { surface: 'tend', holdMs: face.kind === 'receipt' ? 6000 : 5000,
        detail: face.kind === 'receipt' ? face.detail : undefined, action: undefined }],
    ]);
  });
}


test('opening, closing and toggling Ask AI clear its previous failure without owning the sentence', () => {
  const toggle = (open) => !open;
  for (const next of [true, false, toggle]) {
    const calls = [];
    const setOpen = tending.callback('setTendOpen', {
      setTendFailure: (line) => calls.push(['failure', line]),
      updateTendOpen: (value) => calls.push(['open', value]),
    });
    setOpen(next);
    assert.deepEqual(calls, [['failure', ''], ['open', next]]);
  }
});

test('only an accepted Ask AI submission clears the previous announcement before sending', async () => {
  for (const [working, prompt] of [[false, 'Try this again'], [true, 'Try this again'], [false, '  ']]) {
    const calls = [];
    const face = runFace({ status: 'failed' });
    const submit = tending.callback('submit', {
      working, treeId: 'sail', aliveRef: { current: true },
      onStart: tending.callback('clearTendFailure', { setTendFailure: (line) => calls.push(['failure', line]) }),
      setWorking: (value) => calls.push(['working', value]),
      track: (name, props) => calls.push(['event', name, { ...props }]),
      startTend: async (id, value) => { calls.push(['start', id, value]); return null; },
      runFace: () => face,
      onFace: (value) => calls.push(['face', value]),
    });
    await submit(prompt);
    assert.deepEqual(calls, working || !prompt.trim() ? [] : [
      ['failure', ''], ['working', true],
      ['event', 'roadmap_verb', { verb: 'askAI', step: 'send' }],
      ['start', 'sail', prompt], ['working', false], ['face', face],
    ]);
  }
});
