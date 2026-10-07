import test from 'node:test';
import assert from 'node:assert/strict';

import { gymMoment } from '../../../../src/products/gym/gymRuntime.js';
import {
  browserWith, confirmed, elementsOf, findByClass, gymAccount, loadScreen, renderHook, roomLog, settle, textOf,
} from '../harness.mjs';

const TODAY = gymMoment(Date.now()).today.text;

// The account's weigh-ins as the server confirmed them.
const weighIns = (entries) => entries.map(({ dateLocal, weightKg, recordedAt }) => confirmed('weighin', dateLocal, { kg: weightKg, recordedAt }));

const quietLog = () => roomLog();

const sheetOf = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'WeighInSheet');
const chartOf = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'DotChart');

test('the log options read the last weigh-in and its age, and draw nothing at all without one', async (t) => {
  browserWith();
  await gymAccount(t, weighIns([{ dateLocal: TODAY, weightKg: 82.4, recordedAt: 1 }]));
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const screen = renderHook(t, () => LogList({ log: quietLog() }));
  await settle();
  const reading = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'BodyweightReading');
  assert.deepEqual(reading.props.latest, { dateLocal: TODAY, weightKg: 82.4, recordedAt: 1 });

  const { BodyweightReading } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const drawn = BodyweightReading({ latest: { dateLocal: TODAY, weightKg: 82.4 } });
  assert.equal(drawn.props.href, '#/gym/bodyweight');
  assert.equal(textOf(drawn), '82.4 kg · today');
  assert.equal(BodyweightReading({ latest: null }), null, 'no dash, no zero, nothing');
});

test('the log actions open one weigh-in sheet beside Add past workout and read the saved weight back', async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  browserWith();
  const gym = await gymAccount(t);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const screen = renderHook(t, () => LogList({ log: quietLog() }));
  await settle();
  const header = findByClass(screen.tree, 'gym-history-actions')[0];
  const footer = findByClass(screen.tree, 'gym-log-footer')[0];
  for (const actions of [header, footer]) {
    assert.deepEqual(elementsOf(actions).filter((each) => each.type === 'button' || each.props.className === 'gym-door-past').map(textOf), ['Weigh in', 'Add past workout']);
  }
  assert.equal(findByClass(findByClass(screen.tree, 'gym-log-options')[0], 'gym-history-weigh').length, 0);
  const share = findByClass(header, 'gym-history-share')[0];
  assert.deepEqual([share.props.href, share.props['aria-label'], share.props.title, textOf(share)], ['#/gym/share-log', 'Share log', 'Share log', '']);
  assert.deepEqual([share.props.children.type.name, share.props.children.props], ['Icon', { name: 'share', size: 20 }]);
  assert.equal(sheetOf(screen.tree), undefined);
  findByClass(header, 'gym-history-weigh')[0].props.onClick();
  const sheet = sheetOf(screen.tree);
  assert.notEqual(sheet, undefined);
  assert.equal(sheet.props.fixedDate ?? null, null, 'a new weigh-in defaults to today and allows another date');
  assert.equal(sheet.props.onDelete ?? null, null, 'nothing to delete yet');

  const refused = await sheet.props.onSave({ dateLocal: TODAY, weightKg: 82.4, recordedAt: 7 });
  assert.equal(refused, null);
  // The whole day is written again, stamped by the log's own clock at the moment it took the number.
  assert.deepEqual(gym.owed(), [`ready put weighin ${TODAY} kg recordedAt`]);
  assert.equal(sheetOf(screen.tree), undefined, 'the sheet closes on a landed write');
  const reading = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'BodyweightReading');
  assert.deepEqual(reading.props.latest, { dateLocal: TODAY, weightKg: 82.4, recordedAt: now });
  findByClass(footer, 'gym-history-weigh')[0].props.onClick();
  assert.equal(elementsOf(screen.tree).filter((each) => typeof each.type === 'function' && each.type.name === 'WeighInSheet').length, 1);
  sheetOf(screen.tree).props.onClose();
  assert.equal(sheetOf(screen.tree), undefined);
  assert.equal(findByClass(screen.tree, 'gym-keypad').length, 0);
});

