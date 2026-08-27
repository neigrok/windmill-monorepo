import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { dateLocalOf, joinsAcross } from '../../../../src/products/gym/bodyweight/bodyweight.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from '../harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const TODAY = dateLocalOf(Date.now());

// The bodyweight wire: the series read, PUTs answered with the stored row, DELETEs with nothing.
function weighInsOnTheWire(entries, { putStatus = 200, putBody = null } = {}) {
  const wire = [];
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    wire.push({ method, path, body: options.body ? JSON.parse(options.body) : null });
    if (path === '/bodyweight' && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ entries, latest: entries[entries.length - 1] ?? null }) };
    }
    if (path.startsWith('/bodyweight/') && method === 'PUT') {
      if (putStatus !== 200) return { ok: false, status: putStatus, json: async () => putBody };
      const sent = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ entry: { dateLocal: decodeURIComponent(path.slice('/bodyweight/'.length)), ...sent } }) };
    }
    if (path.startsWith('/bodyweight/') && method === 'DELETE') return { ok: true, status: 204, json: async () => { throw new Error('no body'); } };
    if (path === '/exercises') return { ok: true, status: 200, json: async () => ({ exercises: [] }) };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return wire;
}

const quietLog = () => roomLog();

const sheetOf = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'WeighInSheet');
const chipOf = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'WeighInChip');
const chartOf = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'DotChart');

test('the log’s head reads the last weigh-in and its age, and draws nothing at all without one', async (t) => {
  browserWith();
  weighInsOnTheWire([{ dateLocal: TODAY, weightKg: 82.4, recordedAt: 1 }]);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const screen = renderHook(t, () => LogList({ log: quietLog(), onSignIn: () => {} }));
  await settle();
  const reading = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'BodyweightReading');
  assert.deepEqual(reading.props.latest, { dateLocal: TODAY, weightKg: 82.4, recordedAt: 1 });

  const { BodyweightReading } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const drawn = BodyweightReading({ latest: { dateLocal: TODAY, weightKg: 82.4 } });
  assert.equal(drawn.props.href, '#/gym/bodyweight');
  assert.equal(textOf(drawn), '82.4 kg · today');
  assert.equal(BodyweightReading({ latest: null }), null, 'no dash, no zero, nothing');
});

test('the chip in the reach band is the one door onto a weigh-in; saving sends the row and the head reads it back', async (t) => {
  browserWith();
  const wire = weighInsOnTheWire([]);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const screen = renderHook(t, () => LogList({ log: quietLog(), onSignIn: () => {} }));
  await settle();
  const chip = chipOf(screen.tree);
  const { WeighInChip } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  assert.equal(textOf(findByClass(WeighInChip({ onOpen: () => {} }), 'gym-reach-chip')[0]), 'Weigh in');
  assert.equal(sheetOf(screen.tree), undefined);
  chip.props.onOpen();
  const sheet = sheetOf(screen.tree);
  assert.notEqual(sheet, undefined);
  assert.equal(sheet.props.fixedDate ?? null, null, 'from the chip the date is free and defaults to today');
  assert.equal(sheet.props.onDelete ?? null, null, 'nothing to delete yet');

  const refused = await sheet.props.onSave({ dateLocal: TODAY, weightKg: 82.4, recordedAt: 7 });
  assert.equal(refused, null);
  assert.deepEqual(wire[wire.length - 1], { method: 'PUT', path: `/bodyweight/${TODAY}`, body: { weightKg: 82.4, recordedAt: 7 } });
  assert.equal(sheetOf(screen.tree), undefined, 'the sheet closes on a landed write');
  const reading = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'BodyweightReading');
  assert.deepEqual(reading.props.latest, { dateLocal: TODAY, weightKg: 82.4, recordedAt: 7 });
  assert.equal(elementsOf(screen.tree).filter((each) => typeof each.type === 'function' && each.type.name === 'WeighInChip').length, 1, 'one door, at every scroll position');
  assert.equal(findByClass(screen.tree, 'gym-keypad').length, 0);
});

test('a refused save shows the store’s own sentence in the sheet and leaves it open', async (t) => {
  browserWith();
  weighInsOnTheWire([], { putStatus: 400, putBody: { error: 'Between 20 and 400 kg — check the number.' } });
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const screen = renderHook(t, () => LogList({ log: quietLog(), onSignIn: () => {} }));
  await settle();
  chipOf(screen.tree).props.onOpen();
  const refused = await sheetOf(screen.tree).props.onSave({ dateLocal: TODAY, weightKg: 420, recordedAt: 7 });
  assert.equal(refused, 'Between 20 and 400 kg — check the number.');
  assert.notEqual(sheetOf(screen.tree), undefined);
});

