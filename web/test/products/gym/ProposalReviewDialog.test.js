import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { receiptLine } from '../../../src/products/gym/proposals.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from './harness.mjs';

const GYM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/products/gym');
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

function proposal(over = {}) {
  return {
    id: 'prop_1',
    routineId: 'rt_push',
    intent: 'revise',
    state: 'pending',
    summary: 'Heavier triples on the bench; the rest stays.',
    changeCount: 2,
    createdAt: 1_755_000_000_000,
    source: { door: 'ask', thread: 'thr_1' },
    baseRevision: 3,
    baseName: 'Push A',
    name: 'Push A',
    changes: [
      { position: 1, kind: 'retargeted', exerciseId: 'bench-press', before: { sets: 5, reps: 5, weightKg: 80 }, after: { sets: 5, reps: 3, weightKg: 90 } },
      { position: 2, kind: 'kept', exerciseId: 'chin-up', before: { sets: 3 }, after: { sets: 3 } },
      { position: 3, kind: 'kept', exerciseId: 'barbell-row', before: { sets: 4, reps: 8, weightKg: 70 }, after: { sets: 4, reps: 8, weightKg: 70 } },
      { position: 4, kind: 'added', exerciseId: 'dip', after: { sets: 3, reps: 10 } },
    ],
    ...over,
  };
}

function proposalOnTheWire(stored, { settleStatus = 200, settleBody = null } = {}) {
  const wire = [];
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    wire.push(`${method} ${path}`);
    if (path === '/proposals/prop_1' && method === 'GET') return { ok: true, status: 200, json: async () => stored };
    if (path === '/proposals/prop_1/apply' || path === '/proposals/prop_1/dismiss') {
      if (settleStatus !== 200) return { ok: false, status: settleStatus, json: async () => settleBody };
      const state = path.endsWith('apply') ? 'applied' : 'dismissed';
      return { ok: true, status: 200, json: async () => ({ proposal: { ...stored, state, settledAt: 1_755_100_000_000 }, routine: { id: 'rt_push' } }) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return wire;
}

const dialogOf = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'Dialog');
// What a screen reader meets TRAVERSING the band: `textOf` with the `aria-hidden` subtrees taken
// out, which is the one thing `aria-describedby` does not do for you. A sentence that is both drawn
// and pointed at is read twice unless its node is out of the tree (ledger `4m`).
const traversed = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(traversed).join('');
  if (!React.isValidElement(node) || typeof node.type === 'function') return '';
  if (node.props['aria-hidden']) return '';
  return traversed(node.props.children);
};
// Accname §4.1 skips a hidden node only when it is NOT the direct target of the reference, so the
// description is computed off the referenced node whether or not it is hidden.
const describing = (band) => {
  const apply = findByClass(band, 'gym-proposal-apply')[0];
  const target = elementsOf(band).find((each) => each.props.id === apply.props['aria-describedby']);
  return textOf(target);
};
const band = (tree, seen) => dialogOf(tree).props.footer({ seen });
const quiet = { catalog: [{ id: 'bench-press', name: 'Bench Press' }, { id: 'chin-up', name: 'Chin-up' }, { id: 'barbell-row', name: 'Barbell Row' }, { id: 'dip', name: 'Dip' }], session: null, say: () => {} };

