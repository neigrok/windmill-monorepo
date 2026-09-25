import test from 'node:test';
import assert from 'node:assert/strict';
import { gymApi, GymError } from '../../../src/products/gym/gymApi.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from './harness.mjs';

function proposal(over = {}) {
  return { id: 'p1', baseName: 'Push A', name: 'Push A', routineId: 'r1', intent: 'revise', state: 'pending', changeCount: 1,
    source: { door: 'ask', thread: 't1' }, createdAt: 1,
    changes: [
      { kind: 'retargeted', exerciseId: 'bench', before: { sets: [{ weightKg: 60, reps: 8 }] }, after: { sets: [{ weightKg: 62.5, reps: 8 }] } },
      { kind: 'kept', exerciseId: 'row', after: { sets: [{ weightKg: 40, reps: 8 }] } },
    ], ...over };
}

function button(tree, label) {
  return elementsOf(tree).find((element) => element.props?.children === label && (element.type === 'button' || element.type?.name === 'Button'));
}

test('the pending proposal presents its entire diff inline, folds unchanged rows, and applies into a persistent receipt', async (t) => {
  browserWith();
  const stored = proposal();
  t.mock.method(gymApi, 'proposal', async () => stored);
  const apply = t.mock.method(gymApi, 'applyProposal', async () => ({ proposal: { ...stored, state: 'applied' } }));
  const { ProposalPanel } = await loadScreen('products/gym/Proposals.jsx');
  const screen = renderHook(t, () => ProposalPanel({ id: 'p1', log: roomLog() }));
  await settle();
  assert.equal(elementsOf(screen.tree).some((element) => element.type?.name === 'Dialog'), false);
  assert.equal(textOf(findByClass(screen.tree, 'gym-proposal-kicker')[0]), 'Push A · 1 change');
  assert.deepEqual(findByClass(screen.tree, 'gym-diff-row').map((row) => row.props.className), ['gym-diff-row is-retargeted', 'gym-diff-row is-kept-run']);
  findByClass(screen.tree, 'gym-diff-unfold')[0].props.onClick();
  assert.deepEqual(findByClass(screen.tree, 'gym-diff-row').map((row) => row.props.className), ['gym-diff-row is-retargeted', 'gym-diff-row is-kept']);
  await button(screen.tree, 'Apply').props.onClick();
  assert.equal(apply.mock.callCount(), 1);
  assert.equal(textOf(findByClass(screen.tree, 'gym-coach-receipt')[0]), 'Applied · Push A · 1 change');
  assert.equal(button(screen.tree, 'Apply'), undefined);
  assert.equal(findByClass(screen.tree, 'gym-diff-row').length, 2);
});

test('turning down is an inline action with a settled receipt and no dialog', async (t) => {
  browserWith();
  t.mock.method(gymApi, 'proposal', async () => proposal());
  const dismiss = t.mock.method(gymApi, 'dismissProposal', async () => ({ proposal: proposal({ state: 'dismissed' }) }));
  const { ProposalPanel } = await loadScreen('products/gym/Proposals.jsx');
  const screen = renderHook(t, () => ProposalPanel({ id: 'p1', log: roomLog() }));
  await settle();
  await button(screen.tree, 'Turn this down').props.onClick();
  assert.equal(dismiss.mock.callCount(), 1);
  assert.equal(textOf(findByClass(screen.tree, 'gym-coach-receipt')[0]), 'Turned down · nothing changed.');
  assert.equal(button(screen.tree, 'Turn this down'), undefined);
});

test('a reopened message reads the server settled state and never offers a second apply', async (t) => {
  browserWith();
  t.mock.method(gymApi, 'proposal', async () => proposal({ state: 'applied' }));
  const { ProposalPanel } = await loadScreen('products/gym/Proposals.jsx');
  const screen = renderHook(t, () => ProposalPanel({ id: 'p1', log: roomLog() }));
  await settle();
  assert.equal(button(screen.tree, 'Apply'), undefined);
  assert.equal(textOf(findByClass(screen.tree, 'gym-coach-receipt')[0]), 'Applied · Push A · 1 change');
});

