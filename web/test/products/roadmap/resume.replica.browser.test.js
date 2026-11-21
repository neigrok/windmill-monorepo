// The home card and the landing on the device's copy against the two with the switch off, in Chromium: with the room's
// replica switch on they read the person's roadmaps from the real browser engine, synced with the JavaScript reference
// server under roadmap's binding, while every `/v1/trees` route answers 410 as it does in production (§7); with it off
// they read the server's list. Both must offer the same roadmap in the same words.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { Registry } from '../../../../packages/api-contract/sync/reference/core/registry.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { RoadmapProduct } from '../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { beacon } from './browserFixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const registryJson = readFileSync(new URL('../../../../packages/api-contract/sync/roadmap.registry.json', import.meta.url), 'utf8');
const registry = new Registry(JSON.parse(registryJson));
const SAIL = 't_5a11000000000001';
const ROW = 't_5a11000000000002';

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Registry } from '${root}../packages/api-contract/sync/reference/core/registry.js';
import { HttpTransport } from '/src/platform/sync/transport.js';
import { syncSession } from '/src/platform/sync/session.js';
import { HomeCard } from '/src/products/roadmap/HomeCard.jsx';
import { RoadmapLanding } from '/src/products/roadmap/marketing/RoadmapLanding.jsx';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const params = new URLSearchParams(location.search);
const account = params.get('account');
const boot = crypto.randomUUID();
const transport = new HttpTransport({ schema: 13, base: '', reading: () => ({ wall: Date.now(), mono: Math.floor(performance.now()), boot }),
  socket: () => ({ readyState: 0, send() {}, close() { this.readyState = 3; } }),
  fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, 'x-fixture-account': account ?? '' } }) });
// The device's copy opened, with the person's roadmaps on it as the room makes them: the account's sent and taken by the
// server, the browser's own signed out kept unsent.
async function openCopy() {
  const engine = await syncSession.open({ registry: new Registry(${registryJson}), transport, appVersion: '1',
    credentials: { clear: async () => {} }, telemetry: { event() {}, failure() {} } });
  if (account && engine.device.activeReplica.meta.state !== 'bound') await engine.signIn(account);
  syncSession.publish({ signedIn: Boolean(account) });
  for (const [tree, title, steps, done] of JSON.parse(params.get('plant') ?? '[]')) {
    await engine.commit('self/roadmap', [{ op: 'create', t: 'tree', id: tree }]);
    await engine.commit('tree/' + tree, [{ op: 'write', t: 'meta', id: 'meta', f: { title } },
      ...steps.map((label, index) => ({ op: 'create', t: 'node', id: 's' + index, f: { label, ord: 'a' + index } }))], { atomic: true });
    if (done) await engine.commit('self/overlay/' + tree, [{ op: 'write', t: 'progress', id: 's0', f: { mark: { status: 'complete', outOfOrder: false } } }]);
    for (let turn = 0; account && (engine.device.activeReplica.outbox.some((each) => each.state !== 'acked') || !engine.device.activeReplica.confirmedRows('tree/' + tree).length); turn++) {
      if (turn === 200) throw new Error('the roadmap never settled');
      await new Promise((settle) => setTimeout(settle, 50));
    }
    await new Promise((settle) => setTimeout(settle, 20));
  }
}
const draw = () => createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
  React.createElement(HomeCard), React.createElement(RoadmapLanding)));
// A page that draws the two surfaces before its copy opens, \`late\` ms after, finishes loading first, so the surfaces'
// own reading of the copy loads while it waits.
const late = Number(params.get('late') ?? 0);
if (late) {
  draw();
  setTimeout(openCopy, late);
} else {
  await openCopy();
  draw();
}
`;

const auth = `
const account = new URLSearchParams(location.search).get('account');
export const useAuth = () => ({ status: account ? 'signed-in' : 'ghost', user: account ? { name: 'Ada', email: 'ada@example.com' } : null,
  account: account ? { id: account } : null, confirmed: true, lapsed: false, refresh: async () => null, signOut: async () => {} });
