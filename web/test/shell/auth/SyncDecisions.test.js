import test from 'node:test';
import assert from 'node:assert/strict';
import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

const question = { kind: 'signed-out', product: 'journal', count: { page: 3, journalState: 1 }, counted: ['one'] };
const work = { type: 'page', one: 'page', many: 'pages' };
test('occupied Journal asks with real page counts, equal Add/Discard and no dismissal', async (t) => {
  const { SyncDecisions } = await loadScreen('shell/auth/SyncDecisions.jsx');
  const decisions = [];
  const view = renderHook(t, () => SyncDecisions({ question, work, onDecision: (choice) => decisions.push(choice) }));
  assert.equal(view.tree.props.title, 'Add to your account?');
  assert.equal(view.tree.props.onClose, undefined);
  assert.equal(textOf(view.tree.props.children),
    '3 pages from before you signed in are only on this device, and your account already has pages. Add them, or discard them for good.');
  const buttons = elementsOf(view.tree.props.footer).filter((element) => element.props.variant);
  assert.deepEqual(buttons.map((button) => [textOf(button.props.children), button.props.variant]), [['Add', 'secondary'], ['Discard', 'secondary']]);
  buttons[1].props.onClick();
  assert.equal(view.tree.props.title, 'Discard 3 pages?');
  assert.deepEqual(decisions, []);
  const confirmation = elementsOf(view.tree.props.footer).filter((element) => element.props.variant);
  assert.deepEqual(confirmation.map((button) => [textOf(button.props.children), button.props.variant]), [['Cancel', 'secondary'], ['Discard', 'danger']]);
  confirmation[0].props.onClick();
  assert.equal(view.tree.props.title, 'Add to your account?');
});

test('sign-out states sent work may be confirmed and offers Keep/Discard/Cancel', async (t) => {
  const { SyncDecisions } = await loadScreen('shell/auth/SyncDecisions.jsx');
  const view = renderHook(t, () => SyncDecisions({ question: { unsent: 1, counted: ['one'] } }));
  assert.ok(textOf(view.tree.props.children).includes('1 change hasn’t been confirmed'));
  const buttons = elementsOf(view.tree.props.footer).filter((element) => element.props.variant);
  assert.deepEqual(buttons.map((button) => textOf(button.props.children)), ['Cancel', 'Keep', 'Discard']);
});
