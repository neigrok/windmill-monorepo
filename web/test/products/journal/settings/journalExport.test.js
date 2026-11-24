import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { buildJournalArchive, exportedPages, journalMarkdown } from '../../../../src/products/journal/settings/journalExport.js';
import { savePage, SCOPE } from '../../../../src/products/journal/pages.js';
import { environment, tick } from '../../../platform/sync/fakes.js';
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
  let state = ServerState.empty({ epoch: 'ep-1', accounts: { A: {} } });
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

test('signed out, the export is the browser\'s own pages, at once and with no request', async (t) => {
  const { engine } = await browser(t);
  await savePage(engine, page('  written on this browser\n'));
  const files = downloads(t);
  assert.deepEqual(await buildJournalArchive(engine), { count: 1 });
  assert.equal(await files[0].text(), '# Windmill journal\n\n## 2026-09-27\n\n_mood 3/10_\n\nwritten on this browser\n');
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
  const archive = buildJournalArchive(engine).finally(() => { settled = true; });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(settled, false, 'the export waits for the first pull');
  await engine.pull();
  assert.deepEqual(await archive, { count: 1 });
  assert.equal(await files[0].text(), '# Windmill journal\n\n## 2026-09-27\n\n_mood 3/10_\n\nkept by the account\n');
});

test('a first pull that never ends fails the export rather than writing a partial file', async (t) => {
  const { env, engine } = await browser(t);
  env.transport.account = 'A';
  await engine.signIn('A');
  await assert.rejects(exportedPages(engine, 20), { reason: 'first_pull_timeout' });
  await assert.rejects(exportedPages(null), { reason: 'no_replica' });
});