`;

const plugin = { name: 'roadmap-resume-host', enforce: 'pre',
  resolveId(id, importer) {
    if (id === '/resume-host-entry.js') return '\0resume-entry';
    const file = id.startsWith('.') && importer && !importer.startsWith('\0') ? resolve(dirname(importer), id) : id;
    if (file.endsWith('/roadmap/replicaRoom.js')) return '\0resume-switch';
    if (file.endsWith('/marketing/treeScenes.js')) return '\0resume-scenes';
    if (file.endsWith('/shell/auth/AuthProvider.jsx')) return '\0resume-auth';
    if (file.endsWith('/shell/auth/SignInDoor.jsx')) return '\0resume-signin';
    if (file.endsWith('/telemetry/beacon.js')) return '\0resume-events';
    if (file.endsWith('/telemetry/sentry.js')) return '\0resume-issues';
  },
  load(id) {
    if (id === '\0resume-entry') return entry;
    if (id === '\0resume-switch') return `export const ROOM_READS_REPLICA = new URLSearchParams(location.search).get('replica') === 'on';`;
    if (id === '\0resume-scenes') return `export const mountHero = () => ({ setAutoplay() {}, teardown() {} });
      export const mountBeat = () => () => {}; export const mountThumb = () => () => {};`;
    if (id === '\0resume-auth') return auth;
    if (id === '\0resume-signin') return 'export const useSignInDoor = () => () => {}; export const useSignInDoorHost = () => () => {};';
    if (id === '\0resume-events') return beacon;
    if (id === '\0resume-issues') return 'export function captureError(product, operation) { (window.issues ??= []).push(operation); }';
  },
};

const { output } = await build({ configFile: false, root, logLevel: 'silent', mode: 'development', plugins: [plugin],
  build: { write: false, minify: false, sourcemap: false, cssCodeSplit: false, modulePreload: false, target: 'es2022',
    rollupOptions: { input: '/resume-host-entry.js', output: { entryFileNames: 'host-entry.js' } } } });
const files = new Map(output.map((file) => ['/' + file.fileName, file.type === 'chunk' ? file.code : file.source]));
const stylesheet = [...files.keys()].find((path) => path.endsWith('.css'));

// The model server: roadmap's records as the engine's reference server keeps them, and the rooms' list of the same two
// roadmaps for a person signed in, unless the page's cookie says the move has happened, when every `/v1/trees` route
// answers 410 and is counted.
let state = null;
let refused = 0;
const product = new RoadmapProduct();
const http = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (url.pathname.startsWith('/v1/sync/')) {
    const account = request.headers['x-fixture-account'] || null;
    const endpoint = url.pathname.slice('/v1/sync/'.length);
    let text = '';
    for await (const chunk of request) text += chunk;
    const serverNow = Date.now();
    if (endpoint === 'hello') {
      const answer = hello({ state, registry, account, serverTime: serverNow });
      return json(answer.status, answer.body);
    }
    const out = (endpoint === 'push' ? push : pull)({ state, registry, product, account, request: JSON.parse(text), serverNow });
    state = out.state;
    return json(out.response.status, out.response.body);
  }
  if (url.pathname.startsWith('/v1/trees')) {
    if (request.headers.cookie?.includes('moved')) {
      refused += 1;
      return json(410, { code: 'client-update-required' });
    }
    if (url.pathname !== '/v1/trees') return json(404, {});
    if (!request.headers.cookie?.includes('signed-in')) return json(401, {});
    const now = Date.now();
    return json(200, { trees: [{ id: ROW, title: 'Learn to row', done: 0, total: 2, updatedAt: now }, { id: SAIL, title: 'Learn to sail', done: 1, total: 3, updatedAt: now - 1000 }] });
  }
  if (url.pathname.startsWith('/v1/')) return json(200, {});
  if (url.pathname === '/host') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${stylesheet}"><div id="root"></div><script type="module" src="/host-entry.js"></script>`);
    return;
  }
  const file = files.get(url.pathname) ?? (() => {
    const path = join(root, 'public', url.pathname);
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null;
  })();
  if (!file) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[extname(url.pathname)] ?? 'application/octet-stream' });
  response.end(file);
});
await new Promise((listening) => http.listen(0, '127.0.0.1', listening));
const origin = `http://127.0.0.1:${http.address().port}`;
const browser = await chromium.launch({ headless: true });
after(async () => {
  await browser.close();
  http.close();
});