test('a refused save shows the log’s own sentence in the sheet and leaves it open', async (t) => {
  browserWith();
  const gym = await gymAccount(t);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const screen = renderHook(t, () => LogList({ log: quietLog() }));
  await settle();
  findByClass(screen.tree, 'gym-history-weigh')[0].props.onClick();
  // Another tab signed this account out under the open sheet: the log refuses the write, in its words.
  const commit = gym.engine.commit.bind(gym.engine);
  t.mock.method(gym.engine, 'commit', (scope, build) => commit(scope, (views) => build({ ...views, replica: 'anotherAccount' })));
  const refused = await sheetOf(screen.tree).props.onSave({ dateLocal: TODAY, weightKg: 82.4, recordedAt: 7 });
  assert.equal(refused, 'Sign in to save to your training log.');
  assert.notEqual(sheetOf(screen.tree), undefined);
  assert.deepEqual(gym.owed(), []);
});

test('the sheet: a plain decimal field with no hint, a date defaulting to today, refusals one at a time on Save', async (t) => {
  browserWith();
  const { WeighInSheet } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const saved = [];
  const screen = renderHook(t, () => WeighInSheet({ onSave: async (write) => { saved.push(write); return null; }, onClose: () => {} }));

  const input = findByClass(screen.tree, 'gym-weigh-input')[0];
  assert.equal(input.props.inputMode, 'decimal');
  assert.equal(input.props.type, 'text');
  assert.equal(findByClass(screen.tree, 'gym-weigh-hint').length, 0, 'both separators read; the field shows what was typed');
  assert.equal(findByClass(screen.tree, 'gym-weigh-date-input')[0].props.type, 'date');
  assert.equal(findByClass(screen.tree, 'gym-weigh-date-input')[0].props.value, TODAY);
  assert.equal(findByClass(screen.tree, 'gym-weigh-date-input')[0].props.max, TODAY, 'the picker’s range ends today');
  assert.equal(findByClass(screen.tree, 'gym-rungs').length, 0, 'no ladder');
  assert.equal(findByClass(screen.tree, 'gym-weigh-delete').length, 0, 'nothing to delete from a new weigh-in');

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
  findByClass(screen.tree, 'gym-weigh-date-input')[0].props.onChange({ target: { value: gymMoment(tomorrow.getTime()).today.text } });
  assert.equal(findByClass(screen.tree, 'gym-weigh-refusal').length, 0, 'changing the date clears the refusal');
  findByClass(screen.tree, 'gym-weigh-save')[0].props.onClick();
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-weigh-refusal')[0]), 'A weigh-in is not a forecast — today or earlier.');
  assert.deepEqual(saved, [], 'a forecast never reaches the log');

  findByClass(screen.tree, 'gym-weigh-date-input')[0].props.onChange({ target: { value: '2026-08-20' } });
  findByClass(screen.tree, 'gym-weigh-save')[0].props.onClick();
  await settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].dateLocal, '2026-08-20');
  assert.equal(saved[0].weightKg, 82.4);
  assert.equal(saved[0].recordedAt, undefined, 'the commit supplies its own timestamp');
});

test('a unit change converts an edited field without changing its kilogram amount on Save', async (t) => {
  browserWith();
  const { WeighInSheet } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const saved = [];
  let unit = 'kg';
  const screen = renderHook(t, () => WeighInSheet({ unit, fixedDate: '2026-08-20',
    onSave: async (write) => { saved.push(write); return null; }, onClose: () => {},
  }));
  const input = () => findByClass(screen.tree, 'gym-weigh-input')[0];
  input().props.onChange({ target: { value: '80' } });
  unit = 'lb';
  screen.redraw();
  assert.equal(input().props.value, '176.4');
  assert.equal(input().props['aria-label'], 'Bodyweight in lb');
  await findByClass(screen.tree, 'gym-weigh-save')[0].props.onClick();
  assert.deepEqual(saved, [{ dateLocal: '2026-08-20', weightKg: 80 }]);
});

test('the same sheet from a dot: the date fixed, the number prefilled, and a delete that is one press', async (t) => {
  browserWith();
  const { WeighInSheet } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const deleted = [];
  const screen = renderHook(t, () => WeighInSheet({
    entry: { dateLocal: '2026-08-20', weightKg: 82.45, recordedAt: 1 },
    fixedDate: '2026-08-20',
    onSave: async () => null,
    onDelete: (dateLocal) => { deleted.push(dateLocal); },
    onClose: () => {},
  }));
  assert.equal(findByClass(screen.tree, 'gym-weigh-input')[0].props.value, '82.45');
  assert.equal(findByClass(screen.tree, 'gym-weigh-date-input').length, 0, 'the date is fixed to that day');
  assert.equal(textOf(findByClass(screen.tree, 'gym-weigh-date-fixed')[0]), 'Thu 20 Aug');
  assert.equal(textOf(findByClass(screen.tree, 'gym-weigh-delete')[0]), 'Delete weigh-in');

  // No question in front of an act the window can take back, and Save never leaves to make room for one.
  findByClass(screen.tree, 'gym-weigh-delete')[0].props.onClick();
  await settle();
  assert.deepEqual(deleted, ['2026-08-20']);
  assert.equal(findByClass(screen.tree, 'gym-confirm').length, 0);
  assert.equal(findByClass(screen.tree, 'gym-weigh-save').length, 1);
});

