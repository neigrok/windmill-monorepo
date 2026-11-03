import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { RefusedSync, DeviceLine } = await import('../../../../src/products/roadmap/board/SyncNotices.jsx');

test('RefusedSync — the contract stub renders nothing on every band without calling its actions', () => {
  const calls = [];
  const onRetry = () => calls.push('retry');
  const onDiscard = () => calls.push('discard');
  for (const band of ['phone', 'tablet', 'desktop']) {
    for (const retry of [onRetry, null]) {
      assert.equal(renderToStaticMarkup(React.createElement(RefusedSync, { band, onRetry: retry, onDiscard })), '');
    }
  }
  assert.deepEqual(calls, []);
});

test('DeviceLine — the contract stub renders nothing without calling sign in', () => {
  const calls = [];
  assert.equal(renderToStaticMarkup(React.createElement(DeviceLine, {
    text: 'Saved on this device — sign in to keep it',
    onSignIn: () => calls.push('sign-in'),
  })), '');
  assert.deepEqual(calls, []);
});
