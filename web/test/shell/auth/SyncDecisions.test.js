import test from 'node:test';
import assert from 'node:assert/strict';
import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

const question = { kind: 'signed-out', product: 'journal', count: { page: 3, journalState: 1 }, counted: ['one'] };
const work = { type: 'page', counted: (count) => `${count} ${count === 1 ? 'page' : 'pages'}`, many: 'pages' };
test('occupied Journal asks with real page counts, equal Add/Discard and no dismissal', async (t) => {
  const { SyncDecisions } = await loadScreen('shell/auth/SyncDecisions.jsx');
  const decisions = [];
  const view = renderHook(t, () => SyncDecisions({ question, work, onDecision: (choice) => decisions.push(choice) }));
  assert.equal(view.tree.props.title, 'Add to your account?');
  assert.equal(view.tree.props.onClose, undefined);
  assert.equal(textOf(view.tree.props.children),
    '3 pages from before you signed in are only on this device, and your account already has pages. Add them, or discard them for good.');
  const buttons = elementsOf(view.tree.props.footer).filter((element) => element.props.variant);
  assert.deepEqual(buttons.map((button) => [textOf(button.props.children), button.props.variant]), [['Add', 'secondary'], ['Discard', 'secondary']]);
  buttons[1].props.onClick();
  assert.equal(view.tree.props.title, 'Discard 3 pages?');
  assert.deepEqual(decisions, []);
  const confirmation = elementsOf(view.tree.props.footer).filter((element) => element.props.variant);
  assert.deepEqual(confirmation.map((button) => [textOf(button.props.children), button.props.variant]), [['Cancel', 'secondary'], ['Discard', 'danger']]);
  confirmation[0].props.onClick();
  assert.equal(view.tree.props.title, 'Add to your account?');
});

test('sign-out states sent work may be confirmed and offers Keep/Discard/Cancel', async (t) => {
  const { SyncDecisions } = await loadScreen('shell/auth/SyncDecisions.jsx');
  const view = renderHook(t, () => SyncDecisions({ question: { unsent: 1, counted: ['one'] } }));
  assert.ok(textOf(view.tree.props.children).includes('1 change hasn’t been confirmed'));
  const buttons = elementsOf(view.tree.props.footer).filter((element) => element.props.variant);
  assert.deepEqual(buttons.map((button) => textOf(button.props.children)), ['Cancel', 'Keep', 'Discard']);
});

test('an editor-only sign-in question names the unsaved writing without claiming zero pages', async (t) => {
  const { SyncDecisions } = await loadScreen('shell/auth/SyncDecisions.jsx');
  const view = renderHook(t, () => SyncDecisions({ question: { ...question, count: {}, pending: 1 }, work }));
  assert.equal(textOf(view.tree.props.children),
    '1 unsaved change from before you signed in is only on this device, and your account already has pages. Add it, or discard it for good.');
  elementsOf(view.tree.props.footer).find((element) => textOf(element.props.children) === 'Discard').props.onClick();
  assert.equal(view.tree.props.title, 'Discard 1 unsaved change?');
});

test('sign-out carries each product’s notice of what it discards, with the download that keeps it', async (t) => {
  const { SyncDecisions } = await loadScreen('shell/auth/SyncDecisions.jsx');
  const downloads = [];
  const notice = { line: 'A recording waiting in Talk will be discarded.',
    download: { label: 'Download recording', href: 'blob:take', filename: 'talk.webm', onDownload: () => downloads.push('talk') } };
  const view = renderHook(t, () => SyncDecisions({ question: { unsent: 0, counted: [] }, notices: [notice] }));

  assert.equal(textOf(view.tree.props.children),
    'Your pages and log stay in your account and leave this device.A recording waiting in Talk will be discarded. Download recording');
  const link = elementsOf(view.tree.props.children).find((element) => element.type === 'a');
  assert.deepEqual([link.props.href, link.props.download], ['blob:take', 'talk.webm']);
  link.props.onClick();
  assert.deepEqual(downloads, ['talk']);
  const signIn = renderHook(t, () => SyncDecisions({ question, work, notices: [notice] }));
  assert.equal(elementsOf(signIn.tree.props.children).some((element) => element.type === 'a'), false, 'a sign-in question discards nothing of Talk');
});

// The page's window for an account decision: whether it is 744px wide or more, and the Escape it hears.
function page(t, { wide }) {
  const listeners = new Map();
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { matchMedia: () => ({ matches: wide, addEventListener() {}, removeEventListener() {} }),
    addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: (type) => listeners.delete(type) };
  globalThis.document = { activeElement: null };
  t.after(() => Object.assign(globalThis, previous));
  return { press: (key) => listeners.get('keydown')?.({ key, stopPropagation() {} }), listening: () => listeners.has('keydown') };
}

