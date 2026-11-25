// Settings · Your journal over a real browser engine: what it offers before anything is pressed, signed out and signed in,
// and how an export it runs ends on the screen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { syncSession } from '../../../../src/platform/sync/session.js';
import { savePage } from '../../../../src/products/journal/pages.js';
import { environment } from '../../../platform/sync/fakes.js';
import { journalRegistry, journalProduct } from '../../../platform/sync/oracle-adapters/journal.js';
import { ServerState } from '../../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../../packages/api-contract/sync/reference/server/push.js';
import { elementsOf, loadScreen, renderHook, settle, textOf } from '../../gym/harness.mjs';

const day = '2026-09-27';

// A browser whose engine answers to the engine's reference server, signed in to `account` or signed out, and the section
// drawn over it as the settings page draws it for that seat; a `lapsed` seat is signed out over the account's replica.
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
  const draw = () => {
    const view = renderHook(t, () => YourJournalSection(), { live: true, context: { account: seat && { id: seat } } });
    const content = () => elementsOf(view.tree.props.children);
    const button = () => content().find((element) => element.props.variant === 'secondary') ?? null;
    return {
      title: () => view.tree.props.title,
      // The section's words, top to bottom, with what a button and the unsent pages' row say put in by name.
      words: () => content().filter((element) => typeof element.type === 'string' && ['p', 'span'].includes(element.type)).map(textOf),
      button: () => button() && { label: textOf(button().props.children), disabled: button().props.disabled, busy: button().props.ariaBusy },
      outcome: () => content().filter((element) => element.type === 'p' && element.props.style?.color).map((line) => [textOf(line), line.props.style.color]),
      press: () => button().props.onClick(),
      unsent: () => content().find((element) => 'account' in element.props)?.props.account,
    };
  };
  return { engine, write, draw };
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

test('a lapsed seat\'s page is signed out over the account\'s replica, and says its pages are the account\'s, not this browser\'s', async (t) => {
  const { draw } = await section(t, { account: 'A', lapsed: true });
  const screen = draw();
  await settle();
  assert.deepEqual({ button: screen.button(), words: screen.words(), unsent: screen.unsent() }, {
    button: { label: 'Export my pages', disabled: false, busy: false },
    words: ['One Markdown file — every page you have written, oldest first.'],
    unsent: null,
  });
});
