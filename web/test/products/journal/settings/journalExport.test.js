import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { buildJournalArchive, exportedPages, journalMarkdown } from '../../../../src/products/journal/settings/journalExport.js';
import { savePage, SCOPE } from '../../../../src/products/journal/pages.js';
import { EDITOR_DRAFT_KEY } from '../../../../src/products/journal/domain/page.js';
import { environment, tick, until } from '../../../platform/sync/fakes.js';
import { journalRegistry, journalProduct } from '../../../platform/sync/oracle-adapters/journal.js';
import { ServerState } from '../../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../../packages/api-contract/sync/reference/server/push.js';

test('journalMarkdown — one document, oldest first, scales as the fractions they are', () => {
  const markdown = journalMarkdown([
    { day: '2026-08-04', body: 'slept badly', mood: 2, energy: 1, source: 'typed', stamp: '1:0:a' },
    { day: '2026-08-02', body: 'better', mood: null, energy: null, source: 'typed', stamp: '1:0:a' },
  ]);

  assert.equal(markdown, [
    '# Windmill journal',
    '',
    '## 2026-08-02',
    '',
    'better',
    '',
    '## 2026-08-04',
    '',
    '_mood 2/10 · energy 1/10_',
    '',
    'slept badly',
    '',
  ].join('\n'));
});

test('journalMarkdown — scales without words and untouched days are absent', () => {
  const markdown = journalMarkdown([
    { day: '2026-08-01', body: '', mood: 4, energy: null },
    { day: '2026-08-03', body: '', mood: null, energy: null },
  ]);

  assert.equal(markdown, '# Windmill journal\n\n');
});

test('journalMarkdown — an account with nothing in it is an honest empty document', () => {
  assert.equal(journalMarkdown([]), '# Windmill journal\n\n');
});

const day = '2026-09-27';
const page = (body) => ({ day, body, mood: 3, energy: null, source: 'typed' });
async function browser(t) {
  const env = environment();
  env.timers.time = Date.parse(`${day}T12:00:00Z`);
  let state = ServerState.empty({ epoch: 'ep-1', accounts: { A: {}, B: {} } });
  env.options.registry = journalRegistry;
  env.transport.request = async (endpoint, request) => {
    const at = env.timers.time;
    let response;
    if (endpoint === 'hello') response = hello({ state, registry: journalRegistry, account: env.transport.account, serverTime: at });
    else {
      const result = (endpoint === 'push' ? push : pull)({ state, registry: journalRegistry, product: journalProduct,
        account: env.transport.account, request, serverNow: at });
      state = result.state; response = result.response;
    }
    return { response, timing: { send: { wall: at, mono: at, boot: 'test' }, recv: { wall: at, mono: at, boot: 'test' } } };
  };
  const engine = await BrowserSyncEngine.open(env.options);
  await engine.start();
  t.after(() => engine.close());
  t.mock.method(globalThis, 'fetch', (url) => assert.fail(`the export asked the network for ${url}`));
  return { env, engine };
}
function downloads(t) {
  const files = [];
  t.mock.method(URL, 'createObjectURL', (blob) => { files.push(blob); return 'blob:journal'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } };
  t.after(() => { globalThis.document = previous; });
  return files;
}

// What the export tells: its events and its Sentry reports, each as the arguments it was handed.
function telemetry() {
  const told = { events: [], reports: [] };
  return { told, track: (name, props) => told.events.push([name, props]), report: (...args) => told.reports.push(args) };
}

test('signed out, the export is the browser\'s own pages, at once and with no request', async (t) => {
  const { engine } = await browser(t);
  await savePage(engine, page('  written on this browser\n'));
  const files = downloads(t);
  const { told, ...seams } = telemetry();
  assert.deepEqual(await buildJournalArchive(engine, 'signed_out', seams), { count: 1, file: 'windmill-journal.md' });
  assert.equal(await files[0].text(), '# Windmill journal\n\n## 2026-09-27\n\n_mood 3/10_\n\nwritten on this browser\n');
  assert.deepEqual(told, { events: [['journal_export', { outcome: 'ok', seat: 'signed_out' }]], reports: [] });
});