// What an account decision shows: its layout, its words and its answers, each with its look.
function shownIn(tree) {
  const elements = elementsOf(tree);
  const one = (type) => elements.find((element) => element.type === type);
  return {
    layout: tree.props.className,
    title: textOf(one('h2')),
    lead: textOf(elements.find((element) => element.props.className === 'wm-decision-lead')),
    items: elements.filter((element) => element.type === 'li').map(textOf),
    notes: elements.filter((element) => element.props.className === 'wm-decision-note').map(textOf),
    answers: elements.filter((element) => element.props.size === 'lg').map((button) => [textOf(button.props.children), button.props.variant ?? 'primary', button.props.full]),
  };
}

test('a sign-in question its product words is asked in those words: from 744px a quiet Discard before Add, Escape cancels, and each step is told', async (t) => {
  const { SyncDecisions, AccountDecision } = await loadScreen('shell/auth/SyncDecisions.jsx');
  const keys = page(t, { wide: true });
  const steps = [], decisions = [], cancels = [];
  const words = { title: 'Add your roadmaps?', lead: '2 roadmaps on this browser can join your account.', items: ['Learn to sail', 'A quieter home'],
    note: 'Choosing Discard removes these browser roadmaps.', onStep: (step) => steps.push(step) };
  const props = { question: { ...question, product: 'roadmap', words }, busy: false, error: false,
    onDecision: (choice) => decisions.push(choice), onCancel: () => cancels.push('cancel') };
  assert.equal(renderHook(t, () => SyncDecisions(props)).tree.type, AccountDecision);
  const view = renderHook(t, () => AccountDecision(props));
  assert.deepEqual(shownIn(view.tree), {
    layout: 'wm-decision wm-decision--dialog',
    title: 'Add your roadmaps?',
    lead: '2 roadmaps on this browser can join your account.',
    items: ['Learn to sail', 'A quieter home'],
    notes: ['Choosing Discard removes these browser roadmaps.'],
    answers: [['Discard', 'ghost', false], ['Add', 'primary', false]],
  });
  elementsOf(view.tree).find((element) => textOf(element.props.children) === 'Add').props.onClick();
  keys.press('Escape');
  view.unmount();
  assert.deepEqual({ steps, decisions, cancels, listening: keys.listening() }, { steps: ['shown', 'add', 'cancel'], decisions: ['add'], cancels: ['cancel'], listening: false });
});

test('below 744px the question is a page with Keep over Discard under the thumb, its failure said under the note, and Escape waits while an answer is in flight', async (t) => {
  const { AccountDecision } = await loadScreen('shell/auth/SyncDecisions.jsx');
  const keys = page(t, { wide: false });
  const steps = [], cancels = [];
  const words = { title: 'Keep unsent changes?', lead: '3 changes haven’t reached your account.', items: ['Learn to sail · 3 changes'],
    note: 'Keep them for your next sign-in. Discard removes them from this browser.', onStep: (step) => steps.push(step) };
  const view = renderHook(t, () => AccountDecision({ question: { unsent: 3, counted: ['a', 'b', 'c'], words }, busy: true, error: true,
    onDecision() {}, onCancel: () => cancels.push('cancel') }));
  keys.press('Escape');
  view.unmount();
  assert.deepEqual({ shown: shownIn(view.tree), steps, cancels }, {
    shown: {
      layout: 'wm-decision wm-decision--page',
      title: 'Keep unsent changes?',
      lead: '3 changes haven’t reached your account.',
      items: ['Learn to sail · 3 changes'],
      notes: ['Keep them for your next sign-in. Discard removes them from this browser.', 'Couldn’t finish just now. Your changes are still here. Try again when connected.'],
      answers: [['Keep', 'primary', true], ['Discard', 'ghost', true]],
    },
    steps: ['shown'],
    cancels: [],
  });
});

test('a worded sign-out question that a product’s notice adds to keeps the shell’s words and the notice’s download', async (t) => {
  const { SyncDecisions, AccountDecision } = await loadScreen('shell/auth/SyncDecisions.jsx');
  page(t, { wide: true });
  const words = { title: 'Keep unsent changes?', lead: '1 change hasn’t reached your account.', items: ['Learn to sail · 1 change'], note: 'Keep it for your next sign-in.', onStep() {} };
  const notice = { line: 'A recording waiting in Talk will be discarded.', download: { label: 'Download recording', href: 'blob:take', filename: 'talk.webm' } };
  const worded = { unsent: 1, counted: ['one'], words };
  const withNotice = renderHook(t, () => SyncDecisions({ question: worded, notices: [notice] })).tree;
  const without = renderHook(t, () => SyncDecisions({ question: worded })).tree;
  assert.deepEqual({ withNotice: withNotice.props.title, without: without.type === AccountDecision }, { withNotice: 'Sign out?', without: true });
});