test('the review is a scroll-gated dialog: Apply stands alone in the band and is inert until the diff has been seen', async (t) => {
  browserWith();
  const wire = proposalOnTheWire(proposal());
  const { ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  const settled = [];
  const screen = renderHook(t, () => ProposalReview({ id: 'prop_1', log: quiet, onClose: () => {}, onSettled: (receipt) => settled.push(receipt) }));
  await settle();

  const dialog = dialogOf(screen.tree);
  assert.equal(dialog.props.open, true);
  assert.equal(dialog.props.gate, 'scrolled');
  assert.equal(dialog.props.title, 'Proposal · Push A');
  assert.equal(typeof dialog.props.footer, 'function');

  const unseen = band(screen.tree, false);
  const applyUnseen = findByClass(unseen, 'gym-proposal-apply')[0];
  assert.equal(applyUnseen.props['aria-disabled'], true);
  assert.equal(applyUnseen.props.disabled, undefined, 'never out of the tab order');
  const slotId = findByClass(unseen, 'gym-proposal-gate')[0].props.id;
  assert.equal(applyUnseen.props['aria-describedby'], slotId, 'Apply is described by its OWN dialog’s gate');
  assert.equal(textOf(applyUnseen), 'Apply all 2');
  assert.equal(findByClass(unseen, 'gym-proposal-dismiss').length, 0, 'no pair');
  assert.equal(textOf(findByClass(unseen, 'gym-proposal-turn-down')[0]), 'Turn this down');
  assert.equal(elementsOf(unseen).filter((each) => each.type === 'button').length, 2, 'Apply and the turn-down row, and nothing else clickable');

  // The gate says why it is shut and names the way out; the slot is drawn in both states, so the
  // band's height — and Apply's place in it — never changes.
  const gateUnseen = findByClass(unseen, 'gym-proposal-gate');
  assert.equal(gateUnseen.length, 1);
  assert.equal(textOf(gateUnseen[0]), 'Read the changes to the end to apply them.');
  assert.notEqual(gateUnseen[0].props.id, '');
  // And it is read ONCE. Drawn for the eye, out of the tree for the reader, and reached only as
  // Apply's description — which still computes, because the description is taken off the node the
  // reference names whether that node is hidden or not.
  assert.equal(gateUnseen[0].props['aria-hidden'], 'true', 'the drawn sentence is out of the tree');
  assert.equal(traversed(unseen).includes('Read the changes to the end to apply them.'), false,
    'traversing the band a reader never meets the sentence — that reading would be the second one');
  assert.equal(describing(unseen), 'Read the changes to the end to apply them.',
    'and the one reading there is: Apply says why it is shut');
  assert.equal(traversed(unseen), 'Apply all 2All two or none. Nothing is applied until you tap.Turn this down',
    'what is left to traverse is Apply, the atomic promise and the turn-down — each said once');
  assert.equal(textOf(findByClass(unseen, 'gym-proposal-atomic')[0]), 'All two or none. Nothing is applied until you tap.');
  applyUnseen.props.onClick();
  await settle();
  assert.deepEqual(wire, ['GET /proposals/prop_1'], 'the shut gate applies nothing');

  const seen = band(screen.tree, true);
  const apply = findByClass(seen, 'gym-proposal-apply')[0];
  assert.equal(apply.props['aria-disabled'], false);
  const gateSeen = findByClass(seen, 'gym-proposal-gate');
  assert.equal(gateSeen.length, 1, 'the slot is held open');
  assert.equal(textOf(gateSeen[0]), '');
  assert.equal(gateSeen[0].props['aria-hidden'], 'true', 'the held-open slot stays out of the tree');
  assert.equal(describing(seen), '', 'and Apply, once the diff is read, has no refusal to describe');
  apply.props.onClick();
  await settle();
  assert.deepEqual(wire, ['GET /proposals/prop_1', 'POST /proposals/prop_1/apply']);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].verb, 'apply');
  assert.equal(settled[0].proposal.state, 'applied');
  assert.equal(receiptLine(settled[0]), 'Applied · Push A · 2 changes');
});

