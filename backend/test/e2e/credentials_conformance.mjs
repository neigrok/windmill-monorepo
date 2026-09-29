#!/usr/bin/env node
// engine.md §9.1 Credentials against a running windmill_server_probe: every case of envelope/credentials.json on hello,
// pull, push and the live socket, first over raw HTTP/1.1 to the origin, then through the production edge, Caddy from
// its image with backend/deploy/Caddyfile, over HTTP/1.1 and HTTP/2. Over HTTP/1.1 each runs on a connection of its own,
// then hello, pull and push all on one keep-alive connection, then all of them pipelined at once. A live socket is
// judged by the `as` of the first frame it answers, a not-found for a tree that does not exist.
//
// Prereqs: a THROWAWAY Postgres holding db/schema.sql and db/probe.sql (this script rewrites its sessions for the
// corpus's tokens), the probe server on it listening on every interface, Docker, curl with HTTP/2, and cmake.
//   DATABASE_URL="postgresql:///$WM_E2E_DB?host=/tmp" PORT=18613 ./build/windmill_server_probe
// Run:  WM_E2E_DB=<database name or postgresql:// URL> PORT=18613 EDGE_PORT=18643 node test/e2e/credentials_conformance.mjs
// EDGE_PORT is where the edge's HTTPS listens on 127.0.0.1; without it the edge runs are skipped and said so.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpusFile = path.resolve(backend, '../packages/api-contract/sync/corpus/envelope/credentials.json');
const caddyfile = path.join(backend, 'deploy/Caddyfile');
const DB = process.env.WM_E2E_DB;
const PORT = Number(process.env.PORT);
const EDGE_PORT = process.env.EDGE_PORT ? Number(process.env.EDGE_PORT) : null;
const SCHEMA = '2';
if (!DB || !PORT) {
  console.error('set WM_E2E_DB to a throwaway database (a name or a postgresql:// URL) and PORT to the probe server\'s port');
  process.exit(2);
}