test('the sheet: a plain decimal field with the hint once, a date defaulting to today, refusals one at a time on Save', async (t) => {
  browserWith();
  const { WeighInSheet } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const saved = [];
  const screen = renderHook(t, () => WeighInSheet({ onSave: async (write) => { saved.push(write); return null; }, onClose: () => {} }));

  const input = findByClass(screen.tree, 'gym-weigh-input')[0];
  assert.equal(input.props.inputMode, 'decimal');
  assert.equal(input.props.type, 'text');
  assert.equal(findByClass(screen.tree, 'gym-weigh-hint').length, 1);
  assert.equal(textOf(findByClass(screen.tree, 'gym-weigh-hint')[0]), 'comma or point, both read as a decimal');
  assert.equal(findByClass(screen.tree, 'gym-weigh-date-input')[0].props.type, 'date');
  assert.equal(findByClass(screen.tree, 'gym-weigh-date-input')[0].props.value, TODAY);
  assert.equal(findByClass(screen.tree, 'gym-weigh-date-input')[0].props.max, TODAY, 'the picker’s range ends today');
  assert.equal(findByClass(screen.tree, 'gym-rungs').length, 0, 'no ladder');
  assert.equal(findByClass(screen.tree, 'gym-weigh-delete').length, 0, 'nothing to delete from the chip');

  findByClass(screen.tree, 'gym-weigh-save')[0].props.onClick();
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-weigh-refusal')[0]), 'That is not a number yet.');
  assert.deepEqual(saved, []);

  findByClass(screen.tree, 'gym-weigh-input')[0].props.onChange({ target: { value: '82,4,1' } });
  assert.equal(findByClass(screen.tree, 'gym-weigh-refusal').length, 0, 'typing clears the refusal');
  findByClass(screen.tree, 'gym-weigh-save')[0].props.onClick();
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-weigh-refusal')[0]), 'One decimal point only.');

  findByClass(screen.tree, 'gym-weigh-input')[0].props.onChange({ target: { value: '482' } });
  findByClass(screen.tree, 'gym-weigh-save')[0].props.onClick();
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-weigh-refusal')[0]), 'Between 20 and 400 kg — check the number.');

  findByClass(screen.tree, 'gym-weigh-input')[0].props.onChange({ target: { value: '82,4' } });
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  findByClass(screen.tree, 'gym-weigh-date-input')[0].props.onChange({ target: { value: dateLocalOf(tomorrow.getTime()) } });
  assert.equal(findByClass(screen.tree, 'gym-weigh-refusal').length, 0, 'changing the date clears the refusal');
  findByClass(screen.tree, 'gym-weigh-save')[0].props.onClick();
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-weigh-refusal')[0]), 'A weigh-in is not a forecast — today or earlier.');
  assert.deepEqual(saved, [], 'a forecast never reaches the wire');

  findByClass(screen.tree, 'gym-weigh-date-input')[0].props.onChange({ target: { value: '2026-08-20' } });
  findByClass(screen.tree, 'gym-weigh-save')[0].props.onClick();
  await settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].dateLocal, '2026-08-20');
  assert.equal(saved[0].weightKg, 82.4);
  assert.equal(typeof saved[0].recordedAt, 'number');
});

test('the same sheet from a dot: the date fixed, the number prefilled, and a confirmed delete', async (t) => {
  browserWith();
  const { WeighInSheet } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const deleted = [];
  const screen = renderHook(t, () => WeighInSheet({
    entry: { dateLocal: '2026-08-20', weightKg: 82.45, recordedAt: 1 },
    fixedDate: '2026-08-20',
    onSave: async () => null,
    onDelete: async (dateLocal) => { deleted.push(dateLocal); return null; },
    onClose: () => {},
  }));
  assert.equal(findByClass(screen.tree, 'gym-weigh-input')[0].props.value, '82.45');
  assert.equal(findByClass(screen.tree, 'gym-weigh-date-input').length, 0, 'the date is fixed to that day');
  assert.equal(textOf(findByClass(screen.tree, 'gym-weigh-date-fixed')[0]), 'Thu 20 Aug');
  assert.equal(textOf(findByClass(screen.tree, 'gym-weigh-delete')[0]), 'Delete weigh-in');
  assert.equal(findByClass(screen.tree, 'gym-confirm').length, 0);

  findByClass(screen.tree, 'gym-weigh-delete')[0].props.onClick();
  assert.equal(textOf(findByClass(screen.tree, 'gym-confirm-title')[0]), 'Delete this weigh-in?');
  assert.equal(textOf(findByClass(screen.tree, 'gym-confirm-keep')[0]), 'Keep it');
  assert.equal(textOf(findByClass(screen.tree, 'gym-confirm-do')[0]), 'Delete');
  assert.equal(findByClass(screen.tree, 'gym-weigh-save').length, 0, 'one question at a time');
  findByClass(screen.tree, 'gym-confirm-keep')[0].props.onClick();
  assert.equal(findByClass(screen.tree, 'gym-confirm').length, 0);
  assert.deepEqual(deleted, []);

  findByClass(screen.tree, 'gym-weigh-delete')[0].props.onClick();
  findByClass(screen.tree, 'gym-confirm-do')[0].props.onClick();
  await settle();
  assert.deepEqual(deleted, ['2026-08-20']);
});