// What the home card and the landing's offer say once the card's link reads `link`, in a fresh browser: the card's link
// and line, and the landing's offers and line, with how long ago a roadmap was tended said as `recently`. `account` is who
// is signed in, `replica` the switch, `plant` the roadmaps the device's copy holds first.
async function offered({ account = null, replica, plant = [], link }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await context.addCookies([{ name: 'fixture', value: `${account ? 'signed-in' : 'ghost'}${replica ? '-moved' : ''}`, url: origin }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    const params = new URLSearchParams({ replica: replica ? 'on' : 'off', plant: JSON.stringify(plant) });
    if (account) params.set('account', account);
    await page.goto(`${origin}/host?${params}`);
    const recently = (text) => text.replace(/just now|\d+ minutes? ago/, 'recently');
    const card = page.locator('.wm-rhc');
    await card.locator('.wm-rhc-link', { hasText: link }).waitFor();
    const hero = page.locator('section', { has: page.locator('h1') }).first();
    await hero.getByRole('button', { name: link.replace(' →', ''), exact: true }).waitFor();
    return {
      home: [await card.locator('.wm-rhc-link').innerText(), recently(await card.locator('.wm-rhc-body').innerText())],
      landing: { offers: await hero.getByRole('button').allInnerTexts(), line: recently(await hero.locator('.wrap > div').last().innerText()) },
      failures,
    };
  } finally {
    await context.close();
  }
}

test('signed in, the home card and the landing offer the newest of the account’s roadmaps from the device’s copy with every list route refused, as today’s list offers it', async () => {
  state = ServerState.empty({ epoch: 'ep-resume', accounts: { u_owner: { name: 'Owner' } } });
  refused = 0;
  const copy = await offered({ account: 'u_owner', replica: true, link: 'Resume Learn to row →',
    plant: [[SAIL, 'Learn to sail', ['Choose a course', 'Read the wind', 'Leave the dock'], true], [ROW, 'Learn to row', ['Grip the oars', 'Pull together'], false]] });
  const today = await offered({ account: 'u_owner', replica: false, link: 'Resume Learn to row →' });
  assert.deepEqual({ copy, refused }, { refused: 0, copy: {
    home: ['Resume Learn to row →', 'Learn to row · 0/2 done · last tended recently'],
    landing: { offers: ['Resume Learn to row', 'My trees'], line: 'Learn to row · 0/2 done · last tended recently' },
    failures: [],
  } });
  assert.deepEqual(today, copy);
});

test('signed out, the device’s copy offers back the browser’s own roadmap where today’s list offers a first roadmap, and asks the server for no list', async () => {
  state = ServerState.empty({ epoch: 'ep-resume-anon', accounts: {} });
  refused = 0;
  const copy = await offered({ replica: true, link: 'Resume Learn to swim →', plant: [[SAIL, 'Learn to swim', ['Float on your back'], false]] });
  const today = await offered({ replica: false, link: 'Start your tree →' });
  const first = 'No account needed — your first tree lives in your browser.';
  assert.deepEqual({ copy, today, refused }, {
    copy: { home: ['Resume Learn to swim →', 'Learn to swim · 0/1 done'], landing: { offers: ['Resume Learn to swim', 'My trees'], line: 'Learn to swim · 0/1 done' }, failures: [] },
    today: { home: ['Start your tree →', first], landing: { offers: ['Start your tree', 'Try the live demo'], line: first }, failures: [] },
    refused: 0,
  });
});

// A page whose copy opens `late` ms after it draws, past the bound the copy is first waited for: what the landing's chrome
// offers while it waits, once the bound passes, and once the copy opens and lists `link`, with the landing's cache of the
// person's list after the bound and at the end. `cached` is that cache as an earlier visit left it.
async function lateCopy({ account = null, plant, cached = null, link, late = 15_000 }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await context.addCookies([{ name: 'fixture', value: `${account ? 'signed-in' : 'ghost'}-moved`, url: origin }]);
    if (cached) await context.addInitScript((rows) => { if (!localStorage.getItem('windmill:trees:ada@example.com')) localStorage.setItem('windmill:trees:ada@example.com', rows); }, JSON.stringify(cached));
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    const cache = () => page.evaluate(() => JSON.parse(localStorage.getItem('windmill:trees:ada@example.com') ?? 'null')?.map(({ title }) => title) ?? null);
    const params = new URLSearchParams({ replica: 'on', late: String(late), plant: JSON.stringify(plant) });
    if (account) params.set('account', account);
    await page.goto(`${origin}/host?${params}`);
    const hero = page.locator('section', { has: page.locator('h1') }).first();
    const cluster = page.locator('.landing-cluster');
    const offers = async () => ({ chrome: await cluster.getByRole('button').allInnerTexts(), hero: await hero.getByRole('button').allInnerTexts() });
    await hero.getByRole('button').first().waitFor({ timeout: 10_000 });
    const waiting = await offers();
    // The bound (`FIRST_COPY_MS`, ten seconds from the reading's start as the page loads) has passed and the copy has not
    // opened yet.
    await page.waitForFunction(() => performance.now() >= 12_500, null, { timeout: 15_000 });
    const atTheBound = { ...await offers(), cache: await cache(), early: await page.evaluate((at) => performance.now() < at, late) };
    await hero.getByRole('button', { name: link, exact: true }).waitFor({ timeout: late + 10_000 }).catch(() => {});
    await page.waitForFunction((name) => !name || JSON.parse(localStorage.getItem('windmill:trees:ada@example.com') ?? '[]')[0]?.title === name,
      account ? link.replace('Resume ', '') : null, { timeout: 5_000 }).catch(() => {});
    return { waiting, atTheBound, opened: { ...await offers(), cache: await cache() }, failures };
  } finally {
    await context.close();
  }
}

