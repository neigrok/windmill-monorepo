import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { scene } from '../skillTreeViewHost.js';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { IDLE_MS } from '../../../../src/products/roadmap/sync/retirement.js';
import { SYNC_STATUS } from '../../../../src/products/roadmap/copy.js';

// The room as Vite builds it, served by a server that is also its backend: REST, the socket on the same origin, and the
// switch that turns every roadmap door into what the cutover answers, 410 `client-update-required`.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const PORT = 5371;
const TREE = {
  id: 't_sail', title: 'Learn to sail', author: 'Ada Lovelace', kinds: [], nodes: [
    { id: 'course', label: 'Choose a course', color: 'terracotta', prerequisites: [] },
    { id: 'wind', label: 'Read the wind', color: 'terracotta', prerequisites: ['course'] },
    { id: 'dock', label: 'Leave the dock', color: 'terracotta', prerequisites: ['wind'] },
  ],
};
const RETIRED_BODY = JSON.stringify({ error: 'This version of the app can no longer save; update it.', code: 'client-update-required' });
const TODAYS_SOCKET_GET = '<html>\n<head><title>404 Not Found</title></head>\n<body bgcolor="white" text="black">\n<center><h1>404 Not Found</h1></center>\n<hr><center>drogon/1.9.13</center>\n</body>\n</html>';

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SyncSession } from '/src/products/roadmap/sync/SyncSession.js';
import { SkillTreeView } from '/src/products/roadmap/SkillTreeView.jsx';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { StepDraftProvider, StepDraftNotice } from '/src/products/roadmap/step/StepDraftProvider.jsx';
import { ProductSessions } from '/src/shell/ProductSessions.jsx';
import { DocumentDataScope } from '/src/shell/auth/accountChange.js';
import { stepDraftSession } from '/src/products/roadmap/step/StepDraftSession.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
Object.assign(window, { ceremonies: [], revealed: [], revealFrames: [], cameraCalls: [] });
const start = SyncSession.prototype.start;
SyncSession.prototype.start = function () { window.session = this; return start.call(this); };
const scope = new DocumentDataScope({ invalidate: () => stepDraftSession(document, { create: false })?.invalidate() });
scope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'bound', account: 'u_fixture' } } } });
const room = React.createElement(Shell, { location: { pathname: '/app', hash: location.hash, search: location.search },
  neutral: { Component: SkillTreeView, props: { treeId: 't_sail', demo: false } } });
