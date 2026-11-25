// Settings · Your journal over a real browser engine: what it offers before anything is pressed, signed out and signed in,
// and how an export it runs ends on the screen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { syncSession } from '../../../../src/platform/sync/session.js';
import { savePage, SCOPE } from '../../../../src/products/journal/pages.js';
import { EDITOR_DRAFT_KEY } from '../../../../src/products/journal/domain/page.js';
import { environment } from '../../../platform/sync/fakes.js';
import { journalRegistry, journalProduct } from '../../../platform/sync/oracle-adapters/journal.js';
import { ServerState } from '../../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../../packages/api-contract/sync/reference/server/push.js';
import { elementsOf, loadScreen, renderHook, settle, textOf } from '../../gym/harness.mjs';

const day = '2026-09-27';

// A browser whose engine answers to the engine's reference server, signed in to `account` or signed out, and the section
// drawn over it as the settings page draws it for that seat, its events and Sentry reports told to `told`; a `lapsed` seat
// is signed out over the account's replica.
async function section(t, { account = null, lapsed = false } = {}) {
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
  if (account) {
    env.transport.account = account;
    await engine.signIn(account);
  }
  const seat = lapsed ? null : account;
  t.mock.method(syncSession, 'getSnapshot', () => ({ engine, ready: true, signedIn: Boolean(seat), account: seat, online: true, error: false }));
  const { YourJournalSection } = await loadScreen('products/journal/settings/YourJournalSection.jsx');
  const write = (body) => savePage(engine, { day, body, mood: 3, energy: null, source: 'typed' });
  const told = { events: [], reports: [] };
  const track = (name, props) => told.events.push([name, props]);
  const report = (...args) => told.reports.push(args);
  const draw = () => {
    const view = renderHook(t, () => YourJournalSection({ track, report }), { live: true, context: { account: seat && { id: seat } } });
    const content = () => elementsOf(view.tree.props.children);
    const button = () => content().find((element) => element.props.variant === 'secondary') ?? null;
    return {
      title: () => view.tree.props.title,
      // The section's words, top to bottom, with what a button and the unsent pages' row say put in by name.
      words: () => content().filter((element) => typeof element.type === 'string' && ['p', 'span'].includes(element.type)).map(textOf),
      button: () => button() && { label: textOf(button().props.children), disabled: button().props.disabled, busy: button().props.ariaBusy },
      outcome: () => content().filter((element) => element.type === 'p' && element.props.style?.color).map((line) => [textOf(line), line.props.style.color]),
      press: () => button().props.onClick(),
      // The press a second click makes before the page draws the first one's: the same handler, twice.
      pressTwice: () => { const { onClick } = button().props; onClick(); onClick(); },
      redraw: () => view.redraw(),
      unsent: () => content().find((element) => 'account' in element.props)?.props.account,
    };
  };
  return { engine, write, draw, told };
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

test('signed out with nothing written, the section offers no export and says there is nothing to export', async (t) => {
  const { draw } = await section(t);
  const screen = draw();
  await settle();
  assert.deepEqual({ title: screen.title(), words: screen.words(), button: screen.button(), unsent: screen.unsent() },
    { title: 'Your journal', words: ['No pages to export yet.'], button: null, unsent: null });
});

test('signed out, the export takes the browser\'s own pages, waits as Preparing… and says how many it wrote to which file', async (t) => {
  const { write, draw } = await section(t);
  await write('written on this browser');
  const files = downloads(t);
  const screen = draw();
  await settle();
  const atRest = { button: { label: 'Export my pages', disabled: false, busy: false },
    words: ['One Markdown file — every page you have written here, oldest first.'] };
  assert.deepEqual({ button: screen.button(), words: screen.words() }, atRest);
  screen.press();
  assert.deepEqual({ button: screen.button(), words: screen.words() },
    { button: { label: 'Preparing…', disabled: true, busy: true }, words: atRest.words });
  await settle();
  assert.deepEqual({ button: screen.button(), outcome: screen.outcome() },
    { button: atRest.button, outcome: [['Exported 1 page to windmill-journal.md.', 'var(--color-success)']] });
  assert.equal(await files[0].text(), '# Windmill journal\n\n## 2026-09-27\n\n_mood 3/10_\n\nwritten on this browser\n');
});

test('an export the browser refuses to hand over says it failed, under the button that is back', async (t) => {
  const { write, draw } = await section(t);
  await write('written on this browser');
  downloads(t);
  t.mock.method(URL, 'createObjectURL', () => { throw new DOMException('blocked', 'SecurityError'); });
  const screen = draw();
  await settle();
  screen.press();
  await settle();
  assert.deepEqual({ button: screen.button(), outcome: screen.outcome() }, {
    button: { label: 'Export my pages', disabled: false, busy: false },
    outcome: [["Couldn't build your export just now — try again.", 'var(--color-danger)']],
  });
});

test('signed in, the export stands in today\'s words until the first pull says the account holds no page', async (t) => {
  const { engine, draw } = await section(t, { account: 'A' });
  const screen = draw();
  await settle();
  assert.deepEqual({ button: screen.button(), words: screen.words(), unsent: screen.unsent() }, {
    button: { label: 'Export my pages', disabled: false, busy: false },
    words: ['One Markdown file — every page you have written, oldest first.'],
    unsent: 'A',
  });
  await engine.pull();
  await settle();
  assert.deepEqual({ button: screen.button(), words: screen.words() }, { button: null, words: ['No pages to export yet.'] });
});

test('over an account\'s replica with no account settled, the section says the pages are the account\'s and its export tells signed_in', async (t) => {
  const { engine, draw, told } = await section(t, { account: 'A', lapsed: true });
  downloads(t);
  const screen = draw();
  await settle();
  assert.deepEqual({ button: screen.button(), words: screen.words(), unsent: screen.unsent() }, {
    button: { label: 'Export my pages', disabled: false, busy: false },
    words: ['One Markdown file — every page you have written, oldest first.'],
    unsent: null,
  });
  screen.press();
  await engine.pull();
  await settle();
  assert.deepEqual(told, { events: [['journal_export', { outcome: 'empty', seat: 'signed_in' }]], reports: [] });
});

test('a double click on Export my pages exports once', async (t) => {
  const { write, draw, told } = await section(t);
  await write('written on this browser');
  const files = downloads(t);
  const screen = draw();
  await settle();
  screen.pressTwice();
  await settle();
  assert.deepEqual({ files: files.length, told }, { files: 1, told: { events: [['journal_export', { outcome: 'ok', seat: 'signed_out' }]], reports: [] } });
});

test('pages the section cannot count leave the export offered, and the count\'s failure is reported once', async (t) => {
  const { engine, write, draw, told } = await section(t);
  await write('written on this browser');
  await engine.write(null, (device) => {
    device.activeReplica.device.journal = { ...(device.activeReplica.device.journal ?? {}),
      [EDITOR_DRAFT_KEY]: { day: 42, document: { body: 'x', mood: null, energy: null, source: 'typed', stamp: '1:0:a' } } };
  }, [SCOPE]);
  const screen = draw();
  await settle();
  screen.redraw();
  await settle();
  assert.deepEqual({ button: screen.button(), words: screen.words() }, {
    button: { label: 'Export my pages', disabled: false, busy: false },
    words: ['One Markdown file — every page you have written here, oldest first.'],
  });
  assert.deepEqual(told.reports.map(([kind, operation, stack, route, tags]) => [kind, operation, stack.startsWith('Error: editorDraft.day'), route, tags]),
    [['journal', 'journal-export', true, '/app/settings', { step: 'count' }]]);
  screen.press();
  await settle();
  assert.deepEqual({ outcome: screen.outcome(), events: told.events, steps: told.reports.map((report) => report[4].step) }, {
    outcome: [["Couldn't build your export just now — try again.", 'var(--color-danger)']],
    events: [['journal_export', { outcome: 'failed', seat: 'signed_out' }]],
    steps: ['count', 'pages'],
  });
});
