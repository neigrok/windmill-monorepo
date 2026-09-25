import test from 'node:test';
import assert from 'node:assert/strict';
import { spellWeightsIn, weightUnit } from '../../../../src/products/gym/units.js';
import { logShareApi } from '../../../../src/products/gym/share/logShareApi.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, settle, textOf } from '../harness.mjs';

function button(tree, label) {
  return elementsOf(tree).find((element) => (element.type === 'button' || element.type?.name === 'Button') && element.props.children === label);
}

test('setup previews without mutation, requires a successful read, and retries creation with the same identity', async (t) => {
  browserWith();
  t.mock.method(logShareApi, 'list', async () => []);
  t.mock.method(logShareApi, 'preview', async () => ({ sessions: [], summary: { sessions: 0 } }));
  const requests = [];
  t.mock.method(logShareApi, 'create', async (body) => {
    requests.push(body);
    if (requests.length === 1) throw new Error('Connection lost');
    return { ...body, url: 'https://windmill.test/#/gym/shared-log/token', expiresAt: 1000 };
  });
  const { LogShareScreen } = await loadScreen('products/gym/share/LogShare.jsx');
  const screen = renderHook(t, () => LogShareScreen());
  await settle();
  assert.equal(findByClass(screen.tree, 'gym-share-active').length, 0);
  button(screen.tree, 'Preview').props.onClick();
  assert.deepEqual(requests, []);
  assert.equal(button(screen.tree, 'Create link').props.disabled, true);
  const reader = elementsOf(screen.tree).find((element) => element.type?.name === 'ReadOnlyLog');
  reader.props.onReady(true);
  await button(screen.tree, 'Create link').props.onClick();
  assert.equal(requests.length, 1);
  await button(screen.tree, 'Create link').props.onClick();
  assert.deepEqual(requests, [requests[0], requests[0]]);
  assert.equal(textOf(findByClass(screen.tree, 'gym-title')[0]), 'Share log');
  assert.equal(textOf(findByClass(screen.tree, 'gym-share-subtitle')[0]), 'Link ready');
});

test('active links retain scope and expiry, copy exact URL, and revoke into a receipt', async (t) => {
  browserWith();
  const share = { id: 'link', mode: 'live', scope: 'all', url: 'https://windmill.test/#/gym/shared-log/token', expiresAt: 1000 };
  t.mock.method(logShareApi, 'list', async () => [share]);
  t.mock.method(logShareApi, 'preview', async () => ({ sessions: [], summary: { sessions: 0 } }));
  const revoke = t.mock.method(logShareApi, 'revoke', async () => null);
  const copied = [];
  navigator.clipboard = { writeText: async (value) => copied.push(value) };
  const { LogShareScreen } = await loadScreen('products/gym/share/LogShare.jsx');
  const screen = renderHook(t, () => LogShareScreen()); await settle();
  findByClass(screen.tree, 'gym-share-active-row')[0].props.onClick();
  await button(screen.tree, 'Copy link').props.onClick();
  assert.deepEqual(copied, [share.url]);
  await button(screen.tree, 'Revoke link').props.onClick();
  assert.deepEqual(revoke.mock.calls[0].arguments, ['link']);
  assert.equal(textOf(findByClass(screen.tree, 'gym-share-subtitle')[0]), 'Link revoked');
  assert.equal(button(screen.tree, 'Copy link'), undefined);
});

test('a public deep link loads bounded pages until the selected workout and never calls an owner read', async (t) => {
  browserWith();
  const calls = [];
  t.mock.method(logShareApi, 'read', async (token, query) => {
    calls.push({ token, query });
    const older = Boolean(query.before);
    return { sessions: [{ id: older ? 'older' : 'newer', startedAt: older ? 10 : 20, sets: [] }], next: older ? null : { before: 20, beforeId: 'newer' }, summary: { sessions: 2, sets: 0, reps: 0, tonnageKg: 0 }, months: [], exercises: [], routines: [], share: { mode: 'snapshot', scope: 'all' } };
  });
  t.mock.method(logShareApi, 'preview', () => { throw new Error('owner API must not be used'); });
  const { ReadOnlyLog } = await loadScreen('products/gym/share/LogShare.jsx');
  const screen = renderHook(t, () => ReadOnlyLog({ token: 'token', hash: '#/gym/shared-log/token?session=older' }));
  await settle(); await settle();
  const reader = elementsOf(screen.tree).find((element) => element.type?.name === 'SharedWorkoutReader');
  assert.equal(reader.props.session.id, 'older');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.deepEqual(calls, [
    { token: 'token', query: { timeZone, limit: 1 } },
    { token: 'token', query: { timeZone, limit: 50 } },
    { token: 'token', query: { before: 20, beforeId: 'newer', timeZone, limit: 50 } },
  ]);
});