test('the chart screen: a dot per weigh-in in the stated window, the rule printed, a dot opening the repair sheet', async (t) => {
  browserWith();
  const today = new Date();
  const daysAgo = (days) => { const day = new Date(today); day.setDate(day.getDate() - days); return gymMoment(day.getTime()).today.text; };
  const gym = await gymAccount(t, weighIns([
    { dateLocal: daysAgo(120), weightKg: 84, recordedAt: 1 },
    { dateLocal: daysAgo(30), weightKg: 83.1, recordedAt: 2 },
    { dateLocal: daysAgo(2), weightKg: 82.4, recordedAt: 3 },
  ]));
  const { BodyweightScreen } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const screen = renderHook(t, () => BodyweightScreen({ log: quietLog() }));
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-title')[0]), 'Bodyweight');

  const chart = chartOf(screen.tree);
  assert.equal(chart.props.points.length, 2, 'the 90-day window by default');
  assert.equal(chart.props.caption, 'last 90 days · 2 weigh-ins');
  assert.equal(chart.props.rule, undefined, 'a gap in the line reads as a gap; no legend explains it');
  assert.equal(chart.props.joins(chart.props.points[0], chart.props.points[1]), false, 'the domain names this gap');
  assert.equal(chart.props.domain.to, new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime());
  assert.equal(findByClass(screen.tree, 'gym-history-weigh').length, 0, 'no second door onto a new weigh-in');

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

  // The delete goes to the room's window, so the sheet — which would sit over the only Undo there
  // is — closes in the same act, and the screen writes nothing itself. This room's `withhold` is a
  // no-op, so what the window then does to the dot and the head reading is proved in
  // withheldWindow.test.js and nowhere here.
  sheet.props.onDelete(daysAgo(30));
  await settle();
  assert.deepEqual(gym.owed(), []);
  assert.equal(sheetOf(screen.tree), undefined);
});

test('a served row dated after the device’s local today is never the log’s latest reading and never a dot', async (t) => {
  browserWith();
  const forecast = { dateLocal: '2031-01-05', weightKg: 70, recordedAt: 9 };
  await gymAccount(t, weighIns([{ dateLocal: TODAY, weightKg: 82.4, recordedAt: 1 }, forecast]));
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const log = renderHook(t, () => LogList({ log: quietLog() }));
  await settle();
  const reading = elementsOf(log.tree).find((each) => typeof each.type === 'function' && each.type.name === 'BodyweightReading');
  assert.deepEqual(reading.props.latest, { dateLocal: TODAY, weightKg: 82.4, recordedAt: 1 }, 'the series’ own `latest` is not the reading; the newest past day is');

  const { BodyweightScreen } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const screen = renderHook(t, () => BodyweightScreen({ log: quietLog() }));
  await settle();
  assert.deepEqual(chartOf(screen.tree).props.points.map((point) => point.dateLocal), [TODAY]);
  assert.equal(chartOf(screen.tree).props.caption, 'last 90 days · 1 weigh-in');
  const tabs = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'Tabs');
  tabs.props.onChange('all');
  assert.deepEqual(chartOf(screen.tree).props.points.map((point) => point.dateLocal), [TODAY]);
});

test('the chart screen with nothing to draw says so in words and draws no frame', async (t) => {
  browserWith();
  await gymAccount(t);
  const { BodyweightScreen } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
  const screen = renderHook(t, () => BodyweightScreen({ log: quietLog() }));
  await settle();
  assert.equal(chartOf(screen.tree), undefined);
  const quiet = findByClass(screen.tree, 'gym-quiet').map(textOf);
  assert.deepEqual(quiet, ['No weigh-ins yet.', 'Weigh in from the log and the number lands here.']);
});

