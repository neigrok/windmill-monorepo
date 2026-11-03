import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { withBrowserErrors } from './composerFixture.js';

test('browser fixture rejects page errors and console errors while a page operation is still pending', async () => {
  for (const event of ['pageerror', 'console']) {
    const page = new EventEmitter();
    const pending = withBrowserErrors(page, () => new Promise(() => {}));
    const failure = new Error('module export is missing');
    page.emit(event, event === 'pageerror' ? failure : { type: () => 'error', text: () => failure.message });
    await assert.rejects(pending, { message: failure.message });
    await assert.rejects(withBrowserErrors(page, () => 'a later operation'), { message: failure.message });
    assert.equal(page.listenerCount('pageerror'), 1);
    assert.equal(page.listenerCount('console'), 1);
    page.emit('close');
    assert.equal(page.listenerCount('pageerror'), 0);
    assert.equal(page.listenerCount('console'), 0);
  }
});

test('browser fixture retains successful operation values and ignores informational console messages', async () => {
  const page = new EventEmitter();
  const result = withBrowserErrors(page, () => 42);
  page.emit('console', { type: () => 'log', text: () => 'ready' });
  assert.equal(await result, 42);
});
