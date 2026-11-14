import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { serveBuilt } from '../../scripts/serve-built.mjs';

async function fixture(t, { handler = (request, response) => response.end('upstream'), upgrade, durationSeconds = 60 } = {}) {
  const scratch = fileURLToPath(new URL('../../../.claude/scratch/built-verifier/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'case-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'dist');
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'roadmap'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Built app</title>');
  await writeFile(join(root, 'roadmap/index.html'), '<!doctype html><title>Roadmap</title>');
  await writeFile(join(root, 'gallery.html'), '<!doctype html><title>Gallery</title>');
  await writeFile(join(root, 'assets/app.js'), 'export const built = true;\n');
  await writeFile(join(root, 'assets/app.wasm'), Buffer.from([0, 97, 115, 109]));
  const upstream = http.createServer(handler);
  const connections = new Set();
  upstream.on('connection', (socket) => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
  });
  if (upgrade) upstream.on('upgrade', upgrade);
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  t.after(async () => {
    const closed = new Promise((done) => upstream.close(done));
    for (const socket of connections) socket.destroy();
    await closed;
  });
  const backend = `http://127.0.0.1:${upstream.address().port}`;
  const instance = await serveBuilt({ root, backend, port: 0, durationSeconds });
  t.after(instance.close);
  return { ...instance, root, backend, upstream, connections, directory, port: instance.server.address().port };
}

function request(port, path, { method = 'GET', headers = {}, body = '', agent = false } = {}) {
  return new Promise((done, reject) => {
    const client = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    client.on('error', reject);
    client.setTimeout(2000, () => client.destroy(new Error('request timed out')));
    client.end(body);
  });
}

