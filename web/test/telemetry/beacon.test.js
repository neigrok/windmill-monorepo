import test from 'node:test';
import assert from 'node:assert/strict';

// beacon.js reads window at import time, so the page has to exist before the module does.
const sent = [];
globalThis.window = {
  location: { hash: '', pathname: '/', hostname: 'windmill.works' },
  addEventListener: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
};
globalThis.document = { addEventListener: () => {}, visibilityState: 'visible' };
globalThis.navigator = { sendBeacon: (url, blob) => { sent.push(blob); return true; } };

const { reportError, routeFamily } = await import('../../src/telemetry/beacon.js');

async function bodyOf(blob) {
  return JSON.parse(await blob.text());
}

test('routeFamily — the magic-link token never leaves the page', () => {
  assert.equal(routeFamily('#/auth?token=SUPERSECRETMAGICLINKTOKEN'), '#/auth');
});

test('routeFamily — a shared-workout token is a capability, so the segment becomes a star', () => {
  assert.equal(routeFamily('#/gym/shared/cst_live_30day_token'), '#/gym/shared/*');
  assert.equal(routeFamily('#/t/t_unlisted_tree_id'), '#/t/*');
});

test('routeFamily — the OAuth consent params go, the screen stays', () => {
  assert.equal(routeFamily('#/oauth/authorize?client_id=abc&code_challenge=xyz'), '#/oauth/authorize');
});

test('routeFamily — the routes that carry no capability are untouched', () => {
  assert.equal(routeFamily('#/app/t_abc123'), '#/app/t_abc123');
  assert.equal(routeFamily('#/journal'), '#/journal');
  assert.equal(routeFamily('#/gym/log'), '#/gym/log');
  assert.equal(routeFamily(''), '');
});

test('reportError — the beaconed payload carries the family, and no secret in message or stack', async () => {
  sent.length = 0;
  window.location.hash = '#/auth?token=SUPERSECRETMAGICLINKTOKEN';
  const error = new Error('verify failed for /v1/auth/verify?token=SUPERSECRETMAGICLINKTOKEN');
  error.stack = 'Error: boom\n    at verify (https://windmill.works/assets/app.js:1:1)\n    at /gym/shared/cst_live_token';

  reportError(error, 'window');

  assert.equal(sent.length, 1);
  const body = await bodyOf(sent[0]);
  assert.equal(body.events.length, 1);
  const props = body.events[0].props;
  assert.equal(props.route, '#/auth');
  assert.equal(props.message, 'verify failed for /v1/auth/verify?token=*');
  assert.equal(props.stack.includes('cst_live_token'), false);
  assert.equal(JSON.stringify(body).includes('SUPERSECRETMAGICLINKTOKEN'), false);
});

test('reportError — a capability in the MESSAGE is struck out too, not only in the route', async () => {
  sent.length = 0;
  window.location.hash = '#/app/t_abc123';

  reportError(new Error('crash at http://localhost:5152/#/t/t_reviewwebsharedtreeid'), 'window');

  const body = await bodyOf(sent[0]);
  assert.equal(body.events[0].props.message, 'crash at http://localhost:5152/#/t/*');
  assert.equal(body.events[0].props.route, '#/app/t_abc123');
  assert.equal(JSON.stringify(body).includes('t_reviewwebsharedtreeid'), false);
});

test('reportError — an OAuth code in the message is struck out as well', async () => {
  sent.length = 0;
  window.location.hash = '#/oauth/authorize?client_id=abc';

  reportError(new Error('exchange failed: code=AUTHZ_CODE_SECRET&state=x'), 'promise');

  const body = await bodyOf(sent[0]);
  assert.equal(body.events[0].props.message, 'exchange failed: code=*&state=x');
  assert.equal(body.events[0].props.route, '#/oauth/authorize');
});

test('reportError — a crash on a shared-workout page names the family, not the token', async () => {
  sent.length = 0;
  window.location.hash = '#/gym/shared/cst_live_30day_token';

  reportError(new Error('render failed'), 'render');

  const body = await bodyOf(sent[0]);
  assert.equal(body.events[0].props.route, '#/gym/shared/*');
  assert.equal(JSON.stringify(body).includes('cst_live_30day_token'), false);
});
