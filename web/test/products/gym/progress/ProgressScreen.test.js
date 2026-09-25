import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWith, elementsOf, loadScreen, renderHook, textOf } from '../harness.mjs';

test('a no-estimate record distinguishes loaded facts from bodyweight additions', async (t) => {
  browserWith();
  const at = new Date(2026, 8, 25, 12).getTime();
  t.mock.method(Date, 'now', () => at);
  const { MovementChart } = await loadScreen('products/gym/progress/Progress.jsx');
  const log = { progress: { phase: 'ready', data: { sessions: [{ sessionId: 'a', startedAt: at, movements: [{ exerciseId: 'move', workingSetCount: 1, heaviest: { weightKg: 60, reps: 8 } }] }] } } };
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
  const sessions = [new Date(2024, 5, 10, 12).getTime(), new Date(2026, 2, 3, 12).getTime()].map((startedAt, index) => ({ sessionId: `ses_${index}`, startedAt, movements: [{ exerciseId: 'bench', workingSetCount: 1, heaviest: { weightKg: 60, reps: 8 }, estimate: { weightKg: 60, reps: 8, e1rm: 76 } }] }));
  const screen = renderHook(t, () => MovementChart({ id: 'bench', equipment: 'barbell', log: { progress: { phase: 'ready', data: { sessions } } } }));
  elementsOf(screen.tree).find((each) => each.type === 'button' && textOf(each) === 'All').props.onClick();
  const chart = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'DotChart');
  assert.deepEqual(elementsOf(screen.tree).filter((each) => each.type === 'td').map(textOf), ['10 Jun 2024', '60×8', '76.0', '3 Mar 2026', '60×8', '76.0']);
  assert.equal(chart.props.formatDate(sessions[0].startedAt), '10 Jun 2024');
  assert.equal(chart.props.gapLabel(chart.props.points[0], chart.props.points[1]), 'No session · 10 Jun 2024–3 Mar 2026');
  assert.equal(chart.props.points[0].label, '76 kg est · 10 Jun 2024 · 60 × 8');
});