function socketRequest(t, port, { path = '/v1/session', frame = Buffer.alloc(0), bytes = 0 } = {}) {
  return new Promise((done, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    t.after(() => socket.destroy());
    socket.setTimeout(2000, () => socket.destroy(new Error('socket timed out')));
    socket.on('error', reject);
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      const boundary = data.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const [statusLine, ...lines] = data.subarray(0, boundary).toString().split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      const body = data.subarray(boundary + 4);
      if (status === 101 && body.length < bytes) return;
      socket.setTimeout(0);
      done({ socket, status, headers: Object.fromEntries(lines.map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      })), body });
    });
    socket.once('connect', () => socket.write(Buffer.concat([
      Buffer.from(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade, x-hop\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: windmill\r\nCookie: session=synthetic\r\nX-Hop: discarded\r\n\r\n`),
      frame,
    ])));
  });
}

test('serves built files, directory landings and only known SPA paths, including HEAD', { timeout: 5000 }, async (t) => {
  const site = await fixture(t);
  for (const path of ['/', '/index.html', '/app', '/app/roadmap', '/app/journal/2026-11-14', '/t/t_shared']) {
    const response = await request(site.port, path);
    assert.equal(response.status, 200, path);
    assert.equal(response.body.toString(), '<!doctype html><title>Built app</title>');
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  }
  for (const path of ['/roadmap', '/roadmap/']) {
    assert.equal((await request(site.port, path)).body.toString(), '<!doctype html><title>Roadmap</title>');
  }
  assert.equal((await request(site.port, '/gallery')).body.toString(), '<!doctype html><title>Gallery</title>');
  const script = await request(site.port, '/assets/app.js?revision=one');
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(script.body.toString(), 'export const built = true;\n');
  const head = await request(site.port, '/assets/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-type'], script.headers['content-type']);
  assert.equal(head.headers['content-length'], script.headers['content-length']);
  assert.equal(head.body.length, 0);
  const wasm = await request(site.port, '/assets/app.wasm');
  assert.equal(wasm.headers['content-type'], 'application/wasm');
  assert.deepEqual(wasm.body, Buffer.from([0, 97, 115, 109]));
  for (const path of ['/missing', '/assets/missing.js', '/app/missing.js', '/v10', '/mcpx', '/t/id/extra']) {
    const response = await request(site.port, path);
    assert.equal(response.status, 404, path);
    assert.equal(response.body.length, 0);
  }
  const post = await request(site.port, '/', { method: 'POST', body: 'synthetic' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('rejects traversal, malformed escapes and symlinks outside the built root', { timeout: 5000 }, async (t) => {
  const site = await fixture(t);
  await writeFile(join(site.directory, 'outside.txt'), 'must stay outside');
  await symlink(join(site.directory, 'outside.txt'), join(site.root, 'outside.txt'));
  await symlink(site.directory, join(site.root, 'outside-directory'));
  for (const path of ['/../outside.txt', '/%2e%2e/outside.txt', '/assets/%2e%2e/%2e%2e/outside.txt', '/%00', '/%zz', '/..%5coutside.txt', '//outside.txt']) {
    const response = await request(site.port, path);
    assert.equal(response.status, 400, path);
    assert.equal(response.body.length, 0);
  }
  for (const path of ['/outside.txt', '/outside-directory/outside.txt']) {
    const response = await request(site.port, path);
    assert.equal(response.status, 403, path);
    assert.equal(response.body.length, 0);
  }
});

test('HTTP proxy preserves method, query, body, status and end-to-end headers', { timeout: 5000 }, async (t) => {
  const received = [];
  const site = await fixture(t, { handler: async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    received.push({ method: incoming.method, url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString() });
    response.writeHead(207, {
      'content-type': 'application/json', 'set-cookie': ['first=one; HttpOnly', 'second=two; HttpOnly'],
      connection: 'keep-alive, x-upstream-hop', 'x-upstream-hop': 'discarded', 'x-result': 'preserved',
    });
    response.end('{"accepted":true}');
  } });
  for (const path of ['/v1?exact=yes', '/v1/events?key=a%2Fb&key=c', '/mcp', '/mcp/session', '/oauth', '/oauth/token']) {
    const response = await request(site.port, path, {
      method: 'POST', body: '{"synthetic":true}',
      headers: { authorization: 'Bearer synthetic', cookie: 'session=synthetic', 'content-type': 'application/json',
        connection: 'keep-alive, x-client-hop', 'x-client-hop': 'discarded', 'proxy-authorization': 'discarded', 'x-client': 'preserved' },
    });
    assert.equal(response.status, 207);
    assert.equal(response.body.toString(), '{"accepted":true}');
    assert.deepEqual(response.headers['set-cookie'], ['first=one; HttpOnly', 'second=two; HttpOnly']);
    assert.equal(response.headers['x-result'], 'preserved');
    assert.equal(response.headers['x-upstream-hop'], undefined);
    const actual = received.at(-1);
    assert.equal(actual.method, 'POST');
    assert.equal(actual.url, path);
    assert.equal(actual.body, '{"synthetic":true}');
    assert.equal(actual.headers.host, new URL(site.backend).host);
    assert.equal(actual.headers.authorization, 'Bearer synthetic');
    assert.equal(actual.headers.cookie, 'session=synthetic');
    assert.equal(actual.headers['x-client'], 'preserved');
    assert.equal(actual.headers['x-client-hop'], undefined);
    assert.equal(actual.headers['proxy-authorization'], undefined);
  }
});

test('an HTTP request followed by an upgrade uses a fresh connection and carries frames both ways', { timeout: 5000 }, async (t) => {
  const ordinarySockets = new Set();
  const frames = [];
  const clientFrame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x68 ^ 1, 0x69 ^ 2]);
  const serverFrames = Buffer.from([0x81, 5, ...Buffer.from('ready'), 0x81, 2, ...Buffer.from('hi')]);
  let handshake;
  const site = await fixture(t, {
    handler(incoming, response) {
      ordinarySockets.add(incoming.socket);
      response.end('ordinary response');
    },
    upgrade(incoming, socket, head) {
      if (ordinarySockets.has(socket)) {
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      handshake = { url: incoming.url, headers: incoming.headers };
      socket.write(Buffer.concat([
        Buffer.from('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\nSec-WebSocket-Protocol: windmill\r\n\r\n'),
        serverFrames.subarray(0, 7),
      ]));
      const receive = (data) => {
        frames.push(data);
        if (Buffer.concat(frames).length % clientFrame.length === 0) socket.write(serverFrames.subarray(7));
      };
      if (head.length) receive(head);
      socket.on('data', receive);
    },
  });
  assert.equal((await request(site.port, '/v1/me')).body.toString(), 'ordinary response');
  const result = await socketRequest(t, site.port, { path: '/v1/session?cursor=a%2Fb', frame: clientFrame, bytes: serverFrames.length });
  assert.equal(result.status, 101);
  assert.deepEqual(result.headers, {
    'sec-websocket-accept': 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'sec-websocket-protocol': 'windmill',
    connection: 'Upgrade', upgrade: 'websocket',
  });
  assert.deepEqual(result.body, serverFrames);
  assert.deepEqual(Buffer.concat(frames), clientFrame);
  const secondFrame = once(result.socket, 'data');
  result.socket.write(clientFrame);
  assert.deepEqual(await secondFrame, [serverFrames.subarray(7)]);
  assert.deepEqual(Buffer.concat(frames), Buffer.concat([clientFrame, clientFrame]));
  assert.equal(handshake.url, '/v1/session?cursor=a%2Fb');
  assert.equal(handshake.headers.cookie, 'session=synthetic');
  assert.equal(handshake.headers['sec-websocket-protocol'], 'windmill');
  assert.equal(handshake.headers['x-hop'], undefined);
  assert.equal(site.connections.size, 2);
  const closed = once(result.socket, 'close');
  await site.close();
  await closed;
  assert.equal(site.server.listening, false);
});

test('rejected upgrades return only their status and failed upstreams return 502', { timeout: 5000 }, async (t) => {
  const site = await fixture(t, { upgrade(incoming, socket) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 16\r\nX-Secret: synthetic-secret\r\nConnection: close\r\n\r\nsynthetic-secret');
  } });
  const rejected = await socketRequest(t, site.port);
  assert.equal(rejected.status, 401);
  assert.deepEqual(rejected.headers, { connection: 'close', 'content-length': '0' });
  assert.equal(rejected.body.length, 0);
  const unknown = await socketRequest(t, site.port, { path: '/assets/app.js' });
  assert.equal(unknown.status, 404);
  await new Promise((done) => site.upstream.close(done));
  const failedHttp = await request(site.port, '/v1/me');
  assert.equal(failedHttp.status, 502);
  assert.equal(failedHttp.body.length, 0);
  const failedSocket = await socketRequest(t, site.port);
  assert.equal(failedSocket.status, 502);
  assert.deepEqual(failedSocket.headers, { connection: 'close', 'content-length': '0' });
  assert.equal(failedSocket.body.length, 0);
});

test('disconnects cancel upstream HTTP work', { timeout: 5000 }, async (t) => {
  let started;
  let finished;
  const start = new Promise((done) => { started = done; });
  const finish = new Promise((done) => { finished = done; });
  const site = await fixture(t, { handler(incoming, response) {
    response.once('close', finished);
    started();
  } });
  const client = http.get({ hostname: '127.0.0.1', port: site.port, path: '/v1/slow' });
  client.on('error', () => {});
  t.after(() => client.destroy());
  await start;
  client.destroy();
  await finish;
});

test('disconnecting an upgraded client closes its upstream peer', { timeout: 5000 }, async (t) => {
  let disconnected;
  const closed = new Promise((done) => { disconnected = done; });
  const site = await fixture(t, { upgrade(incoming, socket) {
    socket.once('end', () => socket.end());
    socket.once('close', disconnected);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  } });
  const result = await socketRequest(t, site.port);
  result.socket.destroy();
  await closed;
  assert.equal(site.connections.size, 0);
});

test('duration ends the listener and active upgrade connections', { timeout: 5000 }, async (t) => {
  const site = await fixture(t, { durationSeconds: 1, handler() {}, upgrade(incoming, socket) {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  } });
  const httpClient = http.get({ hostname: '127.0.0.1', port: site.port, path: '/v1/slow' });
  t.after(() => httpClient.destroy());
  const httpClosed = once(httpClient, 'error');
  const result = await socketRequest(t, site.port);
  await once(result.socket, 'close');
  assert.equal((await httpClosed)[0].code, 'ECONNRESET');
  assert.equal(site.server.listening, false);
  await assert.rejects(request(site.port, '/'), { code: 'ECONNREFUSED' });
});

test('CLI binds loopback, prints build identity only and exits on SIGTERM with open sockets', { timeout: 5000 }, async (t) => {
  const site = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/serve-built.mjs', import.meta.url)),
    '--root', site.root, '--port', '0', '--backend', site.backend, '--duration', '60'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const ready = await new Promise((done, reject) => {
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) done(JSON.parse(output));
    });
  });
  assert.deepEqual(Object.keys(ready), ['event', 'port', 'root', 'indexSha256']);
  assert.equal(ready.event, 'ready');
  assert.equal(ready.root, site.root);
  assert.equal(ready.indexSha256, site.indexSha256);
  const socket = net.connect(ready.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  assert.equal(socket.remoteAddress, '127.0.0.1');
  await request(ready.port, '/v1/me?private=synthetic-secret', { headers: { authorization: 'Bearer synthetic-secret' } });
  const closed = once(socket, 'close');
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  assert.deepEqual(await exit, [0, null]);
  await closed;
  assert.equal(output, `${JSON.stringify(ready)}\n`);
  assert.equal(errors, '');
});

test('startup rejects non-origins, credentials and unbounded or invalid options', { timeout: 5000 }, async (t) => {
  const site = await fixture(t);
  for (const backend of ['file:///tmp', 'http://user:secret@127.0.0.1', `${site.backend}/path`, `${site.backend}?secret=value`, `${site.backend}#fragment`]) {
    await assert.rejects(serveBuilt({ root: site.root, port: 0, backend }));
  }
  for (const options of [{ port: -1 }, { port: 65536 }, { durationSeconds: 0 }, { durationSeconds: Infinity }, { durationSeconds: 2147484 }]) {
    await assert.rejects(serveBuilt({ root: site.root, port: 0, backend: site.backend, ...options }));
  }
  await assert.rejects(serveBuilt({ root: join(site.directory, 'missing'), port: 0, backend: site.backend }));
});