test('a journal with no written page exports no file, and tells the export ended empty', async (t) => {
  const { engine } = await browser(t);
  await savePage(engine, page(' \n'));
  const files = downloads(t);
  const { told, ...seams } = telemetry();
  assert.deepEqual(await buildJournalArchive(engine, 'signed_out', seams), { count: 0, file: null });
  assert.deepEqual({ files, told }, { files: [], told: { events: [['journal_export', { outcome: 'empty', seat: 'signed_out' }]], reports: [] } });
});

test('a download the browser refuses fails the export, reported with its step and the error\'s stack', async (t) => {
  const { engine } = await browser(t);
  await savePage(engine, page('written on this browser'));
  downloads(t);
  const refused = new DOMException('blocked', 'SecurityError');
  t.mock.method(URL, 'createObjectURL', () => { throw refused; });
  const { told, ...seams } = telemetry();
  await assert.rejects(buildJournalArchive(engine, 'signed_out', seams), refused);
  assert.deepEqual(told, { events: [['journal_export', { outcome: 'failed', seat: 'signed_out' }]],
    reports: [['journal', 'journal-export', refused.stack, '/app/settings', { step: 'download' }]] });
});

test('a download whose click throws leaves no anchor in the page', async (t) => {
  const { engine } = await browser(t);
  await savePage(engine, page('written on this browser'));
  downloads(t);
  const inPage = new Set();
  const refused = new DOMException('blocked', 'NotAllowedError');
  globalThis.document = { createElement: () => ({ click() { throw refused; }, remove() { inPage.delete(this); } }),
    body: { appendChild: (anchor) => inPage.add(anchor) } };
  const { told, ...seams } = telemetry();
  await assert.rejects(buildJournalArchive(engine, 'signed_out', seams), refused);
  assert.deepEqual({ anchors: inPage.size, told }, { anchors: 0, told: { events: [['journal_export', { outcome: 'failed', seat: 'signed_out' }]],
    reports: [['journal', 'journal-export', refused.stack, '/app/settings', { step: 'download' }]] } });
});

test('a row the domain kit cannot decode fails the export and is reported, though its error carries a reason', async (t) => {
  const { engine } = await browser(t);
  await savePage(engine, page('a real page'));
  await engine.write(null, (device) => {
    device.activeReplica.device.journal = { ...(device.activeReplica.device.journal ?? {}),
      [EDITOR_DRAFT_KEY]: { day: 42, document: { body: 'x', mood: null, energy: null, source: 'typed', stamp: '1:0:a' } } };
  }, [SCOPE]);
  const { told, ...seams } = telemetry();
  const thrown = await buildJournalArchive(engine, 'signed_out', seams).catch((error) => error);
  assert.deepEqual([thrown.constructor.name, thrown.reason], ['DecodeError', 'not a string']);
  assert.deepEqual(told, { events: [['journal_export', { outcome: 'failed', seat: 'signed_out' }]],
    reports: [['journal', 'journal-export', thrown.stack, '/app/settings', { step: 'pages' }]] });
});

test('pages the replica cannot hand fail the export at its first step, and an expected wait reports nothing', async (t) => {
  const broken = new TypeError('unreadable');
  const engine = { closed: false, observe: () => ({ getSnapshot: () => { throw broken; }, subscribe: () => () => {}, release() {} }) };
  const { told, ...seams } = telemetry();
  await assert.rejects(buildJournalArchive(engine, 'signed_in', seams), broken);
  await assert.rejects(buildJournalArchive(null, 'signed_out', seams), { reason: 'no_replica' });
  assert.deepEqual(told, { events: [['journal_export', { outcome: 'failed', seat: 'signed_in' }], ['journal_export', { outcome: 'no_replica', seat: 'signed_out' }]],
    reports: [['journal', 'journal-export', broken.stack, '/app/settings', { step: 'pages' }]] });
});

