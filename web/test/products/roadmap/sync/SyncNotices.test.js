import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { ANONYMOUS_OWNER, LAPSED_SESSION, REFUSED_SYNC, REFUSED_CAPACITY, refusedSyncBody, discardChanges } from '../../../../src/products/roadmap/copy.js';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { Button } = await import('../../../../src/design-system/core/Button.jsx');
const { RefusedSync, DeviceLine } = await import('../../../../src/products/roadmap/sync/SyncNotices.jsx');

const alertIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-alert board-refused-sync-icon" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" x2="12" y1="8" y2="12"></line><line x1="12" x2="12.01" y1="16" y2="16"></line></svg>';
const chevron = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>';
const buttonMarkup = (text, variant, size) => renderToStaticMarkup(React.createElement(Button, { variant, size }, text));

function buttonsIn(element) {
  return React.Children.toArray(element?.props?.children).flatMap((child) => child.type === Button ? [child] : buttonsIn(child));
}

function noticeMarkup(band, message, actions) {
  const phone = band === 'phone';
  return `<div class="board-refused-sync${phone ? ' board-refused-sync--phone' : ''}" role="alert">${phone ? '' : alertIcon}<p class="board-refused-sync-message">${message}</p><div class="board-refused-sync-actions">${actions}</div></div>`;
}

for (const band of ['phone', 'tablet', 'desktop']) {
  const phone = band === 'phone';
  const size = phone ? 'sm' : 'md';
  test(`RefusedSync — ${band} announces the complete notice and actions in the drawn order`, () => {
    const calls = [];
    const element = RefusedSync({ band, onRetry: () => calls.push('retry'), onDiscard: () => calls.push('discard') });
    assert.equal(renderToStaticMarkup(element), noticeMarkup(band, `<strong>${REFUSED_SYNC.body}</strong>`,
      buttonMarkup(REFUSED_SYNC.discard, 'ghost', size) + buttonMarkup(REFUSED_SYNC.retry, phone ? 'primary' : 'secondary', size)));
    assert.deepEqual(calls, []);
    for (const button of buttonsIn(element)) button.props.onClick();
    assert.deepEqual(calls, ['discard', 'retry']);
  });

  test(`RefusedSync — ${band} keeps Discard when Retry is null`, () => {
    const element = RefusedSync({ band, onRetry: null, onDiscard: () => {} });
    assert.equal(renderToStaticMarkup(element), noticeMarkup(band, `<strong>${REFUSED_SYNC.body}</strong>`,
      buttonMarkup(REFUSED_SYNC.discard, 'ghost', size)));
  });

  test(`RefusedSync — ${band} capacity uses Secondary Discard without Retry, including several changes`, () => {
    for (const count of [1, 3]) {
      const calls = [];
      const element = RefusedSync({ band, code: 'tree-too-large', count, onRetry: () => calls.push('retry'), onDiscard: () => calls.push('discard') });
      const detail = count === 1 ? REFUSED_CAPACITY.body : refusedSyncBody({ count });
      assert.equal(renderToStaticMarkup(element), noticeMarkup(band,
        `<strong>${REFUSED_CAPACITY.title}</strong><span class="board-refused-sync-detail"> ${detail}</span>`,
        buttonMarkup(discardChanges({ count }), 'secondary', size)));
      for (const button of buttonsIn(element)) button.props.onClick();
      assert.deepEqual(calls, ['discard']);
    }
  });

  test(`RefusedSync — ${band} several changes use the full lane count in both message and action`, () => {
    const count = 1200;
    const element = RefusedSync({ band, code: 'server-error', count, onRetry: () => {}, onDiscard: () => {} });
    assert.equal(renderToStaticMarkup(element), noticeMarkup(band, `<strong>${refusedSyncBody({ count })}</strong>`,
      buttonMarkup(discardChanges({ count }), 'ghost', size) + buttonMarkup(REFUSED_SYNC.retry, phone ? 'primary' : 'secondary', size)));
  });
}

for (const [line, text] of [['anonymous', ANONYMOUS_OWNER], ['lapsed', LAPSED_SESSION]]) {
  test(`DeviceLine — the ${line} button has its complete name, a decorative chevron, and a sign-in action`, () => {
    const calls = [];
    const element = DeviceLine({ text, onSignIn: () => calls.push('sign-in') });
    assert.equal(renderToStaticMarkup(element), `<button type="button" class="board-device-line"><span>${text}</span>${chevron}</button>`);
    assert.deepEqual(calls, []);
    element.props.onClick();
    assert.deepEqual(calls, ['sign-in']);
  });
}
