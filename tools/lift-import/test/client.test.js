import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { GymClient, GymRefusal } from '../client.js';

const WORKOUT = {
  id: 'ses_example', startedAt: 7, finishedAt: 9,
  sets: [{ id: 'set_example', exerciseId: 'bench-press', weightKg: 82.5, reps: 8, completedAt: 8 }],
};
const STORED = { session: { id: WORKOUT.id, startedAt: 7, finishedAt: 9 }, sets: WORKOUT.sets };

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function clientOver(replies) {
  const calls = [];
  const sleeps = [];
  const client = new GymClient({
    baseUrl: 'http://localhost:8080/', token: 'secret', backoffMs: 1,
    sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    },
  });
  return { client, calls, sleeps };
}

async function localClient(t, handler, options = {}) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return new GymClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'secret',
    timeoutMs: 250, backoffMs: 0, ...options,
  });
}

describe('the conversation', () => {
  it('sends one complete workout to the import door and preserves its 201 status', async () => {
    const { client, calls } = clientOver([reply(201, STORED)]);
    deepStrictEqual(await client.importSession(WORKOUT), { status: 201, body: STORED });
    strictEqual(calls.length, 1);
    strictEqual(calls[0].url, 'http://localhost:8080/v1/gym/sessions/import');
    strictEqual(calls[0].method, 'POST');
    deepStrictEqual(calls[0].headers, {
      'content-type': 'application/json', authorization: 'Bearer secret', cookie: 'wm_session=secret',
    });
    strictEqual(calls[0].body, JSON.stringify(WORKOUT));
  });

  it('preserves the 200 status of an exact replay', async () => {
    const { client } = clientOver([reply(200, STORED)]);
    deepStrictEqual(await client.importSession(WORKOUT), { status: 200, body: STORED });
  });

  it('reads and unwraps only the exercise catalogue', async () => {
    const { client, calls } = clientOver([reply(200, { exercises: [{ id: 'dip', name: 'Dip' }] })]);
    deepStrictEqual(await client.exercises(), [{ id: 'dip', name: 'Dip' }]);
    strictEqual(calls[0].url, 'http://localhost:8080/v1/gym/exercises');
    strictEqual(calls[0].method, 'GET');
    strictEqual(calls[0].body, undefined);
  });

  it('refuses a success reply that cannot confirm the requested workout', async () => {
    for (const response of [reply(200, {}), reply(200, { ...STORED, session: { id: 'ses_other' } }), reply(202, STORED)]) {
      const { client } = clientOver([response]);
      await rejects(client.importSession(WORKOUT), /requested workout/);
    }
  });
});

describe('the retry rule', () => {
  it('treats all 4xx refusals as terminal and keeps the machine code and sentence', async () => {
    for (const status of [400, 401, 403, 404, 409, 429]) {
      const { client, calls, sleeps } = clientOver([reply(status, { error: 'no such exercise', code: 'unknown-exercise' })]);
      await rejects(client.importSession(WORKOUT), (error) => {
        strictEqual(error instanceof GymRefusal, true);
        strictEqual(error.status, status);
        strictEqual(error.code, 'unknown-exercise');
        strictEqual(error.sentence, 'no such exercise');
        return true;
      });
      strictEqual(calls.length, 1);
      deepStrictEqual(sleeps, []);
    }
  });

  it('reports the finished session responsible for an overlap', async () => {
    const { client } = clientOver([reply(409, {
      error: 'these times cross a session already in the log', code: 'session-overlap', sessionId: 'ses_existing',
    })]);
    await rejects(client.importSession(WORKOUT), /409 session-overlap: .*ses_existing/);
  });

  it('retries 5xx with the original serialized body and no delay after success', async () => {
    const workout = structuredClone(WORKOUT);
    const { client, calls, sleeps } = clientOver([
      () => { workout.sets[0].reps = 50; return reply(500, { error: 'internal error' }); },
      reply(503, { error: 'unavailable' }), reply(201, STORED),
    ]);
    deepStrictEqual(await client.importSession(workout), { status: 201, body: STORED });
    deepStrictEqual(calls.map((call) => call.body), Array(3).fill(JSON.stringify(WORKOUT)));
    deepStrictEqual(sleeps, [1, 2]);
  });

  it('retries a dropped connection with the same body', async () => {
    const { client, calls } = clientOver([new Error('ECONNREFUSED'), reply(200, STORED)]);
    deepStrictEqual(await client.importSession(WORKOUT), { status: 200, body: STORED });
    deepStrictEqual(calls.map((call) => call.body), Array(2).fill(JSON.stringify(WORKOUT)));
  });

  it('retries a failed body read and malformed success json', async () => {
    const { client, calls } = clientOver([
      { ok: true, status: 201, text: async () => { throw new Error('socket reset during body'); } },
      { ok: true, status: 200, text: async () => '{' }, reply(200, STORED),
    ]);
    deepStrictEqual(await client.importSession(WORKOUT), { status: 200, body: STORED });
    strictEqual(calls.length, 3);
  });

  it('gives up at four attempts without a final backoff', async () => {
    const { client, calls, sleeps } = clientOver(Array.from({ length: 4 }, () => reply(500, { error: 'internal error' })));
    await rejects(client.importSession(WORKOUT), GymRefusal);
    strictEqual(calls.length, 4);
    deepStrictEqual(sleeps, [1, 2, 3]);
  });

  it('gives up after repeated connection failures', async () => {
    const { client, calls } = clientOver(Array.from({ length: 4 }, () => new Error('ECONNREFUSED')));
    await rejects(client.importSession(WORKOUT), /ECONNREFUSED/);
    strictEqual(calls.length, 4);
  });
});

