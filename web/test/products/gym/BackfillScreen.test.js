import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from './harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

function storeOnTheWire() {
  const sets = [];
  global.fetch = async (url, options = {}) => {
    const at = url.slice(`${API_BASE}/v1/gym`.length);
    const body = options.body ? JSON.parse(options.body) : null;
    if (at === '/sessions' && options.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: body.id }) };
    if (/^\/sessions\/[^/]+\/sets$/.test(at) && options.method === 'POST') {
      sets.push(body);
      return { ok: true, status: 201, json: async () => body };
    }
    if (/^\/sessions\/[^/]+\/finish$/.test(at)) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error(`unexpected ${options.method ?? 'GET'} ${at}`);
  };
  return sets;
}

test('a past workout’s line has no kind to choose, and every set it files is a working set', async (t) => {
  browserWith();
  const filed = storeOnTheWire();
  const { Backfill } = await loadScreen('products/gym/Backfill.jsx');
  const log = roomLog({ catalog: [{ id: 'back-squat', name: 'Back Squat' }] });
  const view = renderHook(t, () => Backfill({ log }));

  elementsOf(view.tree).find((each) => each.props.children === 'Add a movement').props.onClick();
  elementsOf(view.tree).find((each) => each.type?.name === 'MovementPicker').props.onPick('back-squat');

  const line = findByClass(view.tree, 'gym-line');
  assert.equal(line.length, 1);
  assert.deepEqual(elementsOf(line[0]).filter((each) => each.type === 'button').map(textOf), ['20 kg', '× 5', '−', '+', '×']);

  findByClass(view.tree, 'gym-save-do')[0].props.onClick();
  await settle(12);
  assert.deepEqual(filed.map((set) => [set.exerciseId, set.weightKg, set.reps, set.kind]), [
    ['back-squat', 20, 5, 'working'],
    ['back-squat', 20, 5, 'working'],
    ['back-squat', 20, 5, 'working'],
  ]);
});
