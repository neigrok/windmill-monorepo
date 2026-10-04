import { deepStrictEqual, doesNotMatch, match, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { GymClient } from '../client.js';
import { writeCorpus } from '../import.js';

const COMMAND = fileURLToPath(new URL('../import.js', import.meta.url));
const CATALOG = [
  ['bench-press', 'Bench Press'], ['pull-up', 'Pull Up'], ['back-squat', 'Back Squat'],
  ['romanian-deadlift', 'Romanian Deadlift'], ['overhead-press', 'Overhead Press'],
  ['barbell-row', 'Barbell Row'], ['deadlift', 'Deadlift'], ['farmers-carry', 'Farmers Carry'],
].map(([id, name]) => ({ id, name }));
const RAW = {
  id: 'a'.repeat(32), name: 'First workout', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_600_000,
  sets: [{ id: 'b'.repeat(32), exerciseName: 'Bench Press', weight: 82.5, reps: 8, completedAt: 1_700_000_300_000 }],
};

async function commandOver(t, sessions, handler, slowOutput = false) {
  const dir = await mkdtemp(join(tmpdir(), 'lift-import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const exportPath = join(dir, 'export.json');
  const mappingPath = join(dir, 'mapping.json');
  await writeFile(exportPath, JSON.stringify({ app: 'lift', version: 1, sessions }));
  const calls = [];
  let outputReady;
  const imported = new Promise((resolve) => { outputReady = resolve; });
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: req.url, body });
    if (req.url === '/v1/gym/exercises' && req.method === 'GET') {
      res.end(JSON.stringify({ exercises: CATALOG }));
      return;
    }
    handler(req, res, body);
    outputReady();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const child = spawn(process.execPath, [COMMAND, '--export', exportPath, '--mapping', mappingPath,
    '--base-url', `http://127.0.0.1:${server.address().port}`, '--token', 'secret'], {
    env: { ...process.env, WINDMILL_TOKEN: '', WINDMILL_BASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '';
  let stderr = '';
  const exited = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill(); reject(new Error('CLI did not exit')); }, 10_000);
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', (status) => { clearTimeout(deadline); resolve(status); });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (slowOutput) {
    await Promise.race([imported, exited.then(() => { throw new Error('CLI exited before importing'); })]);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const code = await exited;
  return { code, stdout, stderr, calls, mappingPath };
}

function accept(res, body, status = 201) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ session: { id: body.id, startedAt: body.startedAt, finishedAt: body.finishedAt }, sets: body.sets }));
}

function nextWorkout() {
  return { ...RAW, id: 'c'.repeat(32), name: 'Second workout', sets: [{ ...RAW.sets[0], id: 'd'.repeat(32) }] };
}

describe('whole workouts', () => {
  it('continues after terminal refusals and exhausted retries, counting imports and current replay rows separately', async () => {
    const sessions = Array.from({ length: 4 }, (_, i) => ({
      id: `ses_${i}`, label: `Workout ${i}`, startedAt: 7, finishedAt: 9, finishedFrom: 'export',
      sets: [{ id: `set_${i}`, exerciseId: 'bench-press', weightKg: 82.5, reps: 8, completedAt: 8 }],
    }));
    const calls = [];
    const client = new GymClient({
      baseUrl: 'http://localhost', token: 'secret', sleep: async () => {},
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, body });
        if (body.id === 'ses_1') return { ok: false, status: 409, text: async () => '{"code":"session-overlap","error":"overlap"}' };
        if (body.id === 'ses_2') throw new Error('connection lost');
        return {
          ok: true, status: body.id === 'ses_0' ? 201 : 200,
          text: async () => JSON.stringify({ session: { id: body.id }, sets: body.id === 'ses_0' ? body.sets : [] }),
        };
      },
    });
    deepStrictEqual(await writeCorpus(client, sessions), {
      sessions: 1, sets: 1, sessionsReplayed: 1, setsReplayed: 0,
      failures: [
        { label: 'Workout 1', reason: '409 session-overlap overlap', lostSets: 1 },
        { label: 'Workout 2', reason: 'connection lost', lostSets: 1 },
      ],
    });
    strictEqual(calls.length, 7);
    for (const { url, body } of calls) {
      strictEqual(url, 'http://localhost/v1/gym/sessions/import');
      deepStrictEqual(Object.keys(body), ['id', 'startedAt', 'finishedAt', 'sets']);
    }
  });
});