const corpus = JSON.parse(readFileSync(corpusFile, 'utf8'));
const results = { pass: 0, fail: 0 };
const check = (ok, label, detail) => {
  if (ok) results.pass++;
  else results.fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the corpus's sessions, minted straight into the table ────────────────────────────────────────────────────────────
const psql = (sql) => execFileSync('psql', [DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
const sessions = corpus[0].input.sessions;
for (const vector of corpus) {
  if (JSON.stringify(vector.input.sessions) !== JSON.stringify(sessions)) throw new Error(`${vector.name}: another session table`);
}
const accountOf = {};
for (const alias of new Set(Object.values(sessions))) {
  const email = `credentials-conformance-${alias.toLowerCase()}@example.com`;
  psql(`insert into users (id, email, name) values (gen_random_uuid(), '${email}', '${alias}') on conflict (email) do nothing`);
  accountOf[alias] = psql(`select id from users where email = '${email}'`);
}
const aliasOf = Object.fromEntries(Object.entries(accountOf).map(([alias, id]) => [id, alias]));
for (const [token, alias] of Object.entries(sessions)) {
  const digest = createHash('sha256').update(token).digest('hex');
  psql(`delete from sessions where token_hash = '${digest}'`);
  psql(`insert into sessions (token_hash, user_id, expires_ms) values ('${digest}', '${accountOf[alias]}', ${Date.now() + 3_600_000})`);
}

// ── requests ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A push names the account the vector serves (A when it serves none): one fresh replica per account, and no intents.
const replicaOf = Object.fromEntries(Object.keys(accountOf).map((alias) => [alias, `rp_${randomBytes(16).toString('hex')}`]));
const pushBody = (vector) => {
  const alias = vector.expect.principal.account ?? 'A';
  return JSON.stringify({ replica: replicaOf[alias], account: accountOf[alias], ackThrough: 0, intents: [] });
};
const ENDPOINTS = {
  hello: { method: 'GET', path: '/v1/sync/hello', lines: [['Sync-Schema', SCHEMA]], body: () => '' },
  pull: {
    method: 'POST',
    path: '/v1/sync/pull',
    lines: [['Sync-Schema', SCHEMA], ['Content-Type', 'application/json']],
    body: () => JSON.stringify({ scopes: [{ scope: 'self/probe', cursor: null }] }),
  },
  push: { method: 'POST', path: '/v1/sync/push', lines: [['Sync-Schema', SCHEMA], ['Content-Type', 'application/json']], body: pushBody },
  live: {
    method: 'GET',
    path: `/v1/sync/live?schema=${SCHEMA}`,
    lines: [['Upgrade', 'websocket'], ['Connection', 'Upgrade'], ['Sec-WebSocket-Key', randomBytes(16).toString('base64')], ['Sec-WebSocket-Version', '13']],
    body: () => '',
  },
};
// §9.5: a sub for a tree that does not exist answers not-found, with the socket's `as`.
const NOWHERE = JSON.stringify({ op: 'sub', scopes: ['tree/b_ffffffff'] });

// The bytes of one request: its line, Host, the endpoint's own lines, the vector's lines as the corpus spells them, then
// the body under its Content-Length. `close` asks the server to close after answering.
function requestBytes(endpoint, vector, host, close) {
  const { method, path: target, lines } = ENDPOINTS[endpoint];
  const body = ENDPOINTS[endpoint].body(vector);
  const all = [['Host', host], ...lines, ...vector.input.headers];
  if (body) all.push(['Content-Length', String(Buffer.byteLength(body))]);
  if (close && endpoint !== 'live') all.push(['Connection', 'close']);
  const head = `${method} ${target} HTTP/1.1\r\n${all.map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(body, 'utf8')]);
}

// A client frame (RFC 6455 §5.2): final, text, masked.
function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  const length = payload.length < 126 ? Buffer.from([0x80 | payload.length]) : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([Buffer.from([0x81]), length, mask, Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))]);
}

// One HTTP/1.1 connection, read one response, or after a 101 one WebSocket frame, at a time.
class Connection {
  static open(edge) {
    return new Promise((resolve, reject) => {
      const socket = edge
        ? tls.connect({ host: '127.0.0.1', port: EDGE_PORT, servername: 'localhost', ALPNProtocols: ['http/1.1'], rejectUnauthorized: false }, () =>
            resolve(new Connection(socket)))
        : net.connect({ host: '127.0.0.1', port: PORT }, () => resolve(new Connection(socket)));
      socket.once('error', reject);
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.waiting = null;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    socket.on('close', () => {
      this.closed = true;
      this.pump();
    });
    socket.on('error', () => {});
  }

  write(bytes) {
    this.socket.write(bytes);
  }

  // The next response: its status, its body, and whether it closed the connection without framing its body.
  response() {
    return this.next(parseResponse);
  }

  // The next WebSocket frame's text, or null when the connection closes first.
  frame() {
    return this.next(parseFrame);
  }

  next(parse) {
    return new Promise((resolve) => {
      this.waiting = { parse, resolve };
      this.pump();
    });
  }

  pump() {
    if (!this.waiting) return;
    const parsed = this.waiting.parse(this.buffer, this.closed);
    if (!parsed && !this.closed) return;
    const { resolve } = this.waiting;
    this.waiting = null;
    if (!parsed) return resolve(null);
    this.buffer = this.buffer.subarray(parsed.length);
    resolve(parsed.value);
  }

  close() {
    this.socket.destroy();
  }
}

function parseResponse(buffer, closed) {
  const headEnd = buffer.indexOf('\r\n\r\n');
  if (headEnd === -1) return null;
  const head = buffer.subarray(0, headEnd).toString('latin1').split('\r\n');
  const status = Number(head[0].split(' ')[1]);
  const fields = Object.fromEntries(head.slice(1).map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
  let at = headEnd + 4;
  if (status === 101) return { value: { status, body: '' }, length: at };
  if (fields['transfer-encoding'] === 'chunked') {
    const chunks = [];
    while (true) {
      const lineEnd = buffer.indexOf('\r\n', at);
      if (lineEnd === -1) return null;
      const size = parseInt(buffer.subarray(at, lineEnd).toString('latin1'), 16);
      if (buffer.length < lineEnd + 2 + size + 2) return null;
      chunks.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
      at = lineEnd + 2 + size + 2;
      if (size === 0) return { value: { status, body: Buffer.concat(chunks).toString('utf8') }, length: at };
    }
  }
  // A body framed by neither runs to the close, as an edge's bare refusal may.
  if (fields['content-length'] === undefined) {
    if (!closed) return null;
    return { value: { status, body: buffer.subarray(at).toString('utf8') }, length: buffer.length };
  }
  const length = Number(fields['content-length']);
  if (buffer.length < at + length) return null;
  return { value: { status, body: buffer.subarray(at, at + length).toString('utf8') }, length: at + length };
}

// A server frame (unmasked); a frame that is not text answers as its opcode.
function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 0x7f;
  let at = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    at = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    at = 10;
  }
  if (buffer.length < at + length) return null;
  const opcode = buffer[0] & 0x0f;
  return { value: opcode === 1 ? buffer.subarray(at, at + length).toString('utf8') : `opcode ${opcode}`, length: at + length };
}

// The server limits each client the edge names to ~25 requests a second, bursts of 50 (main.cpp), and every request
// through the edge is one client's: they go out at most 20 a second, and a burst of at most 40 waits for a full bucket.
let lastEdgeRequest = 0;
async function pace(edge) {
  if (!edge) return;
  await sleep(Math.max(0, lastEdgeRequest + 50 - Date.now()));
  lastEdgeRequest = Date.now();
}
const fullBucket = (edge) => (edge ? sleep(2500) : Promise.resolve());

// ── judging ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// What the corpus expects of `endpoint`: `401`, or `as:` the alias the answer names (`as:null` for anonymous). A push
// with no credential answers 401 too; a live socket's `as` is on its frames.
function expected(vector, endpoint) {
  const { account, credential } = vector.expect.principal;
  if (credential === 'unresolved') return '401';
  if (endpoint === 'push' && account === null) return '401';
  return `as:${account}`;
}

const aliasNamed = (as) => (as === null ? 'null' : aliasOf[as] ?? `unknown ${as}`);
const envelopeOf = (body) => {
  try {
    const json = JSON.parse(body);
    return json && typeof json === 'object' && 'serverTime' in json && 'epoch' in json ? json : null;
  } catch {
    return null;
  }
};

// What an answer says the request was served as, in expected()'s terms; `refused …` for anything else, `bare` when it
// carries no engine envelope.
async function served(endpoint, answer, connection) {
  if (answer === null) return 'refused: closed with no answer';
  const envelope = envelopeOf(answer.body);
  if (answer.status === 401 && envelope?.error === 'unauthenticated' && envelope.as === null) return '401';
  if (endpoint === 'live' && answer.status === 101) {
    connection.write(textFrame(NOWHERE));
    const text = await connection.frame();
    try {
      const frame = JSON.parse(text);
      if (frame.op === 'not-found' && 'as' in frame) return `as:${aliasNamed(frame.as)}`;
    } catch {}
    return `refused: 101 then ${text}`;
  }
  if (endpoint !== 'live' && (answer.status === 200 || answer.status === 409) && envelope && 'as' in envelope) return `as:${aliasNamed(envelope.as)}`;
  return `refused ${answer.status}${envelope ? '' : ' bare'}`;
}

// §9.1: the transport and the edge MAY refuse a request that is not valid HTTP, with a bare 400 or on HTTP/2 by
// resetting its stream: here a field name that is not a token (RFC 9110 §5.1), and over HTTP/2 a field value that
// starts or ends with space or tab (RFC 9113 §8.2.1), which HTTP/1.1 keeps outside the value (RFC 9112 §5).
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function mayRefuse(vector, http2) {
  if (vector.input.headers.some(([name]) => !TOKEN.test(name))) return 'a field name that is not a token';
  if (http2 && vector.input.headers.some(([, value]) => /^[ \t]|[ \t]$/.test(value))) return 'a field value that starts or ends with space or tab';
  return null;
}

function judge(label, vector, endpoint, got, http2) {
  const want = expected(vector, endpoint);
  const allowed = mayRefuse(vector, http2);
  if (allowed && (got === 'refused 400 bare' || got === 'reset')) return check(true, `${label} (refused as ${allowed}: ${got})`);
  check(got === want, label, `want ${want} got ${got}`);
}

// ── HTTP/1.1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
async function exchange(connection, endpoint, vector, host, close) {
  connection.write(requestBytes(endpoint, vector, host, close));
  const answer = await connection.response();
  return served(endpoint, answer, connection);
}

async function runHttp1(edge) {
  const where = edge ? 'edge h1' : 'origin h1';
  const host = edge ? 'localhost' : `127.0.0.1:${PORT}`;
  for (const endpoint of Object.keys(ENDPOINTS)) {
    for (const vector of corpus) {
      await pace(edge);
      const connection = await Connection.open(edge);
      judge(`${where} ${endpoint}: ${vector.name}`, vector, endpoint, await exchange(connection, endpoint, vector, host, true), false);
      connection.close();
    }
  }
  // A refused request closes its connection, so the shared ones carry only what the transport must read.
  const sequence = corpus
    .filter((vector) => !mayRefuse(vector, false))
    .flatMap((vector) => ['hello', 'pull', 'push'].map((endpoint) => ({ vector, endpoint })));
  const kept = await Connection.open(edge);
  for (const { vector, endpoint } of sequence) {
    await pace(edge);
    judge(`${where} keep-alive ${endpoint}: ${vector.name}`, vector, endpoint, await exchange(kept, endpoint, vector, host, false), false);
  }
  kept.close();
  const burstSize = edge ? 40 : sequence.length;
  for (let start = 0; start < sequence.length; start += burstSize) {
    await fullBucket(edge);
    const burst = sequence.slice(start, start + burstSize);
    const pipelined = await Connection.open(edge);
    pipelined.write(Buffer.concat(burst.map(({ vector, endpoint }) => requestBytes(endpoint, vector, host, false))));
    for (const { vector, endpoint } of burst) {
      judge(`${where} pipelined ${endpoint}: ${vector.name}`, vector, endpoint, await served(endpoint, await pipelined.response(), pipelined), false);
    }
    pipelined.close();
  }
}

// ── HTTP/2 through the edge ──────────────────────────────────────────────────────────────────────────────────────────
// RFC 9113 §8.2.3: an HTTP/2 client may split Cookie into several fields, which the edge joins into one line. The
// session cookie in one crumb serves its account; one in each of two crumbs is two session cookies.
const CRUMBS = [
  {
    name: 'crumbled cookies: the session cookie in one crumb among others serves its account',
    input: { headers: [['Cookie', 'theme=dark'], ['Cookie', 'wm_session=s-ann'], ['Cookie', 'lang=en']] },
    expect: { principal: { account: 'A' } },
  },
  {
    name: 'crumbled cookies: session cookies in two crumbs do not resolve',
    input: { headers: [['Cookie', 'wm_session=s-ann'], ['Cookie', 'lang=en'], ['Cookie', 'wm_session=s-bob']] },
    expect: { principal: { account: null, credential: 'unresolved' } },
  },
];

// hello, pull and push by curl, which sends every -H line as a field of its own, repeats and all. A request the edge
// resets never reaches the origin; curl reports it as no status.
async function runHttp2() {
  for (const endpoint of ['hello', 'pull', 'push']) {
    for (const vector of [...corpus, ...CRUMBS]) {
      await pace(true);
      const { method, path: target, lines } = ENDPOINTS[endpoint];
      const body = ENDPOINTS[endpoint].body(vector);
      const args = ['-sk', '--http2', '-X', method, '-o', '-', '-w', '\n%{http_code} %{http_version}', `https://localhost:${EDGE_PORT}${target}`,
        '--resolve', `localhost:${EDGE_PORT}:127.0.0.1`];
      for (const [name, value] of [...lines, ...vector.input.headers]) args.push('-H', `${name}: ${value}`);
      if (body) args.push('--data-binary', body);
      const run = spawnSync('curl', args, { encoding: 'utf8' });
      const [answerBody, trailer] = [run.stdout.slice(0, run.stdout.lastIndexOf('\n')), run.stdout.slice(run.stdout.lastIndexOf('\n') + 1)];
      const [status, version] = trailer.split(' ');
      const label = `edge h2 ${endpoint}: ${vector.name}`;
      if (run.status !== 0 || status === '000') {
        judge(label, vector, endpoint, 'reset', true);
        continue;
      }
      if (version !== '2') {
        check(false, label, `answered over HTTP/${version}`);
        continue;
      }
      judge(label, vector, endpoint, await served(endpoint, { status: Number(status), body: answerBody }, null), true);
    }
  }
}

