import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { HttpTransport } from '../../../src/platform/sync/transport.js';
import { socketUrl } from '../../../src/shell/apiBase.js';
import { evalJson, httpOrigin, installReadOnlyGuard, installRoadmapObserver, settleVisuals, waitForConfirmed } from '../../../scripts/roadmap-rig/browser-proof.mjs';

test('roadmap socket fixtures follow the production client and backend route', { timeout: 2000 }, async () => {
  const backend = await readFile(new URL('../../../../backend/products/roadmap/adapters/ws/TreeSocket.h', import.meta.url), 'utf8');
  const routes = [...backend.matchAll(/WS_PATH_ADD\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(routes, [new URL(socketUrl()).pathname]);
});

test('engine fixtures follow the browser engine\'s pull and live routes', { timeout: 2000 }, async () => {
  const sent = [];
  const transport = new HttpTransport({ schema: 13, base: 'http://localhost:5317', origin: 'http://localhost:5317', reading: () => 0,
    socket: (url) => url, fetch: async (url, options) => { sent.push({ path: new URL(url).pathname, method: options.method }); return new Response('{}'); } });
  await transport.request('pull', { scopes: [] });
  assert.deepEqual({ sent, live: new URL(transport.openLive()).pathname }, { sent: [{ path: '/v1/sync/pull', method: 'POST' }], live: '/v1/sync/live' });
});

test('capture validates both frontend and API origins before starting Chrome', { timeout: 2000 }, async () => {
  const source = await readFile(new URL('../../../scripts/roadmap-rig/capture.mjs', import.meta.url), 'utf8');
  const config = source.slice(source.indexOf('const args = {};'), source.indexOf('const treeId ='));
  for (const [api, expected] of [[undefined, 'http://localhost:5317'], ['http://localhost:8317/', 'http://localhost:8317']]) {
    const argv = ['node', 'capture.mjs', '--origin', 'http://localhost:5317/', ...(api ? ['--api', api] : [])];
    const result = vm.runInNewContext(`${config}\nJSON.stringify({ origin, apiOrigin })`, { process: { argv }, httpOrigin });
    assert.deepEqual(JSON.parse(result), { origin: 'http://localhost:5317', apiOrigin: expected });
  }
  for (const value of ['not-an-origin', 'file:///PRIVATE_CANARY', 'http://user:PRIVATE_CANARY@localhost:8317',
    'http://localhost:8317/PRIVATE_CANARY', 'http://localhost:8317?secret=PRIVATE_CANARY', 'http://localhost:8317#PRIVATE_CANARY']) {
    for (const option of ['--origin', '--api']) {
      const argv = ['node', 'capture.mjs', '--origin', 'http://localhost:5317', option, value];
      assert.throws(() => vm.runInNewContext(config, { process: { argv }, httpOrigin }), { message: 'Expected an HTTP origin' });
    }
  }
});

test('CDP awaits async callback results before JSON serialization and fails page exceptions', { timeout: 2000 }, async () => {
  assert.equal(await vm.runInNewContext('JSON.stringify((async () => true)())'), '{}');
  const cdp = { async send(method, options) {
    assert.equal(method, 'Runtime.evaluate');
    assert.equal(options.awaitPromise, true);
    assert.equal(options.returnByValue, true);
    return { result: { value: await vm.runInNewContext(options.expression) } };
  } };
  assert.deepEqual(await evalJson(cdp, 'async () => ({ settled: true })'), { settled: true });
  assert.equal(await evalJson(cdp, '() => true'), true);
  assert.equal(await evalJson(cdp, '() => undefined'), undefined);
  await assert.rejects(evalJson({ send: async () => ({ exceptionDetails: { text: 'PRIVATE_CANARY' } }) }, '() => true'),
    { message: 'Browser evaluation failed' });
});

test('confirmation returns the matched authoritative value and bounds pending readers', { timeout: 2000 }, async () => {
  let reads = 0;
  const value = await waitForConfirmed(async () => ({ saved: ++reads === 3, content: 'PRIVATE_CANARY' }), (row) => row.saved,
    { timeoutMs: 300, intervalMs: 5, label: 'saved-record' });
  assert.deepEqual(value, { saved: true, content: 'PRIVATE_CANARY' });
  assert.equal(reads, 3);
  await assert.rejects(waitForConfirmed(() => new Promise(() => {}), () => true,
    { timeoutMs: 30, intervalMs: 5, label: 'saved-record' }), { message: 'Timed out waiting for saved-record' });
});

test('confirmation errors never include raw values, reader errors or invalid labels', { timeout: 2000 }, async () => {
  await assert.rejects(waitForConfirmed(async () => ({ content: 'PRIVATE_CANARY' }), () => false,
    { timeoutMs: 30, intervalMs: 5, label: 'saved-record' }), { message: 'Timed out waiting for saved-record' });
  await assert.rejects(waitForConfirmed(async () => { throw new Error('PRIVATE_CANARY'); }, () => true,
    { label: 'saved-record' }), { message: 'Confirmation failed for saved-record' });
  await assert.rejects(waitForConfirmed(async () => true, () => { throw new Error('PRIVATE_CANARY'); },
    { label: 'saved-record' }), { message: 'Confirmation failed for saved-record' });
  await assert.rejects(waitForConfirmed(async () => true, () => true, { label: 'PRIVATE CANARY' }),
    { message: 'Invalid confirmation wait options' });
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { intervalMs: 0 }]) {
    await assert.rejects(waitForConfirmed(async () => true, () => true, options), { message: 'Invalid confirmation wait options' });
  }
});