test('the chart screen: a dot per weigh-in in the stated window, the rule printed, a dot opening the repair sheet', async (t) => {
  browserWith();
  const today = new Date();
  const daysAgo = (days) => { const day = new Date(today); day.setDate(day.getDate() - days); return dateLocalOf(day.getTime()); };
  const wire = weighInsOnTheWire([
    { dateLocal: daysAgo(120), weightKg: 84, recordedAt: 1 },
    { dateLocal: daysAgo(30), weightKg: 83.1, recordedAt: 2 },
    { dateLocal: daysAgo(2), weightKg: 82.4, recordedAt: 3 },
  ]);
  const { BodyweightScreen } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const screen = renderHook(t, () => BodyweightScreen());
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-title')[0]), 'Bodyweight');

  const chart = chartOf(screen.tree);
  assert.equal(chart.props.points.length, 2, 'the 90-day window by default');
  assert.equal(chart.props.caption, 'last 90 days · 2 weigh-ins');
  assert.equal(chart.props.rule, 'no line is drawn across a gap longer than seven days');
  assert.equal(chart.props.joins, joinsAcross, 'segments join by calendar days, not elapsed hours');
  assert.equal(chart.props.domain.to, new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime());
  assert.equal(chipOf(screen.tree), undefined, 'no second door onto a new weigh-in');

  const tabs = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'Tabs');
  assert.deepEqual(tabs.props.tabs, [{ value: '90', label: '90 days' }, { value: 'all', label: 'All' }]);
  assert.equal(tabs.props.value, '90');
  tabs.props.onChange('all');
  assert.equal(chartOf(screen.tree).props.points.length, 3);
  assert.equal(chartOf(screen.tree).props.caption, 'the whole series · 3 weigh-ins');

  chartOf(screen.tree).props.onPick(chartOf(screen.tree).props.points[1]);
  const sheet = sheetOf(screen.tree);
  assert.equal(sheet.props.fixedDate, daysAgo(30));
  assert.equal(sheet.props.entry.weightKg, 83.1);
  assert.equal(typeof sheet.props.onDelete, 'function');

  const refused = await sheet.props.onDelete(daysAgo(30));
  assert.equal(refused, null);
  assert.deepEqual(wire[wire.length - 1], { method: 'DELETE', path: `/bodyweight/${daysAgo(30)}`, body: null });
  assert.equal(sheetOf(screen.tree), undefined);
  assert.equal(chartOf(screen.tree).props.points.length, 2);
  assert.equal(chartOf(screen.tree).props.caption, 'the whole series · 2 weigh-ins');
});

test('a served row dated after the device’s local today is never the reading at the log’s head and never a dot', async (t) => {
  browserWith();
  const forecast = { dateLocal: '2031-01-05', weightKg: 70, recordedAt: 9 };
  weighInsOnTheWire([{ dateLocal: TODAY, weightKg: 82.4, recordedAt: 1 }, forecast]);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const log = renderHook(t, () => LogList({ log: quietLog(), onSignIn: () => {} }));
  await settle();
  const reading = elementsOf(log.tree).find((each) => typeof each.type === 'function' && each.type.name === 'BodyweightReading');
  assert.deepEqual(reading.props.latest, { dateLocal: TODAY, weightKg: 82.4, recordedAt: 1 }, 'the wire’s `latest` is not the reading; the newest past day is');

  const { BodyweightScreen } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const screen = renderHook(t, () => BodyweightScreen());
  await settle();
  assert.deepEqual(chartOf(screen.tree).props.points.map((point) => point.dateLocal), [TODAY]);
  assert.equal(chartOf(screen.tree).props.caption, 'last 90 days · 1 weigh-in');
  const tabs = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'Tabs');
  tabs.props.onChange('all');
  assert.deepEqual(chartOf(screen.tree).props.points.map((point) => point.dateLocal), [TODAY]);
});

test('the chart screen with nothing to draw says so in words and draws no frame', async (t) => {
  browserWith();
  weighInsOnTheWire([]);
  const { BodyweightScreen } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const screen = renderHook(t, () => BodyweightScreen());
  await settle();
  assert.equal(chartOf(screen.tree), undefined);
  const quiet = findByClass(screen.tree, 'gym-quiet').map(textOf);
  assert.deepEqual(quiet, ['No weigh-ins yet.', 'Weigh in from the log and the number lands here.']);
});