test('the gate is silent while the apply request is in flight: it reads `seen`, never the inert predicate', async (t) => {
  browserWith();
  let answer = null;
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    if ((options.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => proposal() };
    return new Promise((resolve) => { answer = () => resolve({ ok: true, status: 200, json: async () => ({ proposal: { ...proposal(), state: 'applied', settledAt: 1 } }) }); });
  };
  const { ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  const screen = renderHook(t, () => ProposalReview({ id: 'prop_1', log: quiet, onClose: () => {}, onSettled: () => {} }));
  await settle();

  findByClass(band(screen.tree, true), 'gym-proposal-apply')[0].props.onClick();
  await settle();
  const inFlight = band(screen.tree, true);
  const applying = findByClass(inFlight, 'gym-proposal-apply')[0];
  assert.equal(applying.props['aria-busy'], true, 'the write is going');
  assert.equal(applying.props['aria-disabled'], true, 'and Apply is inert for that reason');
  assert.equal(textOf(findByClass(inFlight, 'gym-proposal-gate')[0]), '', 'so the gate says nothing — the diff HAS been read');
  answer();
  await settle();
});

test('turning down is a confirmed text row, and its receipt says nothing changed', async (t) => {
  browserWith();
  const wire = proposalOnTheWire(proposal());
  const { ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  const settled = [];
  const screen = renderHook(t, () => ProposalReview({ id: 'prop_1', log: quiet, onClose: () => {}, onSettled: (receipt) => settled.push(receipt) }));
  await settle();

  findByClass(band(screen.tree, true), 'gym-proposal-turn-down')[0].props.onClick();
  const confirming = band(screen.tree, true);
  assert.equal(textOf(findByClass(confirming, 'gym-confirm-title')[0]), 'Turn this down?');
  assert.equal(textOf(findByClass(confirming, 'gym-confirm-body')[0]), 'Nothing changes, and it stays in the routine’s history as a record.');
  assert.equal(textOf(findByClass(confirming, 'gym-confirm-do')[0]), 'Turn down');
  assert.equal(textOf(findByClass(confirming, 'gym-confirm-keep')[0]), 'Keep it');
  assert.equal(findByClass(confirming, 'gym-proposal-apply').length, 0);

  findByClass(confirming, 'gym-confirm-keep')[0].props.onClick();
  assert.equal(findByClass(band(screen.tree, true), 'gym-proposal-apply').length, 1, 'Keep it returns the band');
  assert.deepEqual(wire, ['GET /proposals/prop_1']);

  findByClass(band(screen.tree, true), 'gym-proposal-turn-down')[0].props.onClick();
  findByClass(band(screen.tree, true), 'gym-confirm-do')[0].props.onClick();
  await settle();
  assert.deepEqual(wire, ['GET /proposals/prop_1', 'POST /proposals/prop_1/dismiss']);
  assert.equal(receiptLine(settled[0]), 'Turned down · nothing changed.');
});

test('kept rows fold to a count in their own place and unfold there; the prose sits under its kicker; the caveat sits above the diff', async (t) => {
  browserWith();
  proposalOnTheWire(proposal());
  const { ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  const midWorkout = { ...quiet, session: { id: 'ses_1', startedAt: 1 } };
  const screen = renderHook(t, () => ProposalReview({ id: 'prop_1', log: midWorkout, onClose: () => {}, onSettled: () => {} }));
  await settle();

  const body = dialogOf(screen.tree).props.children;
  const rows = () => findByClass(dialogOf(screen.tree).props.children, 'gym-diff-row').map((row) => row.props.className);
  assert.deepEqual(rows(), ['gym-diff-row is-retargeted', 'gym-diff-row is-kept-run', 'gym-diff-row is-added']);
  const unfold = findByClass(body, 'gym-diff-unfold')[0];
  assert.equal(textOf(unfold), 'and 2 lines unchanged');
  unfold.props.onClick();
  assert.deepEqual(rows(), ['gym-diff-row is-retargeted', 'gym-diff-row is-kept', 'gym-diff-row is-kept', 'gym-diff-row is-added'], 'position preserved');

  assert.equal(textOf(findByClass(body, 'gym-proposal-wrote-kicker')[0]), 'Coach wrote:');
  assert.equal(textOf(findByClass(body, 'gym-proposal-wrote-text')[0]), 'Heavier triples on the bench; the rest stays.');
  assert.equal(textOf(findByClass(body, 'gym-proposal-caveat')[0]), 'You are mid-workout. Applying changes next time, not this session.');
  assert.ok(elementsOf(body).findIndex((each) => each.props.className === 'gym-proposal-caveat') < elementsOf(body).findIndex((each) => each.props.className === 'gym-diff'));
  assert.equal(findByClass(band(screen.tree, true), 'gym-proposal-caveat').length, 0, 'never in the band');
  // The atomic promise is pinned in the band between Apply and turn-down, never in the scrolling body.
  assert.equal(findByClass(body, 'gym-proposal-atomic').length, 0);
  const pinned = elementsOf(band(screen.tree, true)).map((each) => each.props.className);
  assert.deepEqual(pinned.filter((each) => typeof each === 'string' && each.startsWith('gym-proposal-')), [
    'gym-proposal-band', 'gym-proposal-apply', 'gym-proposal-gate', 'gym-proposal-atomic', 'gym-proposal-turn-down',
  ]);
  assert.equal(textOf(findByClass(band(screen.tree, true), 'gym-proposal-atomic')[0]), 'All two or none. Nothing is applied until you tap.');
});

test('an empty summary draws the card’s own sentence as ours, never under the writer’s kicker', async (t) => {
  browserWith();
  proposalOnTheWire(proposal({ summary: '', source: { door: 'mcp' } }));
  const { ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  const screen = renderHook(t, () => ProposalReview({ id: 'prop_1', log: quiet, onClose: () => {}, onSettled: () => {} }));
  await settle();
  const body = dialogOf(screen.tree).props.children;
  assert.equal(findByClass(body, 'gym-proposal-wrote-kicker').length, 0);
  assert.equal(textOf(findByClass(body, 'gym-proposal-summary')[0]), '2 changes to Push A.');
});

test('a refused settle shows the server’s bytes inside the dialog, re-reads the proposal and tells whatever opened it to re-read too', async (t) => {
  browserWith();
  const wire = proposalOnTheWire(proposal(), {
    settleStatus: 409,
    settleBody: { error: 'that routine changed after this proposal was written, so it was not applied', code: 'proposal-superseded' },
  });
  const { ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  const settled = [];
  let changed = 0;
  const screen = renderHook(t, () => ProposalReview({ id: 'prop_1', log: quiet, onClose: () => {}, onSettled: (receipt) => settled.push(receipt), onChanged: () => { changed += 1; } }));
  await settle();
  assert.equal(changed, 0);
  findByClass(band(screen.tree, true), 'gym-proposal-apply')[0].props.onClick();
  await settle();
  assert.deepEqual(wire, ['GET /proposals/prop_1', 'POST /proposals/prop_1/apply', 'GET /proposals/prop_1']);
  assert.deepEqual(settled, []);
  assert.equal(changed, 1, 'the card behind the dialog must not outlive what the dialog just learned');
  const refusal = findByClass(dialogOf(screen.tree).props.children, 'gym-proposal-refusal')[0];
  assert.equal(textOf(refusal), 'that routine changed after this proposal was written, so it was not applied');
});

test('a wordless refusal (no body, nothing moved) neither re-reads nor tells the opener anything', async (t) => {
  browserWith();
  const wire = proposalOnTheWire(proposal(), { settleStatus: 503, settleBody: null });
  const { ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  let changed = 0;
  const screen = renderHook(t, () => ProposalReview({ id: 'prop_1', log: quiet, onClose: () => {}, onSettled: () => {}, onChanged: () => { changed += 1; } }));
  await settle();
  findByClass(band(screen.tree, true), 'gym-proposal-apply')[0].props.onClick();
  await settle();
  assert.deepEqual(wire, ['GET /proposals/prop_1', 'POST /proposals/prop_1/apply']);
  assert.equal(changed, 0);
  assert.equal(findByClass(dialogOf(screen.tree).props.children, 'gym-proposal-refusal').length, 1);
});

test('the kicker names the writer by door: Coach, the agent’s name, or an unnamed agent — never Coach over an agent’s words', async (t) => {
  browserWith();
  const { ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  const kickerOf = async (source) => {
    proposalOnTheWire(proposal({ source }));
    const screen = renderHook(t, () => ProposalReview({ id: 'prop_1', log: quiet, onClose: () => {}, onSettled: () => {} }));
    await settle();
    return textOf(findByClass(dialogOf(screen.tree).props.children, 'gym-proposal-wrote-kicker')[0]);
  };
  assert.equal(await kickerOf({ door: 'ask', thread: 'thr_1' }), 'Coach wrote:');
  assert.equal(await kickerOf({ door: 'mcp', agent: 'Claude' }), 'Claude wrote:');
  assert.equal(await kickerOf({ door: 'mcp' }), 'Your agent wrote:');
});

test('the routines home owns a proposal reached by its address: settling or learning it moved re-reads the home', async (t) => {
  browserWith();
  const wire = [];
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    wire.push(`${method} ${path}`);
    if (path === '/routines') return { ok: true, status: 200, json: async () => ({ routines: [{ id: 'rt_push', name: 'Push A', position: 0, revision: 3, entries: [], pendingProposal: { id: 'prop_1', source: { door: 'mcp' }, createdAt: 1, changeCount: 2, intent: 'revise', state: 'pending' } }] }) };
    if (path === '/proposals/prop_1') return { ok: true, status: 200, json: async () => proposal() };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const said = [];
  const log = roomLog({ say: (line) => said.push(line) });
  const { RoutinesList } = await loadScreen('products/gym/Routines.jsx');
  const screen = renderHook(t, () => RoutinesList({ log, onSignIn: () => {}, reviewing: 'prop_1' }));
  await settle();
  const review = () => elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'ProposalReview');
  assert.equal(review().props.id, 'prop_1');
  assert.deepEqual(wire, ['GET /routines']);

  review().props.onChanged();
  await settle();
  assert.deepEqual(wire, ['GET /routines', 'GET /routines'], 'a refusal that moved the proposal re-reads the home behind it');

  review().props.onSettled({ verb: 'apply', proposal: { name: 'Push A', changeCount: 2 } });
  await settle();
  assert.deepEqual(wire, ['GET /routines', 'GET /routines', 'GET /routines'], 'a settle re-reads the home behind it');
  assert.deepEqual(said, ['Applied · Push A · 2 changes']);
  assert.equal(globalThis.window.location.hash, '#/gym');

  review().props.onClose();
  assert.equal(globalThis.window.location.hash, '#/gym');
  assert.equal(wire.length, 3, 'closing decides nothing and reads nothing');
});

test('a home card’s dialog outlives the card: a re-read that drops the card leaves the dialog and its refusal standing', async (t) => {
  browserWith();
  const { PendingProposals } = await loadScreen('products/gym/Proposals.jsx');
  const pending = { id: 'prop_1', source: { door: 'mcp' }, createdAt: 1, changeCount: 2, intent: 'revise', state: 'pending' };
  let routines = [{ id: 'rt_push', name: 'Push A', pendingProposal: pending }, { id: 'rt_pull', name: 'Pull A', pendingProposal: { ...pending, id: 'prop_2' } }];
  let changed = 0;
  const screen = renderHook(t, () => PendingProposals({ routines, log: quiet, onChanged: () => { changed += 1; } }));
  const review = () => elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'ProposalReview');
  const cards = () => elementsOf(screen.tree).filter((each) => typeof each.type === 'function' && each.type.name === 'ProposalCard');
  assert.equal(cards().length, 2);
  assert.equal(review(), undefined);

  cards()[0].props.onReview('prop_1');
  assert.equal(review().props.id, 'prop_1');
  review().props.onChanged();
  assert.equal(changed, 1, 'the home re-reads');

  // The re-read answers without either card; the review that is open stays open.
  routines = [];
  cards()[1].props.onReview('prop_2');
  assert.equal(cards().length, 0);
  assert.equal(findByClass(screen.tree, 'gym-proposals').length, 0, 'no empty section behind the scrim');
  assert.equal(review().props.id, 'prop_2');

  review().props.onClose();
  assert.equal(review(), undefined);
  assert.equal(screen.tree.props.children.every((child) => !child), true, 'nothing drawn with nothing waiting');
});

test('closing the dialog decides nothing, and a settled proposal offers no band', async (t) => {
  browserWith();
  const wire = proposalOnTheWire(proposal({ state: 'dismissed', settledAt: 1_755_100_000_000 }));
  const { ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  const closed = [];
  const screen = renderHook(t, () => ProposalReview({ id: 'prop_1', log: quiet, onClose: () => closed.push(true), onSettled: () => {} }));
  await settle();
  assert.equal(dialogOf(screen.tree).props.footer, null);
  assert.equal(textOf(findByClass(dialogOf(screen.tree).props.children, 'gym-proposal-settled')[0]).startsWith('Turned down '), true);
  dialogOf(screen.tree).props.onClose();
  assert.deepEqual(closed, [true]);
  assert.deepEqual(wire, ['GET /proposals/prop_1']);
});

test('the review never pushes: no hash moves from a card, the card is a skim, and nothing in it runs on a clock', () => {
  const source = fs.readFileSync(path.join(GYM, 'Proposals.jsx'), 'utf8');
  assert.equal(source.includes('window.location.hash'), false);
  assert.equal(source.includes('useEffect'), false);
  assert.equal(source.includes('gate="scrolled"'), true);
  assert.equal(source.includes('{midWorkout && <p className="gym-proposal-caveat">{MID_WORKOUT_CAVEAT}</p>}'), true);
  assert.ok(source.indexOf('gym-proposal-caveat') < source.indexOf('<ul className="gym-diff">'));
  const room = fs.readFileSync(path.join(GYM, 'coach', 'CoachRoom.jsx'), 'utf8');
  assert.equal(room.includes('<ProposalReview'), true);
  assert.equal(room.includes('onChanged={view.refresh}'), true, 'the card re-reads in place when the dialog learns the proposal moved');
  assert.equal(room.includes('view.retry()'), false, 'a re-read from loading would unmount the dialog and the receipt');
  assert.equal(room.includes('<p className="gym-proposal-line">{summaryLine(proposal, proposal.baseName)}</p>'), true, 'the card carries the summary it wrote');
  // The document is drawn once, in this dialog. The card outside it is a skim: how much it is on its
  // own line under the summary, then what MOVED, three rows at most, then the rest counted.
  assert.equal(room.includes('<p className="gym-proposal-counted">{countedLabel(proposal)}</p>'), true);
  assert.ok(room.indexOf('gym-proposal-line') < room.indexOf('gym-proposal-counted'));
  assert.equal(room.includes('const changed = diffRows(proposal).filter((row) => CARD_ROW_KINDS.includes(row.kind));'), true);
  assert.equal(room.includes('changed.slice(0, CARD_ROW_CAP)'), true);
  assert.equal(room.includes('{moreRowsLabel(changed.length - CARD_ROW_CAP)}'), true);
  // No kept row, no fold, and no count in the kicker — the kicker names the routine and nothing else.
  for (const gone of ['collapseKept', 'keptRunLabel', 'gym-diff-unfolded']) {
    assert.equal(room.includes(gone), false, gone);
  }
  assert.equal(fs.readFileSync(path.join(GYM, 'gym.css'), 'utf8').includes('gym-diff-unfolded'), false);
  assert.equal(room.includes('<span className="gym-proposal-name">{`Proposal · ${proposal.baseName}`}</span>'), true);
  const kicker = room.slice(room.indexOf('<p className="gym-proposal-kicker">'), room.indexOf('<p className="gym-proposal-line">'));
  for (const gone of ['countedLabel', 'changeLabel', 'changeCount']) {
    assert.equal(kicker.includes(gone), false, `the count is off the kicker — ${gone}`);
  }
  assert.equal(room.includes('setReceipt(receiptLine(settled));'), true);
  assert.equal(room.includes('{receipt && <p className="gym-coach-receipt" role="status">{receipt}</p>}'), true);
  const threads = fs.readFileSync(path.join(GYM, 'coach', 'Threads.jsx'), 'utf8');
  assert.equal(threads.includes('<ProposalReview'), true);
  assert.equal(threads.includes('onChanged={view.refresh}'), true);
  assert.equal(threads.includes('view.retry()'), false);
  assert.equal(threads.includes('new Map(held).set(reviewing, receiptLine(settled))'), true);
  // Ephemeral: the receipt is state of the visit and is read back from no wire.
  for (const file of ['coach/CoachRoom.jsx', 'coach/Threads.jsx', 'Proposals.jsx']) {
    const said = fs.readFileSync(path.join(GYM, file), 'utf8');
    assert.equal(/localStorage|sessionStorage|receiptAt|settledLine\(receipt/.test(said), false, file);
  }
});

// The Coach card as the room composes it: `CoachRoom` → `CoachBody` → `Answer` → `CoachProposal`.
// None of those inner pieces is an export, so the card is reached through the tree that draws it and
// then rendered on its own — how many rows a lifter sees is not a string in a file.
async function coachCard(t, stored) {
  browserWith();
  global.fetch = async (url, options = {}) => {
    const at = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    if (at === '/ask' && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ answer: 'Here it is.', proposals: [stored.id], read: { sets: 40, sessions: 8, weeks: 3 } }) };
    }
    if (at === `/proposals/${stored.id}` && method === 'GET') return { ok: true, status: 200, json: async () => stored };
    throw new Error(`unexpected ${method} ${at}`);
  };
  const { CoachRoom } = await loadScreen('products/gym/coach/CoachRoom.jsx');
  const room = renderHook(t, () => CoachRoom({ log: quiet }));
  const bodyOf = () => elementsOf(room.tree).find((each) => typeof each.type === 'function' && each.type.name === 'CoachBody');
  bodyOf().props.setDraft('What should I change?');
  bodyOf().props.onAsk();
  await settle();
  const shown = bodyOf();
  const answer = elementsOf(shown.type(shown.props)).find((each) => typeof each.type === 'function' && each.type.name === 'Answer');
  const drawn = elementsOf(answer.type(answer.props)).find((each) => typeof each.type === 'function' && each.type.name === 'CoachProposal');
  const card = renderHook(t, () => drawn.type(drawn.props));
  await settle();
  return card;
}

const retargets = (count, from = 1) => Array.from({ length: count }, (_, at) => ({
  position: from + at,
  kind: 'retargeted',
  exerciseId: `mv-${from + at}`,
  before: { sets: 3, reps: 8, weightKg: 60 },
  after: { sets: 3, reps: 8, weightKg: 62.5 },
}));
const lines = (tree) => findByClass(tree, 'gym-diff-row').filter((row) => !row.props.className.includes('is-more'));
const doorsIn = (tree) => elementsOf(tree).filter((each) => typeof each.type === 'function' && each.type.name === 'ReviewDoor');

test('the Coach card draws three rows of what moved and counts the rest, and never a line that stood still', async (t) => {
  const many = await coachCard(t, proposal({ changeCount: 5, changes: retargets(5) }));
  assert.equal(lines(many.tree).length, 3);
  assert.deepEqual(findByClass(many.tree, 'gym-diff-more').map(textOf), ['+ 2 more']);
  assert.deepEqual(findByClass(many.tree, 'gym-proposal-counted').map(textOf), ['5 changes']);

  // Two changes inside twenty kept lines: two rows, and nothing counted — the kept run is the routine
  // standing still, which the dialog draws and the card does not.
  const wide = await coachCard(t, proposal({
    changeCount: 2,
    changes: [
      ...retargets(1),
      ...Array.from({ length: 20 }, (_, at) => ({ position: at + 2, kind: 'kept', exerciseId: `kept-${at}`, before: { sets: 3 }, after: { sets: 3 } })),
      { position: 22, kind: 'added', exerciseId: 'dip', after: { sets: 3, reps: 10 } },
    ],
  }));
  assert.deepEqual(lines(wide.tree).map((row) => row.props.className), ['gym-diff-row is-retargeted', 'gym-diff-row is-added']);
  assert.deepEqual(findByClass(wide.tree, 'gym-diff-more'), []);
});

test('the rename and the reorder are claims about the document, so only the dialog draws them — the card counts them and draws neither', async (t) => {
  // Nothing marked, and a count above it: `diffRows` reads the gap as the order moving. On the card
  // `Order · the lines run in the order below` would be the only row, with no lines below it.
  const kept = Array.from({ length: 4 }, (_, at) => ({ position: at + 1, kind: 'kept', exerciseId: `kept-${at}`, before: { sets: 3 }, after: { sets: 3 } }));
  const shuffled = await coachCard(t, proposal({ changeCount: 3, changes: kept }));
  assert.deepEqual(findByClass(shuffled.tree, 'gym-diff-row'), []);
  assert.deepEqual(findByClass(shuffled.tree, 'gym-proposal-counted').map(textOf), ['3 changes']);
  assert.deepEqual(findByClass(shuffled.tree, 'gym-diff-more'), []);

  // A rename spends no card row either; the kicker and the summary above it already name the routine.
  const renamed = await coachCard(t, proposal({
    name: 'Push A · heavy',
    changeCount: 2,
    changes: [...retargets(1), { position: 2, kind: 'kept', exerciseId: 'chin-up', before: { sets: 3 }, after: { sets: 3 } }],
  }));
  assert.deepEqual(lines(renamed.tree).map((row) => row.props.className), ['gym-diff-row is-retargeted']);
  assert.deepEqual(findByClass(renamed.tree, 'gym-proposal-counted').map(textOf), ['2 changes']);

  // Behind Review the document is there, so both rows are drawn and both sentences are true.
  browserWith();
  proposalOnTheWire(proposal({ name: 'Push A · heavy', changeCount: 3, changes: kept }));
  const { DiffRow, ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  const dialog = renderHook(t, () => ProposalReview({ id: 'prop_1', log: quiet, onClose: () => {}, onSettled: () => {} }));
  await settle();
  const kinds = findByClass(dialogOf(dialog.tree).props.children, 'gym-diff-row').map((row) => row.props.className);
  assert.deepEqual(kinds, ['gym-diff-row is-renamed', 'gym-diff-row is-reordered', 'gym-diff-row is-kept-run']);
  // The sentence the card cannot say, said where the lines it points at are.
  assert.equal(textOf(DiffRow({ row: { kind: 'reordered' }, catalog: quiet.catalog })), 'Orderthe lines run in the order below');
});

test('ruled — a promise about Apply is spent once Apply has been taken or turned down: the settled Coach card keeps the door to the rows it counted and drops the promise', async (t) => {
  const settled = await coachCard(t, proposal({ state: 'applied', settledAt: 1_755_100_000_000, changeCount: 8, changes: retargets(8) }));
  assert.equal(lines(settled.tree).length, 3);
  assert.deepEqual(findByClass(settled.tree, 'gym-diff-more').map(textOf), ['+ 5 more']);
  // The card counts five rows it does not draw, so the way to them stands in every state — as it does
  // on both phones. The dialog behind it draws a settled proposal with no band.
  assert.equal(doorsIn(settled.tree).length, 1);
  assert.deepEqual(findByClass(settled.tree, 'gym-coach-proposal-note'), [], 'nothing to promise once it is decided');

  const pending = await coachCard(t, proposal({ changeCount: 8, changes: retargets(8) }));
  assert.equal(doorsIn(pending.tree).length, 1);
  assert.equal(findByClass(pending.tree, 'gym-coach-proposal-note').length, 1);
});

test('a removal reads as a removal on the Coach card, never as a count of the lines it takes', async (t) => {
  const removal = await coachCard(t, proposal({
    intent: 'remove',
    summary: '',
    changeCount: 4,
    changes: Array.from({ length: 4 }, (_, at) => ({ position: at + 1, kind: 'removed', exerciseId: `mv-${at}`, before: { sets: 3, reps: 8, weightKg: 60 } })),
  }));
  assert.deepEqual(findByClass(removal.tree, 'gym-proposal-counted').map(textOf), ['a removal']);
  // The routine is named twice above it already — in the kicker and in the summary — so the counted
  // phrase names nobody and reads in both intents.
  assert.deepEqual(findByClass(removal.tree, 'gym-proposal-line').map(textOf), ['A proposal to remove Push A.']);
  assert.equal(textOf(findByClass(removal.tree, 'gym-proposal-kicker')[0]), 'Proposal · Push Astill waiting');
});

// The routines home holds two of these at once — one opened from a standing card, one from the
// address — and Apply is described by the gate in its OWN band, never the other dialog's.
test('two review dialogs open together mint their own gate slots', async (t) => {
  browserWith();
  proposalOnTheWire(proposal());
  const { ProposalReview } = await loadScreen('products/gym/Proposals.jsx');
  const screen = renderHook(t, () => [
    ProposalReview({ id: 'prop_1', log: quiet, onClose: () => {}, onSettled: () => {} }),
    ProposalReview({ id: 'prop_1', log: quiet, onClose: () => {}, onSettled: () => {} }),
  ]);
  await settle();

  const slots = screen.tree.map((one) => {
    const drawn = elementsOf(one).find((each) => typeof each.type === 'function' && each.type.name === 'Dialog').props.footer({ seen: false });
    return {
      gate: findByClass(drawn, 'gym-proposal-gate')[0].props.id,
      describedBy: findByClass(drawn, 'gym-proposal-apply')[0].props['aria-describedby'],
    };
  });
  assert.equal(slots[0].describedBy, slots[0].gate);
  assert.equal(slots[1].describedBy, slots[1].gate);
  assert.notEqual(slots[0].gate, slots[1].gate);
});