test('a refused apply retains the complete inline proposal and the exact server explanation', async (t) => {
  browserWith();
  t.mock.method(gymApi, 'proposal', async () => proposal());
  t.mock.method(gymApi, 'applyProposal', async () => { throw new GymError(503, 'Try again when connected.'); });
  const { ProposalPanel } = await loadScreen('products/gym/Proposals.jsx');
  const screen = renderHook(t, () => ProposalPanel({ id: 'p1', log: roomLog() }));
  await settle(); await button(screen.tree, 'Apply').props.onClick();
  assert.equal(textOf(findByClass(screen.tree, 'gym-proposal-refusal')[0]), 'Try again when connected.');
  assert.equal(findByClass(screen.tree, 'gym-diff-row').length, 2);
  assert.equal(button(screen.tree, 'Apply').props.disabled, false);
});

test('the in-flight decision disables both mutations, and live workout context remains explicit', async (t) => {
  browserWith();
  t.mock.method(gymApi, 'proposal', async () => proposal());
  let finish;
  t.mock.method(gymApi, 'applyProposal', () => new Promise((resolve) => { finish = resolve; }));
  const { ProposalPanel } = await loadScreen('products/gym/Proposals.jsx');
  const screen = renderHook(t, () => ProposalPanel({ id: 'p1', log: roomLog({ session: { id: 'live' } }) }));
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-proposal-caveat')[0]), 'You are mid-workout. Applying changes next time, not this session.');
  const result = button(screen.tree, 'Apply').props.onClick();
  assert.equal(button(screen.tree, 'Saving…').props.disabled, true);
  assert.equal(button(screen.tree, 'Turn this down').props.disabled, true);
  finish({ proposal: proposal({ state: 'applied' }) }); await result;
  assert.equal(findByClass(screen.tree, 'gym-proposal-caveat').length, 0);
});

test('a pending review belongs to its routine card and remains open after applying a removal refreshes the list', async (t) => {
  browserWith();
  const { RoutinesList } = await loadScreen('products/gym/Routines.jsx');
  let routines = [{ id: 'r1', name: 'Push A', entries: [], pendingProposal: proposal({ source: { door: 'mcp', name: 'Trainer' } }) }];
  t.mock.method(gymApi, 'routines', async () => routines);
  const screen = renderHook(t, () => RoutinesList({ log: roomLog() }));
  await settle();
  const cards = findByClass(screen.tree, 'gym-routine');
  assert.equal(cards.length, 1);
  const preview = elementsOf(cards[0]).find((element) => element.type?.name === 'ProposalPreview');
  assert.equal(preview.props.routine.id, 'r1');
  assert.equal(findByClass(screen.tree, 'gym-proposals').length, 0);
  preview.props.onExpand('p1');
  let panel = elementsOf(screen.tree).find((element) => element.type?.name === 'ProposalPanel');
  assert.equal(panel.props.id, 'p1');
  assert.equal(elementsOf(screen.tree).filter((element) => element.type?.name === 'ProposalPreview').length, 0);
  routines = [];
  panel.props.onChanged();
  await settle();
  panel = elementsOf(screen.tree).find((element) => element.type?.name === 'ProposalPanel');
  assert.equal(panel.props.id, 'p1');
  assert.equal(findByClass(screen.tree, 'gym-routine').length, 0);
});

test('a direct proposal can switch to another routine review and follows the next proposal route', async (t) => {
  browserWith();
  const { RoutinesList } = await loadScreen('products/gym/Routines.jsx');
  t.mock.method(gymApi, 'routines', async () => [
    { id: 'r1', name: 'Push A', entries: [], pendingProposal: proposal() },
    { id: 'r2', name: 'Pull A', entries: [], pendingProposal: proposal({ id: 'p2', routineId: 'r2' }) },
  ]);
  let reviewing = 'p1';
  const screen = renderHook(t, () => RoutinesList({ log: roomLog(), reviewing }));
  await settle();
  const panelId = () => elementsOf(screen.tree).find((element) => element.type?.name === 'ProposalPanel')?.props.id;
  assert.equal(panelId(), 'p1');
  elementsOf(screen.tree).find((element) => element.type?.name === 'ProposalPreview').props.onExpand('p2');
  assert.equal(panelId(), 'p2');
  reviewing = null;
  screen.redraw();
  await settle();
  assert.equal(panelId(), undefined);
  reviewing = 'p1';
  screen.redraw();
  await settle();
  assert.equal(panelId(), 'p1');
});