// Only synthetic local HTTP/WebSocket traffic; host aliases all resolve to the fixture listener.
async function fixture(t) {
  const received = [];
  const bodies = [];
  const peers = [];
  const connections = new Set();
  const font = await readFile(new URL('../../../node_modules/@fontsource/nunito/files/nunito-latin-700-italic.woff2', import.meta.url));
  let releaseFont;
  const fontGate = new Promise((resolve) => { releaseFont = resolve; });
  const script = 'window.analyticsScriptExecuted = true;';
  const pull = { answer: { as: null, pages: [] } };
  const handler = async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, host: request.headers.host, path: request.url });
    if (chunks.length) bodies.push({ host: request.headers.host, path: request.url, body: Buffer.concat(chunks).toString() });
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (request.url === '/redirect-307' || request.url === '/redirect-308') {
      response.writeHead(Number(request.url.slice(-3)), { Location: 'http://site.proof.test:5317/redirect-write' }).end();
      return;
    }
    if (request.url === '/font.woff2') {
      await fontGate;
      response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(font);
      return;
    }
    if (request.url === '/v1/sync/pull') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(pull.answer));
      return;
    }
    if (request.url === '/beacon.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script);
      return;
    }
    if (request.url === '/font') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><style>
        @font-face { font-family: Proof; src: url('/font.woff2'); font-style: italic; font-weight: 700; font-display: swap; }
        p { font: italic 700 24px Proof; } .hidden { opacity: 0; } .offscreen { position: absolute; top: 2000px; }
        </style><p>Visible text Ω</p><p class="hidden">Hidden</p><p class="offscreen">Off screen</p>`);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html data-theme="light"><body><p>Fixture</p><div class="st-roadmap-identity" data-view="board"></div></body></html>');
  };
  const server = http.createServer(handler);
  const api = http.createServer(handler);
  for (const listener of [server, api]) {
    listener.on('connection', (socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });
  }
  const upgrade = (request, socket) => {
    if (![new URL(socketUrl()).pathname, '/other', '/v1/sync/live'].includes(new URL(request.url, 'http://fixture').pathname)) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const peer = { frames: [], path: request.url, socket, send(frame) {
      const data = Buffer.from(JSON.stringify(frame));
      const header = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
      socket.write(Buffer.concat([header, data]));
    } };
    peers.push(peer);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 6) {
        const extended = (buffer[1] & 127) === 126;
        const length = extended ? buffer.readUInt16BE(2) : buffer[1] & 127;
        const maskOffset = extended ? 4 : 2;
        const dataOffset = maskOffset + 4;
        if (buffer.length < dataOffset + length) return;
        const opcode = buffer[0] & 15;
        const payload = Buffer.from(buffer.subarray(dataOffset, dataOffset + length));
        for (let at = 0; at < length; at += 1) payload[at] ^= buffer[maskOffset + at % 4];
        buffer = buffer.subarray(dataOffset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode === 1) peer.frames.push(JSON.parse(payload.toString()));
      }
    });
    socket.on('error', () => {});
  };
  for (const listener of [server, api]) listener.on('upgrade', upgrade);
  t.after(async () => {
    releaseFont();
    const closed = [server, api].map((listener) => new Promise((resolve) => listener.close(resolve)));
    for (const socket of connections) socket.destroy();
    await Promise.all(closed);
  });
  await Promise.all([new Promise((resolve) => server.listen(5317, '127.0.0.1', resolve)),
    new Promise((resolve) => api.listen(8317, '127.0.0.1', resolve))]);
  return { origin: 'http://site.proof.test:5317', api: 'http://site.proof.test:8317', peers, received, bodies, releaseFont, script, pull };
}

test('browser: settlement, subscription and network guards on real local connections', { timeout: 180000 }, async (t) => {
  const site = await fixture(t);
  const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP * 127.0.0.1'] });
  t.after(() => browser.close());

  await t.test('visible styled fonts finish loading; timeout is bounded', { timeout: 15000 }, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${site.origin}/font`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        window.fontCalls = [];
        const load = document.fonts.load.bind(document.fonts);
        document.fonts.load = (font, text) => { window.fontCalls.push({ font, text }); return load(font, text); };
      });
      await assert.rejects(page.evaluate(settleVisuals, { timeoutMs: 80 }), /Timed out waiting for visual settlement/);
      const pending = page.evaluate(async (source) => {
        const result = await (0, eval)(`(${source})`)({ timeoutMs: 5000 });
        window.visualsDone = true;
        return result;
      }, settleVisuals.toString());
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => window.visualsDone ?? false), false);
      site.releaseFont();
      assert.deepEqual(await pending, { fonts: 1, animations: 0, frames: 2 });
      assert.deepEqual(await page.evaluate(() => window.fontCalls), [
        { font: 'italic 700 24px Proof', text: 'Visible text Ω' }, { font: 'italic 700 24px Proof', text: 'Visible text Ω' },
      ]);
      assert.equal(await page.evaluate(() => document.fonts.check('italic 700 24px Proof', 'Visible text Ω')), true);
    } finally { await context.close(); }
  });

  await t.test('finite animations and two real frames finish while infinite animations keep running', { timeout: 15000 }, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(site.origin);
      await page.evaluate(() => {
        const element = document.querySelector('p');
        window.finite = element.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 250 });
        window.infinite = element.animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(1px)' }], { duration: 100, iterations: Infinity });
        const frame = window.requestAnimationFrame;
        window.frameCount = 0;
        window.requestAnimationFrame = (callback) => frame((time) => { window.frameCount += 1; callback(time); });
      });
      const result = await page.evaluate(settleVisuals, { timeoutMs: 3000 });
      assert.deepEqual(result, { fonts: 1, animations: 1, frames: 2 });
      assert.deepEqual(await page.evaluate(() => ({ finite: window.finite.playState, infinite: window.infinite.playState, frames: window.frameCount })),
        { finite: 'finished', infinite: 'running', frames: 2 });
      const cdp = await context.newCDPSession(page);
      assert.equal(await evalJson(cdp, '() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'), true);
      assert.equal(await page.evaluate(() => window.frameCount), 4);
    } finally { await context.close(); }
  });

  await t.test('callers confirm the requested theme and view rather than sleeping', { timeout: 15000 }, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(site.origin);
      const read = () => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, view: document.querySelector('.st-roadmap-identity').dataset.view }));
      await assert.rejects(waitForConfirmed(read, (value) => value.theme === 'dark' && value.view === 'tree',
        { timeoutMs: 80, intervalMs: 10, label: 'requested-roadmap-view' }), { message: 'Timed out waiting for requested-roadmap-view' });
      await page.evaluate(() => {
        requestAnimationFrame(() => {
          document.documentElement.dataset.theme = 'dark';
          document.querySelector('.st-roadmap-identity').dataset.view = 'tree';
        });
      });
      assert.deepEqual(await waitForConfirmed(read, (value) => value.theme === 'dark' && value.view === 'tree',
        { timeoutMs: 1000, intervalMs: 10, label: 'requested-roadmap-view' }), { theme: 'dark', view: 'tree' });
    } finally { await context.close(); }
  });

  await t.test('real socket baselines belong to the latest subscribe and never a live or unrelated frame', { timeout: 15000 }, async () => {
    const context = await browser.newContext();
    try {
      await context.addInitScript(installRoadmapObserver, { origins: [site.origin] });
      const page = await context.newPage();
      assert.equal(await page.evaluate(() => window.__roadmapProof), undefined);
      await page.goto(site.origin);
      await page.evaluate(async (socketPath) => {
        window.sockets = [];
        for (const path of ['/other', socketPath]) {
          const socket = new WebSocket(new URL(path, location.href).href.replace('http:', 'ws:'));
          await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
          window.sockets.push(socket);
        }
      }, new URL(socketUrl()).pathname);
      const baseline = (reach = 'reader') => page.evaluate((reach) => window.__roadmapProof.waitForBaseline({ treeId: 'wanted', reach, timeoutMs: 80 }), reach);
      await page.evaluate(() => window.sockets[0].send(JSON.stringify({ t: 'subscribe', treeId: 'wanted' })));
      site.peers[0].send({ t: 'subgraph', intent: 'delta', treeId: 'wanted', reach: 'reader' });
      site.peers[1].send({ t: 'subgraph', intent: 'delta', treeId: 'wanted', reach: 'reader' });
      await assert.rejects(baseline(), /Timed out waiting for roadmap subscription baseline/);
      await page.evaluate(() => window.sockets[1].send(JSON.stringify({ t: 'subscribe', treeId: 'wanted' })));
      site.peers[1].send({ t: 'subgraph', intent: 'delta', treeId: 'wrong', reach: 'reader' });
      site.peers[1].send({ t: 'subgraph', intent: 'live', treeId: 'wanted', reach: 'reader' });
      await assert.rejects(baseline(), /Timed out waiting for roadmap subscription baseline/);
      await page.evaluate(() => window.sockets[1].send(JSON.stringify({ t: 'subscribe', treeId: 'wanted' })));
      site.peers[1].send({ t: 'subgraph', intent: 'delta', treeId: 'wanted', reach: 'reader' });
      await assert.rejects(baseline(), /Timed out waiting for roadmap subscription baseline/);
      site.peers[1].send({ t: 'subgraph', intent: 'delta', treeId: 'wanted', reach: 'writer' });
      assert.deepEqual(await baseline('writer'), { treeId: 'wanted', reach: 'writer', generation: 2 });
      await assert.rejects(baseline(), /Timed out waiting for roadmap subscription baseline/);
      await page.evaluate(async (socketPath) => {
        const socket = new WebSocket(new URL(socketPath, location.href).href.replace('http:', 'ws:'));
        await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
        window.sockets.push(socket);
        socket.send(JSON.stringify({ t: 'subscribe', treeId: 'wanted' }));
      }, new URL(socketUrl()).pathname);
      site.peers[1].send({ t: 'subgraph', intent: 'delta', treeId: 'wanted', reach: 'reader' });
      await assert.rejects(baseline(), /Timed out waiting for roadmap subscription baseline/);
      site.peers[2].send({ t: 'subgraph', intent: 'delta', treeId: 'wanted', reach: 'reader', nodes: ['PRIVATE_CANARY'] });
      assert.deepEqual(await baseline(), { treeId: 'wanted', reach: 'reader', generation: 3 });
      await page.evaluate(() => window.sockets[2].send(JSON.stringify({ t: 'progress', value: 'PRIVATE_CANARY' })));
      await waitForConfirmed(() => site.peers[2].frames.at(-1), (frame) => frame?.t === 'progress', { label: 'socket-write-observed' });
      assert.deepEqual(await page.evaluate(() => ({ sockets: window.__roadmapProof.sockets, writes: window.__roadmapProof.writes })),
        { sockets: 2, writes: [{ type: 'progress' }] });
      await page.evaluate(async () => {
        const socket = window.sockets[2];
        socket.close();
        await new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
      });
      await assert.rejects(baseline(), /Timed out waiting for roadmap subscription baseline/);
      await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/frame'; document.body.append(frame); });
      await waitForConfirmed(() => page.frames().length, (count) => count === 2, { label: 'fixture-frame' });
      assert.equal(await page.frames()[1].evaluate(() => window.__roadmapProof), undefined);
      await page.goto('about:blank');
      assert.equal(await page.evaluate(() => window.__roadmapProof), undefined);
    } finally { await context.close(); }
  });

  await t.test('the production socket route works on same-origin and explicitly configured API origins', { timeout: 15000 }, async () => {
    for (const apiOrigin of [site.origin, site.api]) {
      const context = await browser.newContext();
      try {
        await context.addInitScript(installRoadmapObserver, { origins: [httpOrigin(site.origin), httpOrigin(apiOrigin)] });
        const page = await context.newPage();
        await page.goto(site.origin);
        const peerIndex = site.peers.length;
        const target = new URL(new URL(socketUrl()).pathname, apiOrigin).href.replace('http:', 'ws:');
        await page.evaluate(async (url) => {
          const socket = new WebSocket(url);
          await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
          socket.send(JSON.stringify({ t: 'subscribe', treeId: 'wanted' }));
          window.socket = socket;
        }, target);
        assert.equal(site.peers[peerIndex].path, new URL(socketUrl()).pathname);
        site.peers[peerIndex].send({ t: 'subgraph', intent: 'delta', treeId: 'wanted', reach: 'reader' });
        assert.deepEqual(await page.evaluate(() => window.__roadmapProof.waitForBaseline({ treeId: 'wanted', reach: 'reader', timeoutMs: 1000 })),
          { treeId: 'wanted', reach: 'reader', generation: 1 });
      } finally { await context.close(); }
    }
  });

  await t.test('engine baselines need the roadmap pulled from the server and followed on an open live socket', { timeout: 15000 }, async () => {
    const context = await browser.newContext();
    try {
      await context.addInitScript(installRoadmapObserver, { origins: [site.origin] });
      const page = await context.newPage();
      await page.goto(site.origin);
      const baseline = (asked = { reach: 'reader' }) => page.evaluate((asked) => window.__roadmapProof.waitForBaseline({ treeId: 'wanted', timeoutMs: 80, ...asked }), asked);
      const pulled = (answer, origin = site.origin) => {
        site.pull.answer = answer;
        return page.evaluate((url) => fetch(url, { method: 'POST', body: '{"scopes":[]}' }).then((reply) => reply.status), `${origin}/v1/sync/pull`);
      };
      const peerIndex = site.peers.length;
      await page.evaluate(async () => {
        window.live = new WebSocket(new URL('/v1/sync/live?schema=13', location.href).href.replace('http:', 'ws:'));
        await new Promise((resolve) => window.live.addEventListener('open', resolve, { once: true }));
      });
      const follow = (op, scopes) => page.evaluate(({ op, scopes }) => window.live.send(JSON.stringify({ op, scopes })), { op, scopes });
      const wantedRows = { as: null, pages: [{ scope: 'tree/wanted', kind: 'rows', rows: [{ label: 'PRIVATE_CANARY' }] }] };
      assert.equal(await pulled(wantedRows, site.api), 200);
      await follow('sub', ['tree/wanted']);
      await assert.rejects(baseline(), /Timed out waiting for roadmap subscription baseline/);
      await follow('unsub', ['tree/wanted']);
      assert.equal(await pulled(wantedRows), 200);
      await follow('sub', ['self/overlay/wanted', 'tree/other']);
      await assert.rejects(baseline(), /Timed out waiting for roadmap subscription baseline/);
      await follow('sub', ['tree/wanted']);
      assert.deepEqual(await baseline(), { treeId: 'wanted', reach: 'reader', generation: 3 });
      site.peers[peerIndex].send({ op: 'not-found', as: null, scope: 'tree/wanted' });
      await waitForConfirmed(() => baseline().then(() => false, () => true), (refused) => refused, { label: 'live-refusal-observed' });
      await follow('sub', ['tree/wanted']);
      assert.deepEqual(await baseline(), { treeId: 'wanted', reach: 'reader', generation: 4 });
      assert.equal(await pulled({ as: 'account', pages: [{ scope: 'tree/wanted', kind: 'rows', rows: [] }] }), 200);
      await assert.rejects(baseline(), /Timed out waiting for roadmap subscription baseline/);
      assert.deepEqual(await baseline({}), { treeId: 'wanted', reach: null, generation: 4 });
      assert.equal(await pulled({ as: null, pages: [{ scope: 'tree/wanted', kind: 'not-found' }] }), 200);
      await assert.rejects(baseline({}), /Timed out waiting for roadmap subscription baseline/);
      assert.equal(await pulled(wantedRows), 200);
      assert.deepEqual(await baseline(), { treeId: 'wanted', reach: 'reader', generation: 4 });
      await page.evaluate(async () => {
        window.live.close();
        await new Promise((resolve) => window.live.addEventListener('close', resolve, { once: true }));
      });
      await assert.rejects(baseline(), /Timed out waiting for roadmap subscription baseline/);
      assert.deepEqual(await page.evaluate(() => ({ sockets: window.__roadmapProof.sockets, writes: window.__roadmapProof.writes })), { sockets: 0, writes: [] });
    } finally { await context.close(); }
  });

  await t.test('HTTP mutations abort before receipt; exact origins, Sentry, RUM and SRI scripts keep their contracts', { timeout: 15000 }, async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const guard = await installReadOnlyGuard(context, { origins: [site.origin, site.api], sentryHosts: ['sentry.proof.test'] });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(site.origin);
      const before = site.received.length;
      const statuses = await page.evaluate(async ({ api }) => {
        const send = async (url, method = 'POST', body = 'PRIVATE_CANARY') => {
          try { return (await fetch(url, { method, body: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : body })).status; }
          catch { return 'blocked'; }
        };
        return Promise.all([
          send('/v1/events?private=PRIVATE_CANARY', 'POST', JSON.stringify({ events: [{ name: 'client_error', content: 'PRIVATE_CANARY' }] })),
          send('http://sentry.proof.test:5317/envelope'), send('http://ingest.sentry.io:5317/envelope'),
          send('http://cloudflareinsights.com:5317/rum'), send('/cdn-cgi/rum'),
          send('/v1/trees/PRIVATE_CANARY', 'DELETE'), send(`${api}/v1/trees/PRIVATE_CANARY`),
          send('http://site.proof.test.evil.proof.test:5317/v1/events', 'GET'),
          send('http://sentry.proof.test.evil.proof.test:5317/envelope', 'GET'), send('/v1/trees', 'GET'),
          send(`${api}/v1/sync/pull`, 'POST', '{"scopes":[]}'), send('/v1/sync/push'), send('http://outside.proof.test:5317/v1/sync/pull'),
        ]);
      }, { api: site.api });
      assert.deepEqual(statuses, [202, 200, 200, 200, 200, 'blocked', 'blocked', 200, 200, 200, 200, 'blocked', 'blocked']);
      const integrity = `sha256-${createHash('sha256').update(site.script).digest('base64')}`;
      await page.evaluate(({ integrity }) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'http://static.cloudflareinsights.com:5317/beacon.js';
        script.integrity = integrity;
        script.crossOrigin = 'anonymous';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Integrity checked analytics script failed'));
        document.head.append(script);
      }), { integrity });
      assert.equal(await page.evaluate(() => window.analyticsScriptExecuted), true);
      assert.deepEqual(site.received.slice(before).sort((a, b) => a.host.localeCompare(b.host)), [
        { method: 'GET', host: 'sentry.proof.test.evil.proof.test:5317', path: '/envelope' },
        { method: 'GET', host: 'site.proof.test:5317', path: '/v1/trees' },
        { method: 'POST', host: 'site.proof.test:8317', path: '/v1/sync/pull' },
        { method: 'GET', host: 'site.proof.test.evil.proof.test:5317', path: '/v1/events' },
        { method: 'GET', host: 'static.cloudflareinsights.com:5317', path: '/beacon.js' },
      ].sort((a, b) => a.host.localeCompare(b.host)));
      assert.deepEqual({ ...guard, writes: guard.writes.map(({ kind }) => kind).sort() }, { blocked: { intake: 1, sentry: 2, analytics: 2 },
        writes: ['external-http-mutation', 'http-mutation', 'http-mutation', 'http-mutation'], clientErrors: 1 });
      assert.deepEqual(errors, []);
      await page.evaluate(() => { setTimeout(() => { throw new Error('synthetic-page-error'); }, 0); });
      await waitForConfirmed(() => errors.length, (count) => count === 1, { label: 'page-error-observed' });
      assert.deepEqual(errors, ['synthetic-page-error']);
    } finally { await context.close(); }
  });

  await t.test('307 and 308 redirects cannot carry external POST bodies into a guarded origin', { timeout: 15000 }, async () => {
    for (const guarded of [false, true]) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        const guard = guarded ? await installReadOnlyGuard(context, { origins: [site.origin] }) : null;
        const page = await context.newPage();
        await page.goto(site.origin);
        const before = site.bodies.length;
        const statuses = await page.evaluate(async () => Promise.all([307, 308].map((status) =>
          fetch(`http://outside.proof.test:8317/redirect-${status}`, { method: 'POST', mode: 'no-cors', body: 'PRIVATE_REDIRECT_CANARY' })
            .then(() => 'sent', () => 'blocked'))));
        if (guarded) {
          assert.deepEqual(statuses, ['blocked', 'blocked']);
          assert.deepEqual(site.bodies.slice(before), []);
          assert.deepEqual(guard, { blocked: { intake: 0, sentry: 0, analytics: 0 },
            writes: [{ kind: 'external-http-mutation' }, { kind: 'external-http-mutation' }], clientErrors: 0 });
        } else {
          assert.deepEqual(statuses, ['sent', 'sent']);
          assert.deepEqual(site.bodies.slice(before).sort((a, b) => a.path.localeCompare(b.path)), [
            { host: 'outside.proof.test:8317', path: '/redirect-307', body: 'PRIVATE_REDIRECT_CANARY' },
            { host: 'outside.proof.test:8317', path: '/redirect-308', body: 'PRIVATE_REDIRECT_CANARY' },
            { host: 'site.proof.test:5317', path: '/redirect-write', body: 'PRIVATE_REDIRECT_CANARY' },
            { host: 'site.proof.test:5317', path: '/redirect-write', body: 'PRIVATE_REDIRECT_CANARY' },
          ]);
        }
      } finally { await context.close(); }
    }
  });
});