createRoot(document.getElementById('root')).render(React.createElement(ProductSessions, {
  dataScope: scope.read, products: [{ session: { Provider: StepDraftProvider, Notice: StepDraftNotice } }],
}, room));
`;
// What the page reports outlives its reloads: events and Issues are kept in the tab's session storage.
const KEEP = `(key, entry) => sessionStorage.setItem(key, JSON.stringify([...JSON.parse(sessionStorage.getItem(key) ?? '[]'), entry]))`;
const beacon = `
const keep = ${KEEP};
export function track(name, props) { keep('fixture:events', { name, props }); }
export function reportError(error) { keep('fixture:errors', String(error)); }
export function routeFamily(route) { return route; }
`;
const sentry = `
const keep = ${KEEP};
export function captureError(product, operation, stack, route, tags) { keep('fixture:issues', { operation, tags: tags ?? null }); }
`;
const auth = `
const account = { id: 'u_fixture' };
const user = { name: 'Ada' };
const refresh = async () => null;
export const useAuth = () => ({ status: 'signed-in', user, account, confirmed: true, refresh });
`;
const HOST_PLUGIN = { name: 'retired-room-host', enforce: 'pre',
  resolveId(id, importer) {
    if (id === '/retired-room-entry.js') return '\0retired-entry';
    const file = id.startsWith('.') && importer ? resolve(dirname(importer), id) : id;
    if (file.endsWith('/scene/SkillTreeScene.js')) return '\0retired-scene';
    if (file.endsWith('/shell/auth/AuthProvider.jsx')) return '\0retired-auth';
    if (file.endsWith('/shell/auth/SignInDoor.jsx')) return '\0retired-signin';
    if (file.endsWith('/telemetry/beacon.js')) return '\0retired-events';
    if (file.endsWith('/telemetry/sentry.js')) return '\0retired-issues';
  },
  load(id) {
    if (id === '\0retired-entry') return entry;
    if (id === '\0retired-scene') return scene;
    if (id === '\0retired-auth') return auth;
    if (id === '\0retired-signin') return 'const open = () => {}; export const useSignInDoor = () => open; export const useSignInDoorHost = () => () => {};';
    if (id === '\0retired-events') return beacon;
    if (id === '\0retired-issues') return sentry;
  },
};

const CONTENT_TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' };
const roomPage = (stylesheet) => '<!doctype html><meta name="viewport" content="width=device-width">'
  + '<script>try{if(!localStorage.getItem("windmill:view:last"))localStorage.setItem("windmill:view:last",JSON.stringify({t_sail:"board"}));}catch{}</script>'
  + `<link rel="stylesheet" href="${stylesheet}"><div id="root" style="height:100vh"></div><script type="module" src="/host-entry.js"></script>`;

// The socket's frames, by hand and under 64 KiB, as every frame of this room is: the browser masks what it sends.
function readFrame(buffer) {
  if (buffer.length < 4) return null;
  const extended = (buffer[1] & 0x7f) === 126;
  const length = extended ? buffer.readUInt16BE(2) : buffer[1] & 0x7f;
  let offset = extended ? 4 : 2;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length)).map((byte, index) => byte ^ mask[index % 4]);
  return { opcode: buffer[0] & 0x0f, payload, size: offset + length };
}

function frame(opcode, payload) {
  const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length])
    : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

// The fake backend's one switch and what it saw: page loads, plain reads of the socket's path, frames and writes.
const backend = { retired: false, documents: 0, probes: 0, writes: [], frames: [], sockets: new Set() };
const server = new SyncSession({ treeId: 't_sail', registry: null });
server.seed(TREE);

function speak(socket, message) {
  socket.write(frame(1, Buffer.from(JSON.stringify(message))));
}

function hear(socket, message) {
  if (message.t === 'subscribe') {
    speak(socket, { t: 'subgraph', intent: 'delta', treeId: 't_sail', seq: 1, reach: 'writer', ...server.lattice.toFrame() });
    speak(socket, { t: 'progress', intent: 'graft', treeId: 't_sail', marks: [] });
    return;
  }
  if (message.t === 'ping') return speak(socket, { t: 'pong' });
  if (message.t === 'subgraph') {
    backend.frames.push(message);
    return speak(socket, { t: 'subgraphAck', frameId: message.frameId, seq: 1 + backend.frames.length });
  }
  if (message.t === 'progress') return speak(socket, { t: 'progressAck', frameId: message.frameId });
}

function upgrade(request, socket) {
  if (backend.retired) {
    socket.end(`HTTP/1.1 410 Gone\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(RETIRED_BODY)}\r\nConnection: close\r\n\r\n${RETIRED_BODY}`);
    return;
  }
  const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  backend.sockets.add(socket);
  socket.on('close', () => backend.sockets.delete(socket));
  socket.on('error', () => {});
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let read = readFrame(buffer); read; read = readFrame(buffer)) {
      buffer = buffer.subarray(read.size);
      if (read.opcode === 8) return void socket.end(frame(8, Buffer.alloc(0)));
      if (read.opcode === 1) hear(socket, JSON.parse(read.payload.toString('utf8')));
    }
  });
}

// The server's cutover cuts every live socket; a session that reconnects then meets the retired upgrade.
function cutLiveSockets() {
  for (const socket of backend.sockets) socket.end(frame(8, Buffer.from([0x03, 0xe8])));
}

function answer(response, status, body, type = 'application/json') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

function api(request, response, path) {
  if (path === '/v1/socket') {
    backend.probes += 1;
    return backend.retired ? answer(response, 410, RETIRED_BODY) : answer(response, 404, TODAYS_SOCKET_GET, 'text/html; charset=utf-8');
  }
  if (request.method !== 'GET') {
    backend.writes.push(`${request.method} ${path}`);
    return backend.retired ? answer(response, 410, RETIRED_BODY) : answer(response, 204, '');
  }
  if (path === '/v1/me') return answer(response, 200, JSON.stringify({ user: { id: 'u_fixture' } }));
  if (path === '/v1/trees/t_sail') return answer(response, 200, JSON.stringify({ data: TREE, root: 't_sail', parent: null, path: [], depth: 0, mine: true, visibility: 'public' }));
  if (path === '/v1/trees') return answer(response, 200, JSON.stringify({ trees: [{ id: 't_sail', title: TREE.title, done: 0, total: 3 }] }));
  if (path.endsWith('/activity')) return answer(response, 200, JSON.stringify({ events: [] }));
  if (path.endsWith('/guides')) return answer(response, 200, JSON.stringify({ guides: [] }));
  if (path === '/v1/tending') return answer(response, 200, JSON.stringify({ enabled: true, runs: [] }));
  return answer(response, 200, '{}');
}

let browser, host;
const ready = (async () => {
  const { output } = await build({
    configFile: false, root, logLevel: 'silent', mode: 'development', plugins: [HOST_PLUGIN],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
    build: {
      write: false, minify: false, sourcemap: false, cssCodeSplit: false, modulePreload: false,
      rollupOptions: { input: '/retired-room-entry.js', output: { entryFileNames: 'host-entry.js' } },
    },
  });
  const files = new Map(output.map((file) => ['/' + file.fileName, file.type === 'chunk' ? file.code : file.source]));
  const stylesheet = [...files.keys()].find((path) => path.endsWith('.css'));
  host = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/v1/')) return api(request, response, url.pathname);
    if (url.pathname === '/retired-room') {
      backend.documents += 1;
      return answer(response, 200, roomPage(stylesheet), 'text/html');
    }
    const publicPath = join(root, 'public', url.pathname);
    const file = files.get(url.pathname) ?? (existsSync(publicPath) && statSync(publicPath).isFile() ? readFileSync(publicPath) : null);
    if (!file) return answer(response, 404, '', 'text/plain');
    return answer(response, 200, file, CONTENT_TYPES[extname(url.pathname)] ?? 'application/octet-stream');
  });
  host.on('upgrade', (request, socket) => {
    if (new URL(request.url, 'http://localhost').pathname === '/v1/socket') upgrade(request, socket);
    else socket.destroy();
  });
  await new Promise((listening) => host.listen(PORT, '127.0.0.1', listening));
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally {
    await browser?.close();
    for (const socket of backend.sockets) socket.destroy();
    host?.closeAllConnections();
    host?.close();
  }
});

// A fresh tab on a backend that is live again, with every page error and every console error but the browser's own lines
// for the retired answers failing the test.
async function openRoom() {
  await ready;
  Object.assign(backend, { retired: false, documents: 0, probes: 0, writes: [], frames: [] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/^WebSocket connection to '.+\/v1\/socket' failed: .*Unexpected response code: 410$/.test(text)) return;
    if (text === 'Failed to load resource: the server responded with a status of 410 (Gone)') return;
    errors.push(text);
  });
  await page.goto(`http://127.0.0.1:${PORT}/retired-room#/app/t_sail`);
  await page.waitForFunction(() => window.session?.phase === 'live', null, { timeout: 30000 });
  return { context, page, errors };
}