test('signed out, a copy that opens after the bound: the landing’s chrome waits on it as it waits on a person signed in, then offers a first roadmap, and the browser’s own once the copy opens', async () => {
  state = ServerState.empty({ epoch: 'ep-resume-late', accounts: {} });
  const seen = await lateCopy({ link: 'Resume Learn to swim', plant: [[SAIL, 'Learn to swim', ['Float on your back'], false]] });
  assert.deepEqual(seen, {
    waiting: { chrome: [], hero: ['Start your tree', 'Try the live demo'] },
    atTheBound: { chrome: ['Sign in', ''], hero: ['Start your tree', 'Try the live demo'], cache: null, early: true },
    opened: { chrome: ['Sign in', ''], hero: ['Resume Learn to swim', 'My trees'], cache: null },
    failures: [],
  });
});

test('signed in, a copy that opens after the bound leaves the landing’s cache of the list as an earlier visit left it, and the landing offers it, until the copy lists the account’s roadmaps', async () => {
  state = ServerState.empty({ epoch: 'ep-resume-late-account', accounts: { u_owner: { name: 'Owner' } } });
  const seen = await lateCopy({ account: 'u_owner', link: 'Resume Learn to row', cached: [{ id: SAIL, title: 'Learn to sail', done: 1, total: 3, updatedAt: Date.now() }],
    plant: [[SAIL, 'Learn to sail', ['Choose a course', 'Read the wind', 'Leave the dock'], true], [ROW, 'Learn to row', ['Grip the oars', 'Pull together'], false]] });
  assert.deepEqual(seen, {
    waiting: { chrome: ['My trees', 'A'], hero: ['Resume Learn to sail', 'My trees'] },
    atTheBound: { chrome: ['My trees', 'A'], hero: ['Resume Learn to sail', 'My trees'], cache: ['Learn to sail'], early: true },
    opened: { chrome: ['My trees', 'A'], hero: ['Resume Learn to row', 'My trees'], cache: ['Learn to row', 'Learn to sail'] },
    failures: [],
  });
});