test('an export started for one account fails when another signs in before its first pull ends', async (t) => {
  const { env, engine } = await browser(t);
  env.transport.account = 'B';
  await engine.signIn('B');
  await savePage(engine, page('kept by B'));
  for (let i = 0; i < 4; i++) { await engine.send(); await engine.pull(); }
  await engine.finishSignOut({ choice: 'discard' });
  env.transport.account = 'A';
  await engine.signIn('A');
  const exported = exportedPages(engine, 60_000).then((pages) => pages.map(({ body }) => body), (error) => error.reason);
  await engine.finishSignOut({ choice: 'discard' });
  env.transport.account = 'B';
  await engine.signIn('B');
  await until(() => engine.leader);
  for (let i = 0; i < 4; i++) { await engine.send(); await engine.pull(); }
  assert.equal(engine.observe(SCOPE).getSnapshot().firstPullComplete, true);
  assert.equal(await exported, 'replica_changed');
});

test('the export lets go of the journal it watched, whichever way it ends', async (t) => {
  const { env, engine } = await browser(t);
  const holds = [];
  const observe = engine.observe.bind(engine);
  t.mock.method(engine, 'observe', (scope) => {
    const hold = observe(scope);
    const watched = { scope, released: false, listening: 0 };
    holds.push(watched);
    return {
      getSnapshot: () => hold.getSnapshot(),
      subscribe: (listener) => { watched.listening += 1; const stop = hold.subscribe(listener); return () => { watched.listening -= 1; stop(); }; },
      release: () => { watched.released = true; hold.release(); },
    };
  });
  assert.deepEqual(await exportedPages(engine), []);
  env.transport.account = 'A';
  await engine.signIn('A');
  await assert.rejects(exportedPages(engine, 20), { reason: 'first_pull_timeout' });
  const changed = exportedPages(engine, 60_000).then(() => 'resolved', (error) => error.reason);
  await engine.finishSignOut({ choice: 'discard' });
  assert.equal(await changed, 'replica_changed');
  const watching = holds.filter(({ released, listening }) => !released || listening > 0);
  assert.deepEqual({ watching, exports: holds.filter(({ scope }) => scope === SCOPE).length >= 3 }, { watching: [], exports: true });
});

test('a bound replica exports the account\'s pages once its first pull of the journal ends, asking the backend for none', async (t) => {
  const { env, engine } = await browser(t);
  env.transport.account = 'A';
  await engine.signIn('A');
  await savePage(engine, page('kept by the account'));
  for (let i = 0; i < 4; i++) { await engine.send(); await engine.pull(); }
  await engine.finishSignOut({ choice: 'discard' });
  await engine.signIn('A');
  assert.equal(engine.observe(SCOPE).getSnapshot().firstPullComplete, false);
  const files = downloads(t);
  let settled = false;
  const { told, ...seams } = telemetry();
  const archive = buildJournalArchive(engine, 'signed_in', seams).finally(() => { settled = true; });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(settled, false, 'the export waits for the first pull');
  await engine.pull();
  assert.deepEqual(await archive, { count: 1, file: 'windmill-journal.md' });
  assert.deepEqual(told, { events: [['journal_export', { outcome: 'ok', seat: 'signed_in' }]], reports: [] });
  assert.equal(await files[0].text(), '# Windmill journal\n\n## 2026-09-27\n\n_mood 3/10_\n\nkept by the account\n');
});

test('a first pull that never ends fails the export rather than writing a partial file', async (t) => {
  const { env, engine } = await browser(t);
  env.transport.account = 'A';
  await engine.signIn('A');
  await assert.rejects(exportedPages(engine, 20), { reason: 'first_pull_timeout' });
  await assert.rejects(exportedPages(null), { reason: 'no_replica' });
});
