import test from 'node:test';
import assert from 'node:assert/strict';

import { elementsOf, loadScreen, renderHook } from '../products/gym/harness.mjs';

test('a button given an href is an anchor, and a disabled one is no longer a destination', async (t) => {
  const { Button } = await loadScreen('design-system/core/Button.jsx');
  const drawn = (props) => renderHook(t, () => Button(props)).tree;
  const link = drawn({ href: '#/gym/routines/new', children: 'Build a routine', full: true });
  assert.equal(link.type, 'a');
  assert.equal(link.props.href, '#/gym/routines/new');
  assert.equal(link.props.style.width, '100%');
  assert.equal(link.props.style.textDecoration, 'none');

  const dead = drawn({ href: '#/gym', disabled: true, children: 'Nowhere' });
  assert.equal(dead.props.href, undefined, 'a disabled anchor keeps no href');
  assert.equal(dead.props['aria-disabled'], 'true');
  assert.equal(dead.props.role, 'link');
  assert.equal(dead.props.onClick, undefined);

  const plain = drawn({ onClick: () => {}, children: 'Save' });
  assert.equal(plain.type, 'button');
  assert.equal(plain.props.type, 'button');
  assert.equal(plain.props.disabled, false);
  assert.equal(plain.props.style.width, undefined);
});

test('a transient carries its take-back and its dismissal, and the tone is one edge', async () => {
  const { Toast } = await loadScreen('design-system/feedback/Toast.jsx');
  const pressed = [];
  const tree = Toast({
    children: 'Set deleted.',
    tone: 'neutral',
    onClose: () => pressed.push('close'),
    action: { label: 'Undo', onClick: () => pressed.push('undo') },
  });
  const buttons = elementsOf(tree).filter((each) => each.type === 'button');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].props.children, 'Undo');
  assert.equal(buttons[0].props.style.color, 'var(--color-brand)', 'an undo is not a warning');
  assert.equal(buttons[1].props['aria-label'], 'Dismiss');
  buttons[0].props.onClick();
  buttons[1].props.onClick();
  assert.deepEqual(pressed, ['undo', 'close']);

  assert.equal(tree.props.style.borderLeft, '3px solid var(--border-strong)');
  assert.equal(tree.props.style.background, 'var(--surface-card)', 'a floating transient is never see-through');
  assert.equal(Toast({ children: 'x', tone: 'danger' }).props.style.borderLeft, '3px solid var(--color-danger)');

  const quiet = Toast({ children: 'Saved.' });
  assert.equal(elementsOf(quiet).filter((each) => each.type === 'button').length, 0, 'no action, no close, no buttons');
});
