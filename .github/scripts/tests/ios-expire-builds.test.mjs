import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createToken, expireBuilds, requestApi, validateInputs } from '../ios-expire-builds.mjs';

const origin = 'https://api.appstoreconnect.apple.com';
const bundleId = 'works.windmill.app';
const app = { type: 'apps', id: '123456789', attributes: { bundleId, name: 'Windmill' } };
const release = {
  type: 'preReleaseVersions', id: '10000000-0000-4000-8000-000000000001',
  attributes: { version: '0.2.0', platform: 'IOS' },
};
const confirm = (limit = '5') => `EXPIRE ${bundleId} builds 1-${limit}`;

function build(number, expired = false) {
  return {
    type: 'builds', id: `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    attributes: { version: String(number), expired },
    relationships: {
      app: { data: { type: app.type, id: app.id } },
      preReleaseVersion: { data: { type: release.type, id: release.id } },
    },
  };
}

function mockApi() {
  const state = {
    apps: [structuredClone(app)],
    builds: [build(1), build(2, true), build(3), build(4), build(5), build(6), build(10)],
    included: structuredClone([app, release]),
    calls: [], logs: [], reads: 0,
    beforeResponse: () => {},
    beforePatch: () => {},
  };
  state.request = async (method, path, body) => {
    const url = new URL(path, origin);
    state.calls.push({ method, url: url.href, body: structuredClone(body) });
    if (method === 'PATCH') {
      await state.beforePatch(body);
      const target = state.builds.find((item) => item.id === body.data.id);
      assert.equal(url.pathname, `/v1/builds/${target.id}`);
      assert.deepEqual(body, { data: { type: 'builds', id: target.id, attributes: { expired: true } } });
      target.attributes.expired = true;
      return { data: structuredClone(target) };
    }
    assert.equal(method, 'GET');
    let response;
    if (url.pathname === '/v1/apps') {
      assert.equal(url.searchParams.get('filter[bundleId]'), bundleId);
      response = { data: structuredClone(state.apps), links: { next: null }, meta: { paging: { total: state.apps.length } } };
    } else {
      assert.equal(url.pathname, '/v1/builds');
      assert.equal(url.searchParams.get('filter[app]'), app.id);
      assert.equal(url.searchParams.has('filter[expired]'), false);
      assert.deepEqual(url.searchParams.get('include').split(',').sort(), ['app', 'preReleaseVersion']);
      state.reads += 1;
      const start = Number(url.searchParams.get('cursor') || 0);
      const end = start + 3;
      const next = new URL(url);
      next.searchParams.set('cursor', String(end));
      response = {
        data: structuredClone(state.builds.slice(start, end)), included: structuredClone(state.included),
        links: { next: end < state.builds.length ? next.href : null },
        meta: { paging: { total: state.builds.length } },
      };
    }
    await state.beforeResponse(response, url);
    return response;
  };
  state.run = (maxBuild = '5', confirmation = confirm(maxBuild)) => expireBuilds({
    maxBuild, confirmation, request: state.request, log: (line) => state.logs.push(line),
  });
  state.patches = () => state.calls.filter((call) => call.method === 'PATCH');
  return state;
}

test('all pages precede writes; only live builds 1–5 expire, and a rerun writes nothing', async () => {
  const api = mockApi();
  await api.run();
  assert.deepEqual(api.patches().map((call) => call.body.data.id), [1, 3, 4, 5].map((number) => build(number).id));
  assert.deepEqual(api.calls.map((call) => call.method), [
    'GET', 'GET', 'GET', 'GET', 'PATCH', 'PATCH', 'PATCH', 'PATCH', 'GET', 'GET', 'GET',
  ]);
  assert.deepEqual(api.builds.map((item) => item.attributes), [
    { version: '1', expired: true }, { version: '2', expired: true },
    { version: '3', expired: true }, { version: '4', expired: true },
    { version: '5', expired: true }, { version: '6', expired: false }, { version: '10', expired: false },
  ]);
  const table = api.logs.join('\n');
  assert.match(table, /0\.2\.0/);
  assert.match(table, new RegExp(build(10).id));
  assert.match(table, /Before/);
  assert.match(table, /After/);
  api.calls.length = 0;
  await api.run();
  assert.deepEqual(api.patches(), []);
});

test('a lower confirmed limit also protects builds 4 and 5', async () => {
  const api = mockApi();
  await api.run('3');
  assert.deepEqual(api.patches().map((call) => call.body.data.id), [build(1).id, build(3).id]);
  assert.deepEqual(api.builds.slice(3).map((item) => item.attributes.expired), [false, false, false, false]);
});

test('same build number in different marketing versions is still selected', async () => {
  const api = mockApi();
  const otherRelease = structuredClone(release);
  otherRelease.id = '10000000-0000-4000-8000-000000000002';
  otherRelease.attributes.version = '0.1.0';
  const otherBuild = build(1);
  otherBuild.id = '20000000-0000-4000-8000-000000000101';
  otherBuild.relationships.preReleaseVersion.data.id = otherRelease.id;
  api.included.push(otherRelease);
  api.builds.push(otherBuild);
  await api.run();
  assert.deepEqual(api.patches().map((call) => call.body.data.id).sort(), [1, 3, 4, 5, 101].map((number) => build(number).id).sort());
});

test('invalid input or confirmation fails before any API request', async () => {
  for (const limit of ['0', '6', '10', '-1', '5.1', '5x', '05', '5e0', ' 5', '5\n', '']) {
    const api = mockApi();
    await assert.rejects(api.run(limit, confirm()));
    assert.deepEqual(api.calls, []);
  }
  assert.throws(() => validateInputs(undefined, confirm()));
  for (const confirmation of ['', 'yes', 'EXPIRE', confirm('4'), `${confirm()}\n`]) {
    const api = mockApi();
    await assert.rejects(api.run('5', confirmation));
    assert.deepEqual(api.calls, []);
  }
  assert.equal(validateInputs('5', confirm()), 5);
});

const invalidInventories = [
  ['missing app', (api) => { api.apps = []; }],
  ['ambiguous app', (api) => { api.apps.push({ ...structuredClone(app), id: '987654321' }); }],
  ['wrong bundle', (api) => { api.apps[0].attributes.bundleId = 'works.windmill.other'; }],
  ['wrong app resource type', (api) => { api.apps[0].type = 'builds'; }],
  ['unsafe app ID', (api) => { api.apps[0].id = '../builds'; }],
  ['empty inventory', (api) => { api.builds = []; }],
  ['wrong included bundle', (api) => { api.included[0].attributes.bundleId = 'wrong.app'; }],
  ['wrong build app', (api) => { api.builds[5].relationships.app.data.id = '987654321'; }],
  ['missing build app', (api) => { delete api.builds[5].relationships.app.data; }],
  ['missing release', (api) => { api.included.pop(); }],
  ['wrong platform', (api) => { api.included[1].attributes.platform = 'MAC_OS'; }],
  ['empty marketing version', (api) => { api.included[1].attributes.version = ''; }],
  ['non-string marketing version', (api) => { api.included[1].attributes.version = 2; }],
  ['duplicate build ID', (api) => { api.builds[5].id = api.builds[0].id; }],
  ['duplicate version/build', (api) => { api.builds[5].attributes.version = '1'; }],
  ['non-boolean expiration', (api) => { api.builds[5].attributes.expired = 'false'; }],
  ['missing expiration', (api) => { delete api.builds[5].attributes.expired; }],
  ['already-expired protected build', (api) => { api.builds[5].attributes.expired = true; }],
  ...['6.0', '6x', '06', '6\n', '-6', '0', '9007199254740993', 6, null].map((version) => [
    `invalid protected number ${JSON.stringify(version)}`, (api) => { api.builds[5].attributes.version = version; },
  ]),
];

for (const [name, mutate] of invalidInventories) {
  test(`${name} prevents every PATCH, including valid earlier pages`, async () => {
    const api = mockApi();
    mutate(api);
    await assert.rejects(api.run());
    assert.deepEqual(api.patches(), []);
  });
}

const invalidPages = [
  ['missing page data', (response) => { delete response.data; }],
  ['missing page total', (response) => { delete response.meta; }],
  ['truncated pagination', (response) => { response.links.next = null; }],
  ['cross-origin next', (response) => { response.links.next = 'https://example.invalid/v1/builds'; }],
  ['wrong-path next', (response) => { response.links.next = `${origin}/v1/apps`; }],
  ['pagination cycle', (response, url) => { response.links.next = url.href; }],
  ['negative total', (response) => { response.meta.paging.total = -1; }],
  ['read timeout', () => { throw new DOMException('timed out', 'TimeoutError'); }],
  ['connection crash', () => { throw new Error('connection reset'); }],
];

for (const [name, mutate] of invalidPages) {
  test(`${name} prevents writes`, async () => {
    const api = mockApi();
    api.beforeResponse = (response, url) => {
      if (url.pathname === '/v1/builds') mutate(response, url);
    };
    await assert.rejects(api.run());
    assert.deepEqual(api.patches(), []);
  });
}

test('conflicting release metadata between pages prevents writes', async () => {
  const api = mockApi();
  api.beforeResponse = (response, url) => {
    if (url.searchParams.has('cursor')) response.included[1].attributes.version = '9.0.0';
  };
  await assert.rejects(api.run());
  assert.deepEqual(api.patches(), []);
});

test('PATCH failure stops without retry and reads back partial progress', async () => {
  const api = mockApi();
  api.beforePatch = () => {
    if (api.patches().length === 2) throw new DOMException('timed out', 'TimeoutError');
  };
  await assert.rejects(api.run());
  assert.deepEqual(api.patches().map((call) => call.body.data.id), [build(1).id, build(3).id]);
  assert.equal(api.calls.at(-1).method, 'GET');
  assert.deepEqual(api.builds.map((item) => item.attributes.expired), [true, true, false, false, false, false, false]);
  assert.match(api.logs.join('\n'), /After/);
});

test('an accepted PATCH with a lost response is read back without retrying', async () => {
  const api = mockApi();
  api.beforePatch = (body) => {
    api.builds.find((item) => item.id === body.data.id).attributes.expired = true;
    throw new Error('connection reset after server applied expiration');
  };
  await assert.rejects(api.run());
  assert.deepEqual(api.patches().map((call) => call.body.data.id), [build(1).id]);
  assert.deepEqual(api.builds.map((item) => item.attributes.expired), [true, true, false, false, false, false, false]);
  assert.equal(api.calls.at(-1).method, 'GET');
  assert.match(api.logs.join('\n'), /After/);
});

for (const [name, mutate] of [
  ['unapplied PATCH', (api) => { api.builds[0].attributes.expired = false; }],
  ['protected expiration', (api) => { api.builds[5].attributes.expired = true; }],
  ['protected version change', (api) => { api.builds[5].attributes.version = '7'; }],
  ['removed protected build', (api) => { api.builds.splice(5, 1); }],
  ['new build during operation', (api) => { api.builds.push(build(11)); }],
]) {
  test(`readback rejects ${name}`, async () => {
    const api = mockApi();
    api.beforePatch = () => {
      if (api.patches().length === 4) mutate(api);
    };
    await assert.rejects(api.run());
    assert.deepEqual(api.patches().map((call) => call.body.data.id), [1, 3, 4, 5].map((number) => build(number).id));
  });
}

test('readback failure is reported even when PATCHes succeeded', async () => {
  const api = mockApi();
  api.beforeResponse = () => {
    if (api.patches().length) throw new Error('readback unavailable');
  };
  await assert.rejects(api.run());
  assert.equal(api.patches().length, 4);
});

test('JWT uses an actual verifiable P-256 signature and bounded Apple claims', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const now = 1_791_331_200;
  const token = createToken({
    keyId: 'TESTKEY123', issuerId: '30000000-0000-4000-8000-000000000001',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), now,
  });
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'TESTKEY123', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss']);
  assert.equal(claims.iss, '30000000-0000-4000-8000-000000000001');
  assert.equal(claims.aud, 'appstoreconnect-v1');
  assert.equal(claims.iat, now);
  assert.ok(claims.exp > now && claims.exp <= now + 1200);
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), {
    key: publicKey, dsaEncoding: 'ieee-p1363',
  }, Buffer.from(signature, 'base64url')), true);
});

test('JWT refuses a signing key on the wrong curve', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  assert.throws(() => createToken({
    keyId: 'TESTKEY123', issuerId: 'issuer',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), now: 1_791_331_200,
  }));
});

test('transport sends Apple authorization, refuses redirects, and sets a deadline', async () => {
  const body = { data: { type: 'builds', id: build(1).id, attributes: { expired: true } } };
  const response = await requestApi('PATCH', `/v1/builds/${build(1).id}`, body, 'local-test-token', async (url, options) => {
    assert.equal(String(url), `${origin}/v1/builds/${build(1).id}`);
    assert.equal(options.method, 'PATCH');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer local-test-token');
    assert.equal(new Headers(options.headers).get('content-type'), 'application/json');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), body);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  assert.deepEqual(response, body);
});

test('transport never follows unsafe URLs or sends credentials to them', async () => {
  for (const url of ['https://example.invalid/v1/apps', 'http://api.appstoreconnect.apple.com/v1/apps', `${origin}/v1/users`]) {
    let calls = 0;
    await assert.rejects(requestApi('GET', url, undefined, 'local-test-token', async () => { calls += 1; }));
    assert.equal(calls, 0);
  }
});

test('transport reports HTTP, timeout, connection and invalid JSON failures without retries or raw bodies', async () => {
  for (const result of [
    () => new Response('sensitive-response', { status: 401 }),
    () => new Response('sensitive-response', { status: 429 }),
    () => new Response('sensitive-response', { status: 500 }),
    () => new Response('sensitive-response', { status: 302 }),
    () => new Response('sensitive-response', { status: 200 }),
    () => { throw new DOMException('sensitive-response', 'TimeoutError'); },
    () => { throw new Error('sensitive-response'); },
  ]) {
    let calls = 0;
    await assert.rejects(requestApi('GET', '/v1/apps', undefined, 'local-test-token', async () => {
      calls += 1;
      return result();
    }), (error) => !String(error).includes('sensitive-response') && !String(error).includes('local-test-token'));
    assert.equal(calls, 1);
  }
});

test('the real request deadline aborts a stalled response body', { timeout: 35_000 }, async () => {
  const keepAlive = setTimeout(() => {}, 35_000);
  let calls = 0;
  let aborted = false;
  try {
    await assert.rejects(requestApi('GET', '/v1/apps', undefined, 'local-test-token', async (url, options) => {
      calls += 1;
      return {
        ok: true,
        json: () => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true;
            reject(options.signal.reason);
          }, { once: true });
        }),
      };
    }));
    assert.equal(aborted, true);
    assert.equal(calls, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('CLI refuses unsafe input with a nonzero exit before requiring credentials', () => {
  const script = fileURLToPath(new URL('../ios-expire-builds.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH, MAX_BUILD: '6', CONFIRM: confirm('6') }, encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /max_build|1.*5/i);
  assert.doesNotMatch(result.stderr, /ENOENT|ASC_KEY_ID/);
});