// The live socket over HTTP/2 is an extended CONNECT (RFC 8441), which a client may send only where the edge's SETTINGS
// offer it. Where they do not, every client opens the socket over HTTP/1.1, which runHttp1 covers; said here, not
// skipped. Where they do, this harness has no HTTP/2 socket client yet, and fails until it has one.
async function liveOverHttp2() {
  const offered = await new Promise((resolve, reject) => {
    const session = http2.connect(`https://localhost:${EDGE_PORT}`, { rejectUnauthorized: false });
    session.on('error', reject);
    session.on('remoteSettings', (settings) => {
      resolve(settings.enableConnectProtocol === true);
      session.close();
    });
  });
  if (!offered) {
    console.log('  note edge h2 live: the edge offers no extended CONNECT (RFC 8441 SETTINGS_ENABLE_CONNECT_PROTOCOL is off), so every');
    console.log('       client opens the live socket over HTTP/1.1, which the edge h1 live cases above cover');
    return;
  }
  check(false, 'edge h2 live', 'the edge offers extended CONNECT (RFC 8441): open the live socket over HTTP/2 here too');
}

// ── the edge: the production Caddyfile, its upstream pointed at the probe server ────────────────────────────────────
function startEdge() {
  execFileSync('cmake', [`-DCADDYFILE=${caddyfile}`, '-P', path.join(backend, 'test/deploy/caddyfile_forwards_credentials.cmake')], { stdio: 'inherit' });
  const production = readFileSync(caddyfile, 'utf8');
  const upstreams = production.match(/reverse_proxy server:8080/g) ?? [];
  if (upstreams.length !== 2) throw new Error(`expected the Caddyfile's two reverse_proxy server:8080 lines, found ${upstreams.length}`);
  const dir = mkdtempSync(path.join(tmpdir(), 'wm-edge-'));
  writeFileSync(path.join(dir, 'Caddyfile'), production.replaceAll('reverse_proxy server:8080', `reverse_proxy host.docker.internal:${PORT}`));
  const name = `wm-credentials-edge-${EDGE_PORT}`;
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  execFileSync('docker', ['run', '-d', '--name', name, '--add-host', 'host.docker.internal:host-gateway', '-p', `127.0.0.1:${EDGE_PORT}:443`,
    '-e', 'DOMAIN_APP=localhost', '-e', 'DOMAIN_API=api.localhost', '-e', 'ACME_EMAIL=conformance@example.com', '-e', 'CF_IPS=0.0.0.0/0 ::/0',
    '-v', `${path.join(dir, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, 'caddy:2'], { stdio: 'ignore' });
  console.log(`  ${execFileSync('docker', ['exec', name, 'caddy', 'version'], { encoding: 'utf8' }).trim().split(' ')[0]} in ${name}`);
  return () => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  };
}

async function edgeAnswers() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = spawnSync('curl', ['-sk', '-o', '/dev/null', '-w', '%{http_code}', '-H', `Sync-Schema: ${SCHEMA}`, '--resolve', `localhost:${EDGE_PORT}:127.0.0.1`,
      `https://localhost:${EDGE_PORT}/v1/sync/hello`], { encoding: 'utf8' });
    if (run.stdout === '200') return;
    await sleep(200);
  }
  throw new Error('the edge never answered a hello');
}

console.log(`origin: 127.0.0.1:${PORT}, ${corpus.length} vectors`);
await runHttp1(false);
if (EDGE_PORT) {
  console.log(`edge: the production Caddyfile on 127.0.0.1:${EDGE_PORT}`);
  const stopEdge = startEdge();
  try {
    await edgeAnswers();
    await runHttp1(true);
    await fullBucket(true);
    await runHttp2();
    await liveOverHttp2();
  } finally {
    stopEdge();
  }
} else {
  console.log('edge: skipped, EDGE_PORT unset');
}
console.log(`\n${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail === 0 ? 0 : 1);
