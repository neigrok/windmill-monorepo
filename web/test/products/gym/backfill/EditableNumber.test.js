import test from 'node:test';
import assert from 'node:assert/strict';

import { browserWith, loadScreen, renderHook } from '../harness.mjs';

// The cell as the form holds it: a commit becomes the value it is drawn with next.
async function cell(t, { value: opening, ...props }) {
  const { EditableNumber } = await loadScreen('products/gym/backfill/EditableNumber.jsx');
  const commits = [];
  let value = opening;
  const view = renderHook(t, () => EditableNumber({
    field: 'load',
    label: 'load',
    value,
    onCommit: (next) => {
      commits.push(next);
      value = next;
      view.redraw();
    },
    ...props,
  }));
  return { view, commits, input: () => view.tree.props };
}

const key = (name, extra = {}) => ({ key: name, shiftKey: false, preventDefault: () => {}, currentTarget: {}, ...extra });

test('a number is typed where it is drawn: bodyweight reads its word until it is focused, and a commit lands on the way out', async (t) => {
  browserWith();
  const { commits, input } = await cell(t, { value: 0 });
  assert.deepEqual([input().value, input().inputMode, input()['data-field']], ['bodyweight', 'decimal', 'load']);
  input().onFocus({ currentTarget: {} });
  assert.equal(input().value, '0');
  input().onChange({ target: { value: '62,5' } });
  input().onBlur();
  assert.deepEqual(commits, [62.5]);
  assert.equal(input().value, '62.5', 'the cell draws what the form now holds');
});

test('text that is not a number is dropped and the value stands; an emptied cell is an empty value', async (t) => {
  browserWith();
  const { commits, input } = await cell(t, { value: 60 });
  input().onFocus({ currentTarget: {} });
  input().onChange({ target: { value: '6o' } });
  input().onBlur();
  input().onFocus({ currentTarget: {} });
  input().onChange({ target: { value: '' } });
  input().onBlur();
  assert.deepEqual(commits, [null]);
});

test('a number is committed when it is typed or confirmed, even the one already drawn, and never by passing through', async (t) => {
  browserWith();
  const { commits, input } = await cell(t, { value: 60 });
  input().onFocus({ currentTarget: {} });
  input().onBlur();
  assert.deepEqual(commits, [], 'tabbing through writes nothing');
  input().onFocus({ currentTarget: {} });
  input().onChange({ target: { value: '60' } });
  input().onBlur();
  assert.deepEqual(commits, [60], 'typing the same number chooses it');
  input().onFocus({ currentTarget: {} });
  input().onKeyDown(key('Enter', { currentTarget: { closest: () => ({ querySelectorAll: () => [] }), blur: () => {} } }));
  assert.deepEqual(commits, [60, 60], 'Enter confirms it');
});

test('↑ and ↓ step the load by the plate step and the reps by one, each step a commit', async (t) => {
  browserWith();
  const load = await cell(t, { value: 60, stepKg: 1.25 });
  load.input().onFocus({ currentTarget: {} });
  load.input().onKeyDown(key('ArrowUp'));
  load.input().onKeyDown(key('ArrowUp'));
  assert.deepEqual(load.commits, [61.25, 62.5]);
  assert.equal(load.input().value, '62.5');
  const reps = await cell(t, { value: 1, field: 'reps' });
  reps.input().onKeyDown(key('ArrowDown'));
  reps.input().onKeyDown(key('ArrowUp'));
  assert.deepEqual(reps.commits, [1, 2], 'a step held at its bound still chooses the number');
  assert.equal(reps.input().inputMode, 'numeric');
});

test('a carried number wears one of two lift names, so the next carry restarts it, and waits its turn', async (t) => {
  browserWith();
  const first = await cell(t, { value: 60, lift: { stamp: 1, delay: 40 } });
  assert.deepEqual([first.input().className, first.input().style['--lift-delay']], ['gym-num is-lifted-1', '40ms']);
  const second = await cell(t, { value: 60, lift: { stamp: 2, delay: 0 } });
  assert.equal(second.input().className, 'gym-num is-lifted-0');
  const still = await cell(t, { value: 60 });
  assert.deepEqual([still.input().className, still.input().style], ['gym-num', { '--gym-number-chars': 2 }]);
});