describe('the CLI', () => {
  it('imports the example fixture with one request per planned workout and only the kept routes', async (t) => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/example-export.json', import.meta.url), 'utf8'));
    const result = await commandOver(t, fixture.sessions, (req, res, body) => accept(res, body));
    strictEqual(result.code, 0);
    strictEqual(result.stderr, '');
    deepStrictEqual(result.calls.map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: '/v1/gym/exercises' },
      ...Array.from({ length: 4 }, () => ({ method: 'POST', path: '/v1/gym/sessions/import' })),
    ]);
    deepStrictEqual(result.calls.slice(1).map(({ body }) => body.sets.length), [5, 2, 2, 2]);
    match(result.stdout, /4 sessions imported · 11 sets imported/);
    strictEqual(JSON.parse(await readFile(result.mappingPath, 'utf8')).exercises['Bench Press'], 'bench-press');
  });

  it('returns 1 for a refused workout, names it, and imports the next workout', async (t) => {
    const result = await commandOver(t, [RAW, nextWorkout()], (req, res, body) => {
      if (body.id === `ses_${RAW.id}`) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'overlap', code: 'session-overlap', sessionId: 'ses_existing' }));
        return;
      }
      accept(res, body);
    });
    strictEqual(result.code, 1);
    strictEqual(result.stderr, '');
    strictEqual(result.calls.length, 3);
    match(result.stdout, /1 sessions imported · 1 sets imported/);
    match(result.stdout, /First workout .*409 session-overlap overlap \(session ses_existing\)/);
    match(result.stdout, /1 sets not confirmed; rerun the same export/);
  });

  it('reports an interrupted old import for review without retries or changed ids, and continues importing and replaying', async (t) => {
    const replay = { ...RAW, id: 'e'.repeat(32), name: 'Replayed workout', sets: [{ ...RAW.sets[0], id: 'f'.repeat(32) }] };
    const result = await commandOver(t, [RAW, nextWorkout(), replay], (req, res, body) => {
      if (body.id === `ses_${RAW.id}`) {
        res.writeHead(409);
        res.end(JSON.stringify({ code: 'session-id-taken', error: 'session id is already taken' }));
        return;
      }
      accept(res, body.id === `ses_${replay.id}` ? { ...body, sets: [] } : body,
        body.id === `ses_${replay.id}` ? 200 : 201);
    });
    strictEqual(result.code, 1);
    strictEqual(result.stderr, '');
    deepStrictEqual(result.calls, [
      { method: 'GET', path: '/v1/gym/exercises', body: undefined },
      ...[RAW, nextWorkout(), replay].map((workout) => ({
        method: 'POST', path: '/v1/gym/sessions/import',
        body: {
          id: `ses_${workout.id}`, startedAt: workout.startedAt, finishedAt: workout.finishedAt,
          sets: workout.sets.map((set) => ({
            id: `set_${set.id}`, exerciseId: 'bench-press', weightKg: set.weight,
            reps: set.reps, completedAt: set.completedAt,
          })),
        },
      })),
    ]);
    match(result.stdout, /1 sessions imported · 1 sets imported/);
    match(result.stdout, /1 sessions already imported · 0 sets currently present in replayed workouts/);
    match(result.stdout, /1 workout import failed/);
    match(result.stdout, /First workout .*already exists from an earlier, interrupted import — not re-imported/);
    match(result.stdout, new RegExp(`id ses_${RAW.id}; date ${new Date(RAW.startedAt).toISOString()}\\) — review the existing workout\\n$`));
    doesNotMatch(result.stdout, /rerun the same export/);
  });

  it('does not count a reserved session id as an accepted replay', async (t) => {
    const result = await commandOver(t, [RAW], (req, res) => {
      res.writeHead(409);
      res.end(JSON.stringify({ code: 'session-id-taken', error: 'the payload changed' }));
    });
    strictEqual(result.code, 1);
    strictEqual(result.stderr, '');
    deepStrictEqual(result.calls.map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: '/v1/gym/exercises' },
      { method: 'POST', path: '/v1/gym/sessions/import' },
    ]);
    strictEqual(result.calls[1].body.id, `ses_${RAW.id}`);
    match(result.stdout, /0 sessions imported · 0 sets imported/);
    match(result.stdout, /1 workout import failed/);
    match(result.stdout, /already exists from an earlier, interrupted import — not re-imported/);
    doesNotMatch(result.stdout, /sessions already imported|every planned workout was accepted|rerun the same export/);
  });

  it('returns 1 after four disconnected attempts and still imports the next workout', async (t) => {
    const result = await commandOver(t, [RAW, nextWorkout()], (req, res, body) => {
      if (body.id === `ses_${RAW.id}`) { res.socket.destroy(); return; }
      accept(res, body);
    });
    strictEqual(result.code, 1);
    strictEqual(result.stderr, '');
    strictEqual(result.calls.length, 6);
    deepStrictEqual(result.calls.slice(1, 5).map(({ body }) => body), Array(4).fill(result.calls[1].body));
    match(result.stdout, /1 sessions imported · 1 sets imported/);
    match(result.stdout, /First workout .*fetch failed/);
  });

  it('reports only replayed rows on 200, including a workout corrected since import', async (t) => {
    const result = await commandOver(t, [RAW], (req, res, body) => accept(res, { ...body, sets: [] }, 200));
    strictEqual(result.code, 0);
    strictEqual(result.calls.length, 2);
    match(result.stdout, /0 sessions imported · 0 sets imported/);
    match(result.stdout, /1 sessions already imported · 0 sets currently present in replayed workouts/);
  });

  it('reports every oversized workout and flushes a large summary through a slow pipe before exit', async (t) => {
    const oversized = Array.from({ length: 500 }, (_, i) => ({
      ...RAW, id: i.toString(16).padStart(32, '0'), name: `Oversized workout ${i} ${'x'.repeat(600)}`,
      sets: Array.from({ length: 201 }, () => ({ ...RAW.sets[0], exerciseName: 'Unknown oversized move', reps: 0 })),
    }));
    const result = await commandOver(t, [...oversized, nextWorkout()], (req, res, body) => accept(res, body), true);
    strictEqual(result.code, 1);
    strictEqual(result.stderr, '');
    strictEqual(result.calls.length, 2);
    strictEqual(result.calls[1].body.id, `ses_${nextWorkout().id}`);
    strictEqual((result.stdout.match(/201 sets exceeds the 200-set import limit/g) ?? []).length, 500);
    match(result.stdout, /Oversized workout 499/);
    match(result.stdout, /1 sessions imported · 1 sets imported\n  every planned workout was accepted\n$/);
  });

  it('returns 1 for a malformed success reply and continues to the next workout', async (t) => {
    const result = await commandOver(t, [RAW, nextWorkout()], (req, res, body) => {
      if (body.id === `ses_${RAW.id}`) { res.end('{}'); return; }
      accept(res, body);
    });
    strictEqual(result.code, 1);
    strictEqual(result.calls.length, 3);
    match(result.stdout, /First workout .*requested workout/);
    match(result.stdout, /1 sessions imported · 1 sets imported/);
  });

  it('returns 2 for unresolved exercise names and sends no import request', async (t) => {
    const result = await commandOver(t, [{ ...RAW, sets: [{ ...RAW.sets[0], exerciseName: 'Unknown move' }] }], () => {
      throw new Error('unexpected import');
    });
    strictEqual(result.code, 2);
    strictEqual(result.calls.length, 1);
    match(result.stdout, /1 exercise name could not be resolved\. Nothing was written/);
  });
});
