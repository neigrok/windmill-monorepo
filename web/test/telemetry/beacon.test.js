import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

// sentry.js reads its DSN from import.meta.env as it loads, so the real pair loads with one supplied.
async function reporterWithSentry() {
  const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  const envelopes = [];
  globalThis.fetch = async (url, request) => { envelopes.push(JSON.parse(request.body.split('\n')[2])); };
  globalThis.sentryEnvironment = { VITE_SENTRY_DSN: 'https://abc@errors.example/42', PROD: true };
  const sentry = (await source('../../src/telemetry/sentry.js')).replaceAll('import.meta.env', 'sentryEnvironment');
  const beacon = (await source('../../src/telemetry/beacon.js'))
    .replace("'./sentry.js'", JSON.stringify(`data:text/javascript,${encodeURIComponent(sentry)}`))
    .replace("'../shell/apiBase.js'", JSON.stringify(new URL('../../src/shell/apiBase.js', import.meta.url).href));
  const wired = await import(`data:text/javascript,${encodeURIComponent(beacon)}`);
  return { reportError: wired.reportError, envelopes };
}

function thrown(error) {
  try {
    throw error;
  } catch (caught) {
    return caught;
  }
}

function at(hash, pathname = '/') {
  window.location.hash = hash;
  window.location.pathname = pathname;
}

test('reportError — a thrown error on a roadmap leaves as labels, with no step title and no tree id', async () => {
  sent.length = 0;
  at('#/app/t_abc123', '/app/roadmap');

  reportError(thrown(new TypeError("Cannot save step 'Rig the boat'")), 'window');

  assert.equal(sent.length, 1);
  const body = JSON.parse(await sent[0].text());
  assert.deepEqual(body, {
    sessionKey: body.sessionKey,
    events: [{
      name: 'client_error',
      clientMs: body.events[0].clientMs,
      props: { kind: 'window', failure_kind: 'TypeError', route: '/app/roadmap' },
    }],
  });
  const wire = JSON.stringify(body);
  assert.equal(wire.includes('Rig the boat'), false);
  assert.equal(wire.includes('t_abc123'), false);
});

test('reportError — the failure the event leaves out still reaches Sentry, under the same family', async () => {
  const wired = await reporterWithSentry();
  sent.length = 0;
  at('#/app/t_abc123', '/app/roadmap');
  const error = new TypeError("Cannot save step 'Rig the boat'");
  error.stack = "TypeError: Cannot save step 'Rig the boat'\n    at save (https://windmill.works/assets/app.js:12:4)";

  wired.reportError(error, 'window');

  const event = wired.envelopes[0];
  assert.deepEqual(wired.envelopes, [{
    event_id: event.event_id, timestamp: event.timestamp,
    platform: 'javascript', level: 'error', logger: 'windmill-web', environment: 'production',
    tags: { kind: 'window' }, request: { url: '/app/roadmap' },
    exception: { values: [{ type: 'window', value: "Cannot save step 'Rig the boat'", stacktrace: { frames: [
      { filename: 'https://windmill.works/assets/app.js', lineno: 12, colno: 4, function: 'save', in_app: true },
    ] } }] },
  }]);
  assert.deepEqual(JSON.parse(await sent[0].text()).events[0].props, { kind: 'window', failure_kind: 'TypeError', route: '/app/roadmap' });
});

test('reportError — a capability in a message is struck out before it reaches Sentry', async () => {
  const wired = await reporterWithSentry();
  at('#/journal/2026-07-14', '/app/journal');
  const messages = {
    'verify failed for /v1/auth/verify?token=SECRETMAGICLINK': 'verify failed for /v1/auth/verify?token=*',
    'exchange failed: code=AUTHZ_CODE_SECRET&state=x': 'exchange failed: code=*&state=x',
    'crash at http://localhost:5152/#/t/t_sharedtreeid': 'crash at http://localhost:5152/#/t/*',
    'crash at https://windmill.works/t/t_sharedtreeid': 'crash at https://windmill.works/t/*',
    'crash at /gym/shared/cst_live_token': 'crash at /gym/shared/*',
    'crash at #/gym/shared-log/cst_live_token': 'crash at #/gym/shared-log/*',
  };

  for (const message of Object.keys(messages)) wired.reportError(new Error(message), 'promise');

  assert.deepEqual(wired.envelopes.map((event) => event.exception.values[0].value), Object.values(messages));
  assert.deepEqual([...new Set(wired.envelopes.map((event) => event.request.url))], ['/app/journal']);
});

test('reportError — a frame naming a capability address never reaches Sentry, and the frames around it do', async () => {
  const wired = await reporterWithSentry();
  at('#/gym/shared/cst_live_token');
  const error = new Error('share page failed');
  error.stack = 'Error: share page failed\n    at load (https://windmill.works/#/gym/shared/cst_live_token:2:2)\n    at render (https://windmill.works/assets/app.js:1:1)';

  wired.reportError(error, 'render');

  assert.deepEqual(wired.envelopes[0].request, { url: '/gym/shared' });
  assert.deepEqual(wired.envelopes[0].exception.values[0].stacktrace.frames, [
    { filename: 'https://windmill.works/assets/app.js', lineno: 1, colno: 1, function: 'render', in_app: true },
  ]);
  assert.equal(JSON.stringify(wired.envelopes).includes('cst_live_token'), false);
});

