import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWith, confirmed, elementsOf, findByClass, gymAccount, loadScreen, renderHook, roomLog, settle, textOf } from './harness.mjs';

const routine = (id, name) => confirmed('routine', id, { name, position: 0, entries: [
  { exerciseId: 'bench-press', sets: [{ weightKg: 60, reps: 8 }] }, { exerciseId: 'barbell-row', sets: [{ weightKg: 40, reps: 8 }] },
] });

// Coach's pending proposal for Push A: the bench retargeted, the row kept.
function proposal(fields = {}, id = 'proposal0001') {
  return confirmed('proposal', id, { routineId: 'routinePushA', intent: 'revise', proposedName: 'Push A', baseName: 'Push A',
    summary: '', door: 'ask', threadId: 'thread000001', changeCount: 1, state: 'pending',
    changes: [
      { kind: 'retargeted', exerciseId: 'bench-press', before: { sets: [{ weightKg: 60, reps: 8 }] }, after: { sets: [{ weightKg: 62.5, reps: 8 }] } },
      { kind: 'kept', exerciseId: 'barbell-row', after: { sets: [{ weightKg: 40, reps: 8 }] } },
    ], ...fields }, { rc: 1 });
}

function button(tree, label) {
  return elementsOf(tree).find((element) => element.props?.children === label && (element.type === 'button' || element.type?.name === 'Button'));
}

async function panel(t, rows, log = roomLog()) {
  browserWith();
  const gym = await gymAccount(t, rows);
  const { ProposalPanel } = await loadScreen('products/gym/Proposals.jsx');
  const screen = renderHook(t, () => ProposalPanel({ id: 'proposal0001', log }));
  await settle();
  return { gym, screen };
}

test('the pending proposal presents its entire diff inline, folds unchanged rows, and applies into a persistent receipt', async (t) => {
  const { gym, screen } = await panel(t, [routine('routinePushA', 'Push A'), proposal()]);
  assert.equal(elementsOf(screen.tree).some((element) => element.type?.name === 'Dialog'), false);
  assert.equal(textOf(findByClass(screen.tree, 'gym-proposal-kicker')[0]), 'Push A · 1 change');
  assert.deepEqual(findByClass(screen.tree, 'gym-diff-row').map((row) => row.props.className), ['gym-diff-row is-retargeted', 'gym-diff-row is-kept-run']);
  findByClass(screen.tree, 'gym-diff-unfold')[0].props.onClick();
  assert.deepEqual(findByClass(screen.tree, 'gym-diff-row').map((row) => row.props.className), ['gym-diff-row is-retargeted', 'gym-diff-row is-kept']);
  await button(screen.tree, 'Apply').props.onClick();
  await settle();
  assert.deepEqual(gym.owed(), ['ready gym.applyProposal proposal0001']);
  assert.equal(textOf(findByClass(screen.tree, 'gym-coach-receipt')[0]), 'Applied · Push A · 1 change');
  assert.equal(button(screen.tree, 'Apply'), undefined);
  assert.equal(findByClass(screen.tree, 'gym-diff-row').length, 2);
});

test('turning down is an inline action with a settled receipt and no dialog', async (t) => {
  const { gym, screen } = await panel(t, [routine('routinePushA', 'Push A'), proposal()]);
  await button(screen.tree, 'Turn this down').props.onClick();
  await settle();
  assert.deepEqual(gym.owed(), ['ready gym.dismissProposal proposal0001']);
  assert.equal(textOf(findByClass(screen.tree, 'gym-coach-receipt')[0]), 'Turned down · nothing changed.');
  assert.equal(button(screen.tree, 'Turn this down'), undefined);
});

test('a reopened message reads the server settled state and never offers a second apply', async (t) => {
  const { screen } = await panel(t, [routine('routinePushA', 'Push A'), proposal({ state: 'applied', settledAt: 2 })]);
  assert.equal(button(screen.tree, 'Apply'), undefined);
  assert.equal(textOf(findByClass(screen.tree, 'gym-coach-receipt')[0]), 'Applied · Push A · 1 change');
});

test('a refused apply retains the complete inline proposal and says why in place', async (t) => {
  const { gym, screen } = await panel(t, [routine('routinePushA', 'Push A'), proposal()]);
  gym.refuseWrites();
  await button(screen.tree, 'Apply').props.onClick();
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-proposal-refusal')[0]), 'That wasn’t applied — the log didn’t answer. Try again when you have signal.');
  assert.equal(findByClass(screen.tree, 'gym-diff-row').length, 2);
  assert.equal(button(screen.tree, 'Apply').props.disabled, false);
  assert.deepEqual(gym.owed(), []);
});