async function until(condition, what, limitMs = 15000) {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((settled) => setTimeout(settled, 50));
  }
}

const waitPastIdle = () => new Promise((settled) => setTimeout(settled, IDLE_MS + 1500));
const retiredEvents = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture:events') ?? '[]')
  .filter(({ name }) => name === 'roadmap_sync_retired').map(({ props }) => props));
const issues = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture:issues') ?? '[]'));

test('Chromium: the retired socket keeps a typed draft and every edit, reloads once the page is idle, and the same build stays offline', async () => {
  const { context, page, errors } = await openRoom();
  try {
    await page.locator('.st-board-card[data-step-id="wind"]').click();
    await page.getByRole('button', { name: 'Edit name', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Read the gusts');

    backend.retired = true;
    cutLiveSockets();
    await until(() => backend.probes === 1, 'the probe of the socket’s path');
    await page.waitForFunction(() => window.session.phase === 'offline' && window.session.ws === null);
    await waitPastIdle();
    assert.equal(backend.documents, 1, 'no reload while the draft is open');
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Read the gusts');

    await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
    await until(() => backend.documents === 2, 'the reload once the page is idle');
    await page.getByRole('article', { name: 'Read the gusts', exact: true }).waitFor();
    await until(() => backend.probes === 2, 'the reloaded page’s probe');
    await page.getByRole('status').filter({ hasText: SYNC_STATUS.offline }).waitFor();
    await waitPastIdle();
    assert.equal(backend.documents, 2, 'the same retired build stays offline');
    assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ id }) => id === 'wind').label), 'Read the gusts');
    assert.equal(await page.evaluate(() => window.session.pendingEditCount()), 1);
    assert.deepEqual(backend.frames, [], 'the server never received the edit');
    assert.deepEqual(await retiredEvents(page), [
      { step: 'detected', door: 'socket' },
      { step: 'reload', door: 'socket', outcome: 'deferred' },
      { step: 'reload', door: 'socket', outcome: 'ran' },
      { step: 'detected', door: 'socket' },
      { step: 'reload', door: 'socket', outcome: 'suppressed' },
    ]);
    assert.deepEqual(await issues(page), []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Chromium: a retired write door stands the room offline, waits out the dialog and a held pointer, and reloads as the page hides', async () => {
  const { context, page, errors } = await openRoom();
  try {
    backend.retired = true;
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('button', { name: 'Make private', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Network request failed' }).waitFor();
    await page.waitForFunction(() => window.session.phase === 'offline' && window.session.ws === null);
    assert.deepEqual(backend.writes, ['PATCH /v1/trees/t_sail']);
    await page.evaluate(() => window.session.dispatch({ kind: 'RenameNode', id: 'dock', label: 'Leave the dock at dawn' }));
    await waitPastIdle();
    assert.equal(backend.documents, 1, 'no reload while the dialog is open');

    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.mouse.move(8, 992);
    await page.mouse.down();
    await waitPastIdle();
    assert.equal(backend.documents, 1, 'no reload while a pointer is pressed in view');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await until(() => backend.documents === 2, 'the reload as the page hides');
    await page.mouse.up();
    await page.locator('.st-board-card[data-step-id="dock"]').filter({ hasText: 'Leave the dock at dawn' }).waitFor();
    await until(() => backend.probes === 1, 'the reloaded page’s probe');
    await page.waitForFunction(() => window.session?.ws === null && window.session.phase === 'offline');
    assert.deepEqual(backend.writes, ['PATCH /v1/trees/t_sail']);
    assert.deepEqual(backend.frames, []);
    assert.deepEqual(await retiredEvents(page), [
      { step: 'detected', door: 'write' },
      { step: 'reload', door: 'write', outcome: 'deferred' },
      { step: 'reload', door: 'write', outcome: 'ran' },
      { step: 'detected', door: 'socket' },
      { step: 'reload', door: 'socket', outcome: 'suppressed' },
    ]);
    assert.deepEqual(await issues(page), [], 'the refused share reports no Issue');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