for (const renderAfterMidnight of ['changing the window', 'resuming the tab', 'the active tab reaches midnight']) {
  test(`an offline chart follows the real local day after midnight when ${renderAfterMidnight}`, async (t) => {
    const automatic = renderAfterMidnight === 'the active tab reaches midnight';
    t.mock.timers.enable({ apis: automatic ? ['Date', 'setTimeout'] : ['Date'], now: new Date(2027, 0, 15, 23, 59).getTime() });
    const browser = browserWith();
    navigator.onLine = false;
    const gym = await gymAccount(t, [
      confirmed('weighin', '2026-10-18', { kg: 80, recordedAt: 1 }),
      confirmed('weighin', '2027-01-15', { kg: 81, recordedAt: 2 }),
      confirmed('weighin', '2027-01-16', { kg: 82, recordedAt: 3 }),
    ]);
    const { BodyweightScreen } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
    const screen = renderHook(t, () => BodyweightScreen({ log: quietLog() }), { live: true });
    const snapshot = gym.engine.observe('self/gym').getSnapshot();
    const chart = () => {
      const { points, domain } = chartOf(screen.tree).props;
      return { to: domain.to, days: points.map((point) => point.dateLocal) };
    };
    assert.deepEqual(chart(), { to: new Date(2027, 0, 15).getTime(), days: ['2026-10-18', '2027-01-15'] });

    if (automatic) t.mock.timers.tick(120_000);
    else {
      browser.hide();
      t.mock.timers.setTime(new Date(2027, 0, 16, 0, 1).getTime());
      if (renderAfterMidnight === 'resuming the tab') browser.show();
      else {
        const tabs = () => elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'Tabs');
        tabs().props.onChange('all');
        tabs().props.onChange('90');
      }
    }

    assert.equal(gym.engine.observe('self/gym').getSnapshot(), snapshot, 'no sync update caused this render');
    assert.deepEqual(chart(), { to: new Date(2027, 0, 16).getTime(), days: ['2027-01-15', '2027-01-16'] });
  });
}

for (const outcome of ['commits', 'fails']) {
  test(`a stalled weigh-in delete hides both the dot and log reading until it ${outcome}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2027, 0, 15, 12).getTime() });
    browserWith();
    const entry = { dateLocal: '2027-01-15', weightKg: 80, recordedAt: 1 };
    const gym = await gymAccount(t, weighIns([entry]));
    const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
    const { BodyweightScreen, useBodyweight } = await loadScreen('products/gym/bodyweight/Bodyweight.jsx');
    const { LogList } = await loadScreen('products/gym/Log.jsx');
    const room = renderHook(t, () => {
      const log = useTrainingLog();
      return { log, screen: BodyweightScreen({ log }), logScreen: LogList({ log }), weights: useBodyweight(log) };
    }, { live: true });
    await settle();
    const drawn = () => ({
      days: chartOf(room.tree.screen)?.props.points.map((point) => point.dateLocal) ?? [],
      latest: elementsOf(room.tree.logScreen).find((each) => typeof each.type === 'function' && each.type.name === 'BodyweightReading').props.latest,
      stance: room.tree.weights.weights.stance,
      quiet: findByClass(room.tree.screen, 'gym-quiet').map(textOf),
    });
    const shown = { days: [entry.dateLocal], latest: entry, stance: 'holding', quiet: [] };
    const hidden = { days: [], latest: null, stance: 'holding', quiet: [] };
    assert.deepEqual(drawn(), shown);

    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const transact = gym.engine.store.transact.bind(gym.engine.store);
    const stalled = t.mock.method(gym.engine.store, 'transact', async (...args) => {
      entered();
      await gate;
      if (outcome === 'fails') throw new DOMException('storage refused', 'QuotaExceededError');
      return transact(...args);
    });
    chartOf(room.tree.screen).props.onPick(chartOf(room.tree.screen).props.points[0]);
    sheetOf(room.tree.screen).props.onDelete(entry.dateLocal);
    try {
      await started;
      assert.deepEqual(gym.owed(), [], 'the delete has not reached durable storage');
      assert.deepEqual([room.tree.log.transient.text, room.tree.log.transient.action.label], ['Weigh-in deleted.', 'Undo']);
      assert.equal(sheetOf(room.tree.screen), undefined);
      assert.deepEqual(drawn(), hidden);
    } finally {
      release();
      await settle();
      stalled.mock.restore();
    }

    if (outcome === 'commits') {
      assert.deepEqual(gym.owed(), [`held delete weighin ${entry.dateLocal}`]);
      assert.deepEqual(drawn(), hidden);
      await room.tree.log.transient.action.run();
      await settle();
      assert.equal(room.tree.log.transient, null);
    } else {
      assert.equal(room.tree.log.held.length, 0);
      assert.equal(room.tree.log.transient.text, 'That weigh-in wasn’t deleted — this device couldn’t store it.');
      assert.equal(room.tree.log.transient.action, null);
    }
    assert.deepEqual(gym.owed(), []);
    assert.deepEqual(drawn(), shown, 'Undo or a failed commit restores the dot and reading together');
  });
}