test('an apply over a proposal settled elsewhere is refused in the store’s own words, and the panel reads the store again', async (t) => {
  const { gym, screen } = await panel(t, [routine('routinePushA', 'Push A'), proposal()]);
  // Turned down on the phone while this panel stood open on the pending read.
  await gym.land({ ...proposal({ state: 'dismissed', settledAt: 2 }), seq: 3 });
  assert.notEqual(button(screen.tree, 'Apply'), undefined);
  await button(screen.tree, 'Apply').props.onClick();
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-proposal-refusal')[0]), 'That proposal has already been settled.');
  assert.equal(textOf(findByClass(screen.tree, 'gym-coach-receipt')[0]), 'Turned down · nothing changed.');
  assert.equal(button(screen.tree, 'Apply'), undefined);
  assert.deepEqual(gym.owed(), []);
});

test('the in-flight decision disables both mutations, and live workout context remains explicit', async (t) => {
  const { gym, screen } = await panel(t, [routine('routinePushA', 'Push A'), proposal()], roomLog({ session: { id: 'live' } }));
  assert.equal(textOf(findByClass(screen.tree, 'gym-proposal-caveat')[0]), 'You are mid-workout. Applying changes next time, not this session.');
  const result = button(screen.tree, 'Apply').props.onClick();
  assert.equal(button(screen.tree, 'Saving…').props.disabled, true);
  assert.equal(button(screen.tree, 'Turn this down').props.disabled, true);
  await result;
  await settle();
  assert.deepEqual(gym.owed(), ['ready gym.applyProposal proposal0001']);
  assert.equal(findByClass(screen.tree, 'gym-proposal-caveat').length, 0);
});

test('a pending review belongs to its routine card and remains open after applying a removal refreshes the list', async (t) => {
  browserWith();
  const gym = await gymAccount(t, [routine('routinePushA', 'Push A'),
    confirmed('proposal', 'proposal0001', { routineId: 'routinePushA', intent: 'remove', proposedName: 'Push A', summary: '',
      door: 'mcp', agent: 'Trainer', changes: [], state: 'pending' }, { rc: 1 })]);
  const { RoutinesList } = await loadScreen('products/gym/Routines.jsx');
  const screen = renderHook(t, () => RoutinesList({ log: roomLog() }));
  await settle();
  const cards = findByClass(screen.tree, 'gym-routine');
  assert.equal(cards.length, 1);
  const preview = elementsOf(cards[0]).find((element) => element.type?.name === 'ProposalPreview');
  assert.equal(preview.props.routine.id, 'routinePushA');
  assert.equal(findByClass(screen.tree, 'gym-proposals').length, 0);
  preview.props.onExpand('proposal0001');
  let panel = elementsOf(screen.tree).find((element) => element.type?.name === 'ProposalPanel');
  assert.equal(panel.props.id, 'proposal0001');
  assert.equal(elementsOf(screen.tree).filter((element) => element.type?.name === 'ProposalPreview').length, 0);

  // The panel the card handed its props to, applied the way the lifter applies it.
  const review = renderHook(t, () => panel.type(panel.props));
  await settle();
  await button(review.tree, 'Apply').props.onClick();
  await settle();
  assert.deepEqual(gym.owed(), ['ready gym.applyProposal proposal0001']);
  panel = elementsOf(screen.tree).find((element) => element.type?.name === 'ProposalPanel');
  assert.equal(panel.props.id, 'proposal0001');
  assert.equal(findByClass(screen.tree, 'gym-routine').length, 0);
});

test('a direct proposal can switch to another routine review and follows the next proposal route', async (t) => {
  browserWith();
  await gymAccount(t, [routine('routinePushA', 'Push A'), routine('routinePullA', 'Pull A'),
    proposal(), proposal({ routineId: 'routinePullA', proposedName: 'Pull A', baseName: 'Pull A' }, 'proposal0002')]);
  const { RoutinesList } = await loadScreen('products/gym/Routines.jsx');
  let reviewing = 'proposal0001';
  const screen = renderHook(t, () => RoutinesList({ log: roomLog(), reviewing }));
  await settle();
  const panelId = () => elementsOf(screen.tree).find((element) => element.type?.name === 'ProposalPanel')?.props.id;
  assert.equal(panelId(), 'proposal0001');
  elementsOf(screen.tree).find((element) => element.type?.name === 'ProposalPreview').props.onExpand('proposal0002');
  assert.equal(panelId(), 'proposal0002');
  reviewing = null;
  screen.redraw();
  await settle();
  assert.equal(panelId(), undefined);
  reviewing = 'proposal0001';
  screen.redraw();
  await settle();
  assert.equal(panelId(), 'proposal0001');
});
