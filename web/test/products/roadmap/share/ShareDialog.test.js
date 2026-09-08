import test from 'node:test';
import assert from 'node:assert/strict';
import { elementsOf, loadScreen, renderHook, textOf } from '../../gym/harness.mjs';

async function shareRoom(t, { visibility = 'private', mine = true, treeId = 't_example', request, copy } = {}) {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDocument = globalThis.document;
  globalThis.document = { addEventListener() {} };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.window = { location: { origin: 'https://windmill.works' }, setTimeout: () => 0, addEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: { writeText: async (url) => { calls.push(['copy', url]); await copy?.(); } },
  } });
  globalThis.fetch = async (url, options) => {
    calls.push(['patch', JSON.parse(options.body)]);
    return request ? request() : { ok: true };
  };
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  });
  const { ShareDialog } = await loadScreen('products/roadmap/share/ShareDialog.jsx');
  const props = { open: true, visibility, mine, treeId, onClose() {}, onStanceChange(next) {
    calls.push(['visibility', next]);
    props.visibility = next;
    room.redraw();
  } };
  const room = renderHook(t, () => ShareDialog(props));
  return { room, props, calls,
    button: () => elementsOf(room.tree).find((item) => item.type?.name === 'Button'),
    inputs: () => elementsOf(room.tree).filter((item) => item.type === 'input'),
    messages: (role) => elementsOf(room.tree).filter((item) => item.props.role === role).map(textOf),
  };
}

for (const visibility of ['private', 'unlisted']) {
  test(`${visibility} owner publishes before copying, with explicit disclosure and duplicate protection`, async (t) => {
    let resolve;
    const response = new Promise((done) => { resolve = done; });
    const view = await shareRoom(t, { visibility, request: () => response });
    assert.equal(view.button().props.children, 'Publish and copy link');
    assert.equal(elementsOf(view.room.tree).filter((item) => item.type === 'p').map(textOf)[0],
      'Publishing makes this roadmap public. Anyone can view and fork it, and it can appear in the public gallery.');
    const share = view.button().props.onClick;
    const pending = share();
    await share();
    assert.deepEqual(view.calls, [['patch', { visibility: 'public' }]]);
    assert.equal(view.button().props.disabled, true);
    assert.deepEqual(view.messages('status'), []);
    resolve({ ok: true });
    await pending;
    assert.deepEqual(view.calls, [['patch', { visibility: 'public' }], ['visibility', 'public'], ['copy', 'https://windmill.works/t/t_example']]);
    assert.deepEqual(view.messages('status'), ['Link copied.']);
    assert.equal(view.inputs()[0].props.value, 'https://windmill.works/t/t_example');
  });
}

test('server refusal never copies or claims success and publishing can be retried', async (t) => {
  let fail = true;
  const view = await shareRoom(t, { request: () => fail
    ? { ok: false, status: 403, json: async () => ({ error: 'Publishing denied' }) }
    : { ok: true } });
  await view.button().props.onClick();
  assert.deepEqual(view.calls, [['patch', { visibility: 'public' }]]);
  assert.deepEqual(view.messages('status'), []);
  assert.deepEqual(view.messages('alert'), ['Publishing denied. Try again.']);
  assert.deepEqual(view.inputs(), []);
  assert.equal(view.button().props.disabled, false);
  fail = false;
  await view.button().props.onClick();
  assert.deepEqual(view.messages('status'), ['Link copied.']);
  assert.deepEqual(view.messages('alert'), []);
});

test('network failure leaves publishing retryable', async (t) => {
  const view = await shareRoom(t, { request: () => { throw new Error('offline'); } });
  await view.button().props.onClick();
  assert.deepEqual(view.calls, [['patch', { visibility: 'public' }]]);
  assert.deepEqual(view.messages('alert'), ['Network request failed. Try again.']);
  assert.equal(view.button().props.disabled, false);
});

for (const mine of [true, false]) {
  test(`public ${mine ? 'owner' : 'visitor'} copies without mutation`, async (t) => {
    const view = await shareRoom(t, { visibility: 'public', mine });
    await view.button().props.onClick();
    assert.deepEqual(view.calls, [['copy', 'https://windmill.works/t/t_example']]);
    assert.deepEqual(view.messages('status'), ['Link copied.']);
  });
}

test('clipboard failure preserves the public URL and retries copying without republishing', async (t) => {
  let denied = true;
  const view = await shareRoom(t, { copy: () => { if (denied) throw new Error('denied'); } });
  await view.button().props.onClick();
  assert.deepEqual(view.messages('status'), []);
  assert.deepEqual(view.messages('alert'), ['Could not copy the link. Select the link to copy it manually, or try again.']);
  assert.equal(view.inputs()[0].props.value, 'https://windmill.works/t/t_example');
  denied = false;
  await view.button().props.onClick();
  assert.deepEqual(view.calls, [['patch', { visibility: 'public' }], ['visibility', 'public'],
    ['copy', 'https://windmill.works/t/t_example'], ['copy', 'https://windmill.works/t/t_example']]);
  assert.deepEqual(view.messages('status'), ['Link copied.']);
});

test('private visitors cannot publish or copy', async (t) => {
  const view = await shareRoom(t, { mine: false });
  assert.equal(view.button().props.disabled, true);
  await view.button().props.onClick();
  assert.deepEqual(view.calls, []);
  assert.deepEqual(view.inputs(), []);
});

test('making private waits for confirmation and reports a retryable refusal', async (t) => {
  let fail = true;
  const view = await shareRoom(t, { visibility: 'public', request: () => fail
    ? { ok: false, status: 500, json: async () => ({ error: 'Could not change visibility' }) }
    : { ok: true } });
  const makePrivate = () => elementsOf(view.room.tree).find((item) => item.type?.name === 'Button' && item.props.children === 'Make private');
  await makePrivate().props.onClick();
  assert.equal(view.props.visibility, 'public');
  assert.deepEqual(view.messages('alert'), ['Could not change visibility. Try again.']);
  fail = false;
  await makePrivate().props.onClick();
  assert.equal(view.props.visibility, 'private');
  assert.deepEqual(view.inputs(), []);
  assert.deepEqual(view.messages('status'), ['Roadmap is private. Only you can view it.']);
});

test('unclaimed owner gets a sign-in error without a link or copy', async (t) => {
  const view = await shareRoom(t, { visibility: null, request: () => ({ ok: false, status: 401 }) });
  await view.button().props.onClick();
  assert.deepEqual(view.calls, [['patch', { visibility: 'public' }]]);
  assert.deepEqual(view.inputs(), []);
  assert.deepEqual(view.messages('status'), []);
  assert.deepEqual(view.messages('alert'), ['Sign in to change visibility. Try again.']);
  assert.equal(view.button().props.disabled, false);
});

test('leaving the tree during publication never updates the next tree or copies the old URL', async (t) => {
  let resolve;
  const response = new Promise((done) => { resolve = done; });
  const view = await shareRoom(t, { request: () => response });
  const pending = view.button().props.onClick();
  view.room.unmount();
  resolve({ ok: true });
  await pending;
  assert.deepEqual(view.calls, [['patch', { visibility: 'public' }]]);
});