describe('real HTTP failures', () => {
  for (const stalled of ['headers', 'body']) {
    it(`aborts stalled ${stalled}, retries identical bytes, and closes the request`, async (t) => {
      const bodies = [];
      let closed = false;
      const client = await localClient(t, (req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          bodies.push(body);
          if (bodies.length === 1) {
            res.on('close', () => { closed = true; });
            if (stalled === 'body') {
              res.writeHead(201, { 'content-type': 'application/json' });
              res.write('{"session":');
            }
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(STORED));
        });
      });
      deepStrictEqual(await client.importSession(WORKOUT), { status: 200, body: STORED });
      deepStrictEqual(bodies, Array(2).fill(JSON.stringify(WORKOUT)));
      strictEqual(closed, true);
    });
  }

  it('exhausts a stalled response deadline and releases all sockets', async (t) => {
    let calls = 0;
    let closed = 0;
    const client = await localClient(t, (req, res) => {
      calls += 1;
      req.resume();
      res.on('close', () => { closed += 1; });
    }, { attempts: 2 });
    await rejects(client.importSession(WORKOUT), /timed out/);
    // Give the server the abort notification before asserting its connection count.
    await new Promise((resolve) => setTimeout(resolve, 10));
    strictEqual(calls, 2);
    strictEqual(closed, 2);
  });

  it('keeps a 4xx terminal even when its refusal body stalls', async (t) => {
    let calls = 0;
    const client = await localClient(t, (req, res) => {
      calls += 1;
      req.resume();
      res.writeHead(409, { 'content-type': 'application/json' });
      res.write('{');
    });
    await rejects(client.importSession(WORKOUT), (error) => {
      strictEqual(error instanceof GymRefusal, true);
      strictEqual(error.status, 409);
      strictEqual(error.sentence, 'could not read the refusal reply');
      return true;
    });
    strictEqual(calls, 1);
  });

  it('retries a server crash during the response after the complete body arrived', async (t) => {
    const bodies = [];
    const client = await localClient(t, (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        bodies.push(body);
        if (bodies.length === 1) {
          res.writeHead(201, { 'content-type': 'application/json' });
          res.write('{');
          res.socket.destroy();
          return;
        }
        res.end(JSON.stringify(STORED));
      });
    });
    deepStrictEqual(await client.importSession(WORKOUT), { status: 200, body: STORED });
    deepStrictEqual(bodies, Array(2).fill(JSON.stringify(WORKOUT)));
  });

  it('does not follow a redirect to another route', async (t) => {
    const paths = [];
    const client = await localClient(t, (req, res) => {
      paths.push(req.url);
      req.resume();
      res.writeHead(307, { location: '/retired' });
      res.end();
    }, { attempts: 1 });
    await rejects(client.importSession(WORKOUT));
    deepStrictEqual(paths, ['/v1/gym/sessions/import']);
  });
});