test('reportError — a kind or an error outside the closed sets reads other', async () => {
  sent.length = 0;
  at('#/gym/log', '/app/gym');
  class GymError extends Error {}

  reportError(new GymError('Bench press 100kg'), 'render');
  reportError('refused Rig the boat', 'promise');
  reportError(undefined, 'promise');
  reportError({ constructor: { name: 'Rig the boat' } }, 'window');
  reportError(new RangeError('out of range'), 'Rig the boat');
  reportError(new DOMException('aborted', 'AbortError'), 'shape');

  const props = await Promise.all(sent.map(async (blob) => JSON.parse(await blob.text()).events[0].props));
  assert.deepEqual(props, [
    { kind: 'render', failure_kind: 'other', route: '/app/gym' },
    { kind: 'promise', failure_kind: 'other', route: '/app/gym' },
    { kind: 'promise', failure_kind: 'other', route: '/app/gym' },
    { kind: 'window', failure_kind: 'other', route: '/app/gym' },
    { kind: 'other', failure_kind: 'RangeError', route: '/app/gym' },
    { kind: 'shape', failure_kind: 'DOMException', route: '/app/gym' },
  ]);
});

test('routeFamily — every address reads a closed family, with no id, token, date or query', () => {
  const addresses = [
    ['#/app', '/app/roadmap'],
    ['#/app/t_abc123', '/app/roadmap'],
    ['#/app/t_abc123?step=rig', '/app/roadmap'],
    ['#/app/new', '/'],
    ['#/t/t_sharedtreeid', '/'],
    ['#/demo', '/'],
    ['#/browse', '/'],
    ['#/gym', '/app/gym'],
    ['#/gym/session/ses_abc123', '/app/gym'],
    ['#/gym/movement/bench-press?from=log', '/app/gym'],
    ['#/gym/shared/cst_live_token', '/'],
    ['#/gym/shared-log/cst_live_token', '/'],
    ['#/journal/2026-07-14', '/app/journal'],
    ['#/settings', '/app/settings'],
    ['#/connect', '/app/connect'],
    ['#/auth?token=SECRETMAGICLINK', '/'],
    ['#/oauth/authorize?client_id=abc&code_challenge=xyz', '/'],
    ['#/showcase', '/'],
    ['#/', '/'],
    ['#/unnamed/t_abc123', '/app'],
    ['', '/'],
    ['#pricing', '/roadmap'],
    ['', '/app'],
    ['', '/app/roadmap'],
    ['', '/app/gym'],
    ['', '/app/journal'],
    ['', '/app/settings'],
    ['', '/app/connect'],
    ['', '/app/unnamed/t_abc123'],
    ['', '/t/t_sharedtreeid'],
    ['', '/roadmap'],
    ['', '/gym'],
    ['', '/journal/2026-07-14'],
    ['', '/unnamed/t_abc123'],
  ];

  const families = addresses.map(([hash, pathname]) => [`${pathname}${hash}`, routeFamily({ hash, pathname })]);

  assert.deepEqual(Object.fromEntries(families), {
    '/app/roadmap#/app': '/app/roadmap',
    '/app/roadmap#/app/t_abc123': '/app/roadmap',
    '/app/roadmap#/app/t_abc123?step=rig': '/app/roadmap',
    '/#/app/new': '/app/roadmap',
    '/#/t/t_sharedtreeid': '/t',
    '/#/demo': '/demo',
    '/#/browse': '/browse',
    '/app/gym#/gym': '/app/gym',
    '/app/gym#/gym/session/ses_abc123': '/app/gym',
    '/app/gym#/gym/movement/bench-press?from=log': '/app/gym',
    '/#/gym/shared/cst_live_token': '/gym/shared',
    '/#/gym/shared-log/cst_live_token': '/gym/shared',
    '/app/journal#/journal/2026-07-14': '/app/journal',
    '/app/settings#/settings': '/app/settings',
    '/app/connect#/connect': '/app/connect',
    '/#/auth?token=SECRETMAGICLINK': '/auth',
    '/#/oauth/authorize?client_id=abc&code_challenge=xyz': '/oauth/authorize',
    '/#/showcase': '/showcase',
    '/#/': '/',
    '/app#/unnamed/t_abc123': 'other',
    '/': '/',
    '/roadmap#pricing': '/roadmap',
    '/app': '/app',
    '/app/roadmap': '/app/roadmap',
    '/app/gym': '/app/gym',
    '/app/journal': '/app/journal',
    '/app/settings': '/app/settings',
    '/app/connect': '/app/connect',
    '/app/unnamed/t_abc123': '/app',
    '/t/t_sharedtreeid': '/t',
    '/roadmap': '/roadmap',
    '/gym': '/gym',
    '/journal/2026-07-14': '/journal',
    '/unnamed/t_abc123': 'other',
  });
});
