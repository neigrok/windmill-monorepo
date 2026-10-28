import test from 'node:test';
import assert from 'node:assert/strict';
import { spellWeightsIn } from '../../../../src/products/gym/units.js';
import { browserWith, elementsOf, loadScreen, renderHook, textOf } from '../harness.mjs';

test('a no-estimate record distinguishes loaded facts from bodyweight additions', async (t) => {
  browserWith();
  const at = new Date(2026, 8, 25, 12).getTime();
  t.mock.method(Date, 'now', () => at);
  const { MovementChart } = await loadScreen('products/gym/progress/Progress.jsx');
  const log = { progress: { phase: 'ready', data: { sessions: [{ sessionId: 'a', startedAt: at, movements: [{ exerciseId: 'move', workingSetCount: 1, heaviest: { setId: 'set_heavy', weightKg: 60, reps: 8 } }] }] } } };
  for (const equipment of ['barbell', undefined]) {
    const screen = renderHook(t, () => MovementChart({ id: 'move', equipment, log }));
    assert.deepEqual(elementsOf(screen.tree).filter((element) => element.type === 'p').map(textOf), ['heaviest 60 × 8 · 25 Sep', '1 session · since 25 Sep', 'No estimate in this window.']);
  }
  const screen = renderHook(t, () => MovementChart({ id: 'move', equipment: 'bodyweight', log }));
  assert.deepEqual(elementsOf(screen.tree).filter((element) => element.type === 'p').map(textOf), ['heaviest added +60 · 25 Sep', '1 session · since 25 Sep']);
});

test('all-time chart table and gap labels keep years across a multiyear horizon', async (t) => {
  browserWith();
  t.mock.method(Date, 'now', () => new Date(2026, 8, 25, 12).getTime());
  const { MovementChart } = await loadScreen('products/gym/progress/Progress.jsx');
  const sessions = [new Date(2024, 5, 10, 12).getTime(), new Date(2026, 2, 3, 12).getTime()].map((startedAt, index) => ({ sessionId: `ses_${index}`, startedAt, movements: [{ exerciseId: 'bench', workingSetCount: 1, heaviest: { setId: 'set_heavy', weightKg: 60, reps: 8 }, estimate: { setId: 'set_estimate', weightKg: 60, reps: 8, e1rm: 76 } }] }));
  const screen = renderHook(t, () => MovementChart({ id: 'bench', equipment: 'barbell', log: { progress: { phase: 'ready', data: { sessions } } } }));
  elementsOf(screen.tree).find((each) => each.type === 'button' && textOf(each) === 'All').props.onClick();
  const chart = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'DotChart');
  assert.deepEqual(elementsOf(screen.tree).filter((each) => each.type === 'td').map(textOf), ['10 Jun 2024', '60×8', '76.0', '3 Mar 2026', '60×8', '76.0']);
  assert.equal(chart.props.formatDate(sessions[0].startedAt), '10 Jun 2024');
  assert.equal(chart.props.gapLabel(chart.props.points[0], chart.props.points[1]), 'No session · 10 Jun 2024–3 Mar 2026');
  assert.equal(chart.props.points[0].label, '76 kg est · 10 Jun 2024 · 60 × 8');
});


test('a partial training pull shows observed estimates without asserting a best', async (t) => {
  browserWith();
  const at = new Date(2026, 8, 25, 12).getTime();
  t.mock.method(Date, 'now', () => at);
  const { MovementChart } = await loadScreen('products/gym/progress/Progress.jsx');
  const log = { progress: { phase: 'ready', data: { isComplete: false, sessions: [{ sessionId: 'a', startedAt: at,
    movements: [{ exerciseId: 'bench', workingSetCount: 1, heaviest: { setId: 'set_a', weightKg: 60, reps: 8 },
      estimate: { setId: 'set_a', weightKg: 60, reps: 8, e1rm: 76 } }] }] } } };
  const screen = renderHook(t, () => MovementChart({ id: 'bench', equipment: 'barbell', log }));
  assert.deepEqual(elementsOf(screen.tree).filter((element) => element.type === 'p').map(textOf),
    ['1 session', 'Estimates, not tested lifts.', 'Latest · 76 kg est · 60 × 8']);
  assert.deepEqual(elementsOf(screen.tree).filter((element) => element.type === 'td').map(textOf), ['25 Sep', '60×8', '76.0']);
});


test('extreme estimates keep finite axis labels and unavailable pound cells', async (t) => {
  browserWith();
  const at = new Date(2026, 8, 25, 12).getTime();
  t.mock.method(Date, 'now', () => at);
  const { MovementChart } = await loadScreen('products/gym/progress/Progress.jsx');
  const log = { progress: { phase: 'ready', data: { sessions: [1e307, 1e308].map((e1rm, index) => ({ sessionId: `s${index}`,
    startedAt: at - index * 86400000, movements: [{ exerciseId: 'bench', workingSetCount: 1,
      heaviest: { setId: `set${index}`, weightKg: e1rm, reps: 1 }, estimate: { setId: `set${index}`, weightKg: e1rm, reps: 1, e1rm } }] })) } } };
  const kilograms = renderHook(t, () => MovementChart({ id: 'bench', equipment: 'barbell', log }));
  const chart = elementsOf(kilograms.tree).find((each) => typeof each.type === 'function' && each.type.name === 'DotChart');
  assert.equal(chart.props.formatValue(1e308), '1e+308');
  assert.equal(chart.props.formatValue(82.45), '82.5');
  spellWeightsIn('lb');
  try {
    const pounds = renderHook(t, () => MovementChart({ id: 'bench', equipment: 'barbell', log }));
    const cells = elementsOf(pounds.tree).filter((each) => each.type === 'td').map(textOf);
    assert.equal(cells[2], '—');
    assert.ok(cells.every((cell) => !/NaN|Infinity/.test(cell)));
  } finally { spellWeightsIn('kg'); }
});

test('unavailable estimates never claim that no eligible estimate exists', async (t) => {
  browserWith();
  const at = new Date(2026, 8, 25, 12).getTime();
  t.mock.method(Date, 'now', () => at);
  const { MovementChart } = await loadScreen('products/gym/progress/Progress.jsx');
  for (const unavailable of ['unit', 'arithmetic', 'partial']) {
    spellWeightsIn(unavailable === 'unit' ? 'lb' : 'kg');
    const fact = { setId: 'set', weightKg: Number.MAX_VALUE, reps: 1 };
    const log = { progress: { phase: 'ready', data: { isComplete: unavailable !== 'partial', sessions: [{
      sessionId: 'session', startedAt: at, movements: [{ exerciseId: 'bench', workingSetCount: 1,
        heaviest: fact, estimate: unavailable === 'unit' ? { ...fact, e1rm: Number.MAX_VALUE } : null,
        estimatesComplete: unavailable !== 'arithmetic' }],
    }] } } };
    try {
      const screen = renderHook(t, () => MovementChart({ id: 'bench', equipment: 'barbell', log }));
      const paragraphs = elementsOf(screen.tree).filter((each) => each.type === 'p').map(textOf);
      assert.ok(paragraphs.some((line) => line.includes('1 session')));
      assert.ok(!paragraphs.includes('No estimate in this window.'));
      assert.ok(paragraphs.every((line) => !/NaN|Infinity/.test(line)));
    } finally { spellWeightsIn('kg'); }
  }
});