test('shared collapsed and expanded sets stay in kilograms without changing the owner pounds preference', async (t) => {
  browserWith();
  const originalUnit = weightUnit();
  spellWeightsIn('lb');
  t.after(() => spellWeightsIn(originalUnit));
  const { SharedWorkoutReader } = await loadScreen('products/gym/share/LogShare.jsx');
  const session = { id: 'workout', routineName: 'Push A', startedAt: 1000, finishedAt: 61000, workingSetCount: 2, reps: 16, tonnageKg: 960,
    movements: [{ exerciseId: 'bench', sets: 2, reps: 16, tonnageKg: 960 }],
    sets: [{ id: 'first', exerciseId: 'bench', exercise: 'Bench Press', reps: 8, weightKg: 60 }, { id: 'second', exerciseId: 'bench', exercise: 'Bench Press', reps: 8, weightKg: 60 }] };
  const screen = renderHook(t, () => SharedWorkoutReader({ session }));
  assert.deepEqual(findByClass(screen.tree, 'gym-share-scheme').map(textOf), ['2 × 8 · 60']);
  findByClass(screen.tree, 'gym-share-scheme')[0].props.onClick();
  assert.deepEqual(elementsOf(findByClass(screen.tree, 'gym-share-sets')[0]).filter((element) => element.type === 'li').map(textOf), ['60×8', '60×8']);
  assert.equal(findByClass(screen.tree, 'gym-movement-expand')[0].props['aria-label'], 'Collapse Bench Press');
  findByClass(screen.tree, 'gym-movement-expand')[0].props.onClick();
  assert.deepEqual(findByClass(screen.tree, 'gym-share-scheme').map(textOf), ['2 × 8 · 60']);
  assert.equal(findByClass(screen.tree, 'gym-movement-expand')[0].props['aria-expanded'], false);
  assert.equal(weightUnit(), 'lb');
});

test('narrow preview opens the history list and permits selecting a workout without leaving preview', async (t) => {
  browserWith();
  window.matchMedia = () => ({ matches: false });
  t.mock.method(logShareApi, 'preview', async () => ({ sessions: [{ id: 'latest', startedAt: 1000, finishedAt: 2000, sets: [] }], summary: { sessions: 1, sets: 0, reps: 0, tonnageKg: 0 }, months: [], exercises: [], routines: [], next: null }));
  const { ReadOnlyLog } = await loadScreen('products/gym/share/LogShare.jsx');
  const preview = { id: 'draft', mode: 'snapshot', scope: 'all' };
  const screen = renderHook(t, () => ReadOnlyLog({ preview }));
  await settle();
  assert.equal(elementsOf(screen.tree).some((element) => element.type?.name === 'SharedWorkoutReader'), false);
  findByClass(screen.tree, 'gym-history-index')[0].props.onClick({ preventDefault() {}, target: { closest: () => ({ getAttribute: () => '#/gym/shared-log/preview?session=latest' }) } });
  const reader = elementsOf(screen.tree).find((element) => element.type?.name === 'SharedWorkoutReader');
  assert.equal(reader.props.session.id, 'latest');
  reader.props.onBack();
  assert.equal(elementsOf(screen.tree).some((element) => element.type?.name === 'SharedWorkoutReader'), false);
  assert.equal(window.location.hash, '#/gym');
});

test('public date controls stay mounted while a new year is loading', async (t) => {
  browserWith();
  let finish;
  const page = { sessions: [], summary: { sessions: 0, sets: 0, reps: 0, tonnageKg: 0 }, months: [{ month: '2024-01', sessions: 1 }], exercises: [], routines: [], next: null };
  t.mock.method(logShareApi, 'read', async (token, query) => query.from ? new Promise((resolve) => { finish = resolve; }) : page);
  const { ReadOnlyLog } = await loadScreen('products/gym/share/LogShare.jsx');
  let hash = '#/gym/shared-log/token';
  const screen = renderHook(t, () => ReadOnlyLog({ token: 'token', hash }));
  await settle();
  hash += '?year=2024'; screen.redraw();
  const date = elementsOf(screen.tree).find((element) => element.type?.name === 'DateJump');
  assert.equal(date.props.year, 2024);
  assert.equal(textOf(findByClass(screen.tree, 'gym-quiet')[0]), 'Opening the shared log…');
  assert.equal(findByClass(screen.tree, 'gym-history-empty').length, 0);
  finish(page); await settle();
  assert.equal(findByClass(screen.tree, 'gym-history-empty').length, 1);
});

test('desktop filtered history selects its first matching workout while narrow keeps the list', async (t) => {
  browserWith();
  let wide = true;
  window.matchMedia = () => ({ matches: wide });
  t.mock.method(logShareApi, 'read', async () => ({ sessions: [{ id: 'june', startedAt: 20, sets: [] }, { id: 'january', startedAt: 10, sets: [] }], summary: { sessions: 2, sets: 0, reps: 0, tonnageKg: 0 }, months: [], exercises: [], routines: [], next: null }));
  const { ReadOnlyLog } = await loadScreen('products/gym/share/LogShare.jsx');
  let hash = '#/gym/shared-log/token?year=2024';
  const screen = renderHook(t, () => ReadOnlyLog({ token: 'token', hash }));
  await settle();
  const reader = () => elementsOf(screen.tree).find((element) => element.type?.name === 'SharedWorkoutReader');
  assert.equal(reader().props.session.id, 'june');
  hash += '&session=january'; screen.redraw();
  assert.equal(reader().props.session.id, 'january');
  hash = '#/gym/shared-log/token?year=2024'; wide = false; screen.redraw();
  assert.equal(reader(), undefined);
  assert.equal(findByClass(screen.tree, 'gym-history-index').length, 1);
});
