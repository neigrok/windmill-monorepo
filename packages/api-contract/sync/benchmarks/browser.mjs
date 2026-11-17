import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, cpus, platform, release } from 'node:os';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: {
  fixtures: { type: 'string' }, output: { type: 'string' },
  port: { type: 'string', default: '5347' }, scenario: { type: 'string' },
} });
if (!values.fixtures || !values.output) throw new Error('usage: node browser.mjs --fixtures DIRECTORY --output FILE [--port PORT] [--scenario NAME]');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtureDirectory = resolve(values.fixtures), reportPath = resolve(values.output);
const port = Number(values.port);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
const manifest = JSON.parse(readFileSync(join(fixtureDirectory, 'manifest.json'), 'utf8'));
const pendingEntries = JSON.parse(readFileSync(join(fixtureDirectory, 'pending-entries.json'), 'utf8'));
const { createServer } = await import(pathToFileURL(join(root, 'web/node_modules/vite/dist/node/index.js')));
const { chromium } = await import(pathToFileURL(join(root, 'web/node_modules/playwright/index.mjs')));
const reference = fileURLToPath(new URL('../reference/', import.meta.url));
const at = (file) => import(pathToFileURL(reference + file));
const { registry, product } = await at('vectors/fixtures.js');
const { ServerState } = await at('server/state.js');
const { hello, pull } = await at('server/pull.js');
const { push } = await at('server/push.js');
const cache = mkdtempSync(join(tmpdir(), 'windmill-scale-vite-'));
mkdirSync(dirname(reportPath), { recursive: true });

let state, server;
const serverTimes = [];
server = await createServer({ configFile: false, root: `${root}/web`, cacheDir: cache,
  plugins: [{ name: 'scale-page', configureServer(host) {
    host.middlewares.use('/scale/api', async (request, response) => {
      try {
        let input = ''; for await (const part of request) input += part;
        const { endpoint, body } = JSON.parse(input);
        const began = performance.now();
        let answer;
        if (endpoint === 'hello') answer = hello({ state, registry, account: 'A', serverTime: Date.now() });
        else {
          const result = (endpoint === 'push' ? push : pull)({ state, registry, product, account: 'A', request: body, serverNow: Date.now() });
          state = result.state; answer = result.response;
        }
        serverTimes.push({ endpoint, ms: performance.now() - began });
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(answer));
      } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ failure: error.name })); }
    });
    host.middlewares.use('/scale', (_request, response) => {
      response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Roadmap size measurement</title>');
    });
  } }], server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } } });
