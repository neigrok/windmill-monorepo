import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { Button } = await import('../../../../src/design-system/core/Button.jsx');
const { RefusedSync, DeviceLine } = await import('../../../../src/products/roadmap/board/SyncNotices.jsx');

const alertIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-alert board-refused-sync-icon" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" x2="12" y1="8" y2="12"></line><line x1="12" x2="12.01" y1="16" y2="16"></line></svg>';
const buttonMarkup = (text, variant, size) => renderToStaticMarkup(React.createElement(Button, { variant, size }, text));

for (const band of ['phone', 'tablet', 'desktop']) {
  test(`RefusedSync — ${band} announces the complete notice and actions in the drawn order`, () => {
    const calls = [];
    const phone = band === 'phone';
    const size = phone ? 'sm' : 'md';
    const element = RefusedSync({ band, onRetry: () => calls.push('retry'), onDiscard: () => calls.push('discard') });
    const expected = `<div class="board-refused-sync${phone ? ' board-refused-sync--phone' : ''}" role="alert">${phone ? '' : alertIcon}<p class="board-refused-sync-message"><strong>Couldn’t sync this change.</strong></p><div class="board-refused-sync-actions">${buttonMarkup('Discard change', 'ghost', size)}${buttonMarkup('Retry', phone ? 'primary' : 'secondary', size)}</div></div>`;
    assert.equal(renderToStaticMarkup(element), expected);
    assert.deepEqual(calls, []);
    const buttons = React.Children.toArray(element.props.children[2].props.children);
    buttons[0].props.onClick();
    buttons[1].props.onClick();
    assert.deepEqual(calls, ['discard', 'retry']);
  });

  test(`RefusedSync — ${band} keeps Discard when Retry is null`, () => {
    const element = RefusedSync({ band, onRetry: null, onDiscard: () => {} });
    const buttons = React.Children.toArray(element.props.children[2].props.children);
    assert.deepEqual(buttons.map(({ props }) => ({ text: props.children, variant: props.variant })), [
      { text: 'Discard change', variant: 'ghost' },
    ]);
  });

  test(`RefusedSync — ${band} capacity uses Secondary Discard without Retry, including several changes`, () => {
    for (const count of [1, 3]) {
      const element = RefusedSync({ band, code: 'tree-too-large', count, onRetry: () => {}, onDiscard: () => {} });
      const message = element.props.children[1];
      assert.deepEqual(message.props.children.map(({ props }) => props.children), [
        'This roadmap is at its limit.', count === 1 ? 'This change can’t sync.' : 'Couldn’t sync 3 changes.',
      ]);
      const buttons = React.Children.toArray(element.props.children[2].props.children);
      assert.deepEqual(buttons.map(({ props }) => ({ text: props.children, variant: props.variant })), [
        { text: count === 1 ? 'Discard change' : 'Discard 3 changes', variant: 'secondary' },
      ]);
    }
  });

  test(`RefusedSync — ${band} several changes use the full lane count in both message and action`, () => {
    const element = RefusedSync({ band, code: 'server-error', count: 1200, onRetry: () => {}, onDiscard: () => {} });
    assert.equal(element.props.children[1].props.children[0].props.children, 'Couldn’t sync 1,200 changes.');
    const buttons = React.Children.toArray(element.props.children[2].props.children);
    assert.deepEqual(buttons.map(({ props }) => props.children), ['Discard 1,200 changes', 'Retry']);
  });
}

test('DeviceLine — one button is named by its complete text, its chevron is decorative, and tapping signs in', () => {
  const calls = [];
  const element = DeviceLine({ text: 'Saved on this device — sign in to keep it', onSignIn: () => calls.push('sign-in') });
  assert.equal(renderToStaticMarkup(element), '<button type="button" class="board-device-line"><span>Saved on this device — sign in to keep it</span><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg></button>');
  assert.deepEqual(calls, []);
  element.props.onClick();
  assert.deepEqual(calls, ['sign-in']);
});

test('DeviceLine — the lapsed line retains its text and the same sign-in action', () => {
  const calls = [];
  const element = DeviceLine({ text: 'Signed out — saved on this device', onSignIn: () => calls.push('sign-in') });
  assert.equal(element.props.children[0].props.children, 'Signed out — saved on this device');
  element.props.onClick();
  assert.deepEqual(calls, ['sign-in']);
});