const listening = once(server.httpServer, 'listening'); server.httpServer.listen(port, '127.0.0.1'); await listening;
let browser;
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
let results = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : [];
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  for (const scenario of (values.scenario ? [values.scenario] : Object.keys(manifest.scenarios))) {
    assert(Object.hasOwn(manifest.scenarios, scenario));
    state = new ServerState(JSON.parse(readFileSync(join(fixtureDirectory, `${scenario}.json`), 'utf8'))); serverTimes.length = 0;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/scale`);
      const measured = await page.evaluate(async ({ scenario, reference, probe, pendingEntries, expected, tree }) => {
        const { BrowserSyncEngine } = await import('/src/platform/sync/engine.js');
        const { Registry } = await import(`/@fs${reference}core/registry.js`);
        const registry = new Registry(probe), name = `scale-${scenario}`;
        const failures = [], events = [], writerSamples = [];
        let operation = 'initialOpen';
        const transport = { async request(endpoint, body) {
          const sent = { wall: Date.now(), mono: Math.floor(performance.now()), boot: 'scale' };
          const response = await (await fetch('/scale/api', { method: 'POST', body: JSON.stringify({ endpoint, body }) })).json();
          return { response, timing: { send: sent, recv: { wall: Date.now(), mono: Math.floor(performance.now()), boot: 'scale' } } };
        }, openLive() { return { readyState: 0, send() {}, close() {} }; } };
        const timers = { setTimeout: () => 1, clearTimeout() {} };
        const options = { name, registry, transport, timers, telemetry: {
          limit: 100,
          failure: (name) => failures.push(name),
          event: (name, properties) => {
            events.push(name);
            if (name === 'sync-writer') writerSamples.push({ operation, kind: operation === 'gesture' ? 'commit' : 'non-commit',
              durationMs: properties.durationMs, queueMs: properties.queueMs });
          },
        } };
        let engine = await BrowserSyncEngine.open(options);
        const scope = tree;
        const check = (ok, message) => { if (!ok) throw new Error(message); };
        const result = { scenario, storage: 'Chromium IndexedDB', transport: 'HTTP to JS reference server; explicit engine rounds', browser: navigator.userAgent };
        const measure = async (key, body) => {
          const previous = operation; operation = key.replace(/Ms$/, '');
          const start = performance.now();
          try { const value = await body(); result[key] = +(performance.now() - start).toFixed(1); return value; }
          finally { operation = previous; }
        };
        if (scenario === 'pending') {
          operation = 'fixtureSeed';
          await engine.store.transact((device) => {
            const replica = device.activeReplica;
            replica.outbox = pendingEntries;
          });
        } else {
          operation = 'initialSignIn';
          check((await engine.signIn('A')).complete, 'initial sign-in failed');
          operation = 'initialStart';
          await engine.start();
          for (let n = 0; !engine.leader && n < 100; n++) await new Promise((resolve) => setTimeout(resolve, 10));
          check(engine.leader, 'leader not ready');
          await measure('firstPullMs', async () => {
            for (let n = 0; n < 2000; n++) {
              engine.kickPull(engine.scopes().filter((scope) => engine.device.activeReplica.cursors[scope]?.booted !== true)); await engine.pull();
              const replica = engine.device.activeReplica;
              if (engine.scopes(replica).length === expected.followedScopes && engine.scopes(replica).every((scope) => replica.cursors[scope]?.booted)) break;
              if (n === 1999) throw new Error('pull did not finish');
            }
          });
        }
        engine.close();
        await measure('openMs', async () => { engine = await BrowserSyncEngine.open(options); });
        await measure('readMs', async () => {
          const count = engine.observe(scope).getSnapshot().drawn.length;
          check(count === expected.deviceRecords, `wrong opened count ${count}`);
        });
        result.openAndReadMs = +(result.openMs + result.readMs).toFixed(1);
        result.openCache = 'same-process reopen; OS pages may be warm';
        await measure('gestureMs', async () => {
          const committed = await engine.commit(scope, [{ op: 'update', t: 'tag', id: 'step0', f: { label: 'Edited' } }]);
          check(!committed.refused, 'gesture refused');
        });
        if (scenario === 'pending') await measure('signInMs', async () => check((await engine.signIn('A')).complete, 'adoption failed'));
        else await measure('signInMs', async () => check((await engine.signIn('A')).complete, 'returning sign-in failed'));
        if (scenario === 'pending') {
          const queued = engine.device.activeReplica.outbox.length;
          operation = 'postAdoptionStart';
          await engine.start();
          for (let n = 0; !engine.leader && n < 100; n++) await new Promise((resolve) => setTimeout(resolve, 10));
          check(engine.leader, 'leader not ready after adoption');
          await measure('firstPullMs', async () => {
            engine.kickPull(['self/probe']);
            for (let n = 0; n < 2000; n++) {
              await engine.pull();
              if (engine.device.activeReplica.cursors['self/probe']?.booted) return;
              if (n === 1999) throw new Error('empty-account product pull did not finish');
            }
          });
          check(engine.device.activeReplica.outbox.length === queued, 'product pull changed pending entries');
          check(engine.device.activeReplica.cursors[scope]?.booted !== true, 'new queued tree was pulled before its governing create');
          result.firstPullCoverage = 'empty account product after adoption; queued new tree remains local';
        } else result.firstPullCoverage = 'all owned product, tree and overlay scopes';
        result.records = engine.observe(scope).getSnapshot().drawn.length;
        result.pendingEntries = engine.device.activeReplica.outbox.length;
        check(result.records === expected.deviceRecords, 'records changed during adoption or pull');
        check(result.pendingEntries === expected.pendingEntries + 1, 'unexpected pending-entry count');
        check(writerSamples.filter((sample) => sample.operation === 'gesture').length === 1, 'gesture writer was not observed exactly once');
        check(writerSamples.some((sample) => sample.operation === 'firstPull'), 'first-pull writer was not observed');
        const summaries = [];
        for (const name of [...new Set(writerSamples.map((sample) => sample.operation))].sort()) {
          const samples = writerSamples.filter((sample) => sample.operation === name);
          const summary = { operation: name, kind: samples[0].kind, count: samples.length };
          for (const field of ['durationMs', 'queueMs']) {
            const values = samples.map((sample) => sample[field]).sort((a, b) => a - b);
            const quantile = (q) => values[Math.max(0, Math.ceil(values.length * q) - 1)];
            summary[field] = { max: values.at(-1), p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) };
          }
          summaries.push(summary);
        }
        result.writer = { coverage: 'delivered sync-writer events for changed transactions, grouped by benchmark API phase',
          timing: 'duration includes queue wait through durable completion; integer milliseconds rounded up',
          sampling: 'at most 100 telemetry events per minute per engine; duration capped at 60000 ms; samples may be censored',
          summaries, samples: writerSamples };
        result.failures = failures; result.events = [...new Set(events)];
        engine.close(); return result;
      }, { scenario, reference, probe: JSON.parse(readFileSync(join(root, 'packages/api-contract/sync/probe.registry.json'), 'utf8')),
        pendingEntries: scenario === 'pending' ? pendingEntries : [], expected: manifest.scenarios[scenario], tree: manifest.tree });
      measured.serverRequests = serverTimes.length;
      measured.serverMs = +serverTimes.reduce((sum, item) => sum + item.ms, 0).toFixed(1);
      measured.sourceHead = sourceHead;
      measured.sourceDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
      measured.host = { platform: platform(), release: release(), cpu: cpus()[0]?.model, node: process.version };
      measured.serverRequestTimings = [...serverTimes];
      assert.deepEqual(measured.failures, []);
      results = results.filter((item) => item.scenario !== scenario);
      results.push(measured); console.log(JSON.stringify(measured));
      writeFileSync(reportPath, JSON.stringify(results, null, 2) + '\n');
    } finally { await context.close(); }
  }
} finally { await browser?.close(); await server?.close(); rmSync(cache, { recursive: true, force: true }); }
