// @ts-check
// A proposal's Apply beyond the shared cases and scenes, on the real engine: two tabs pressing Apply at once write it once,
// an engine started again between the act and its settling settles it applied, a large proposal travels as several
// intents under one Undo, two devices applying before they sync leave the later one's new step refused as taken, and a
// roadmap the device does not hold whole is refused and leaves the proposal pending.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { ActDecision } from '../../../../src/platform/domain-kit/acts.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../../src/platform/domain-kit/runner.js';
import { ProposalAbilities } from '../../../../src/products/roadmap/domain/abilities/proposals.js';
import { readReached } from '../../../../src/products/roadmap/domain/abilities/standing.js';
import { ApplyProposal, ApplyingRow, ProposalUndone, SettleApplying } from '../../../../src/products/roadmap/domain/apply.js';
import { CoachMessage, CoachProposal, CoachThread, MintProposal, OpenTurn } from '../../../../src/products/roadmap/domain/conversation.js';
import { RoadmapKind } from '../../../../src/products/roadmap/domain/kinds.js';
import { CreateRoadmap } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { RoadmapRefusals, RoadmapScopes, refusalForm } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { RoadmapStep } from '../../../../src/products/roadmap/domain/steps.js';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { roadmapRegistry } from './vectors.js';

/** @typedef {{ kind: string, result?: any, receipt?: any, refusal?: any }} Outcome */

// A roadmap of `steps` (`[key, label]`, each after the one before, `a` first), taken by the server, with a conversation
// about it whose Coach message can carry a proposal.
/** @param {Harness} phone @param {[string, string][]} steps */
async function roadmapOn(phone, steps) {
  const made = /** @type {any} */ (await phone.runner.runAct(new CreateRoadmap('Learn to sail', {
    steps: steps.map(([key, label]) => ({ key, label })), links: steps.slice(1).map(([key], index) => [steps[index]?.[0] ?? '', key]) })));
  const { tree, steps: ids } = made.result;
  for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) phone.observe(scope);
  await phone.sync();
  const turn = /** @type {any} */ (await phone.runner.runAct(new OpenTurn({ about: { treeId: tree }, question: 'What should I do next?' }))).result;
  return { tree, ids, turn };
}

// A proposal minted on `runner` as a turn mints one: the ability over the copy, then MintProposal.
/** @param {ActionRunner} runner @param {string} tree @param {any} turn @param {any[]} changes */
async function proposed(runner, tree, turn, changes) {
  const standing = /** @type {any} */ (await runner.runAct(/** @type {any} */ ({ refusals: RoadmapRefusals, load: (/** @type {any} */ read) => readReached(read, tree),
    decide: (/** @type {any} */ copy) => ActDecision.unchanged(copy) }))).result;
  /** @param {'coachProposal' | 'node' | 'kind'} type */
  const minted = (type) => String((type === 'coachProposal' ? runner.mint(CoachProposal)
    : type === 'node' ? runner.mint(RoadmapStep, RoadmapScopes.tree(tree)) : runner.mint(RoadmapKind, RoadmapScopes.tree(tree))).record);
  const answer = /** @type {any} */ (ProposalAbilities.propose_roadmap_change(standing, { treeId: tree, changes }, tree, minted));
  assert.ok(answer.proposal, JSON.stringify(answer.refused));
  const proposal = new Id(String(answer.result.proposalId), CoachProposal);
  const mint = /** @type {Outcome} */ (await runner.runAct(new MintProposal({ proposal, treeId: tree, thread: new Id(turn.thread, CoachThread),
    message: new Id(turn.coach, CoachMessage), changes: answer.proposal.changes, base: answer.proposal.base })));
  assert.equal(mint.kind, 'committed');
  return { proposal, changes: answer.proposal.changes };
}

/** @param {ActionRunner} runner @param {string} tree */
const labels = (runner, tree) => runner.read(RoadmapScopes.tree(tree), (read) => read.repository(RoadmapStep).all('drawn').map((step) => step.label).sort());
/** @param {ActionRunner} runner @param {Id<any>} proposal */
const recordOf = (runner, proposal) => runner.read(RoadmapScopes.account, (read) => {
  const found = read.repository(CoachProposal).find(proposal, 'drawn');
  return found && { state: found.state, undone: found.undone, applying: read.device(ApplyingRow.key(proposal)) !== null };
});

const open = () => Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });

test('two tabs pressing Apply at once write the proposal once: one tab\'s act, and the other finds its row or its state', async () => {
  const a = await open();
  /** @type {any} */
  let other = null;
  try {
    const { tree, ids, turn } = await roadmapOn(a, [['a', 'Leave the dock'], ['b', 'Tie a bowline']]);
    const { proposal } = await proposed(a.runner, tree, turn, [{ op: 'rename', nodeId: ids.b, label: 'Tie a bowline in the dark' }]);
    other = await BrowserSyncEngine.open(a.options);
    for (const scope of a.scopes) other.observe(scope);
    const tab = new ActionRunner(new EngineReplica(other), roadmapRegistry, a.world.zone);
    const [first, second] = /** @type {Outcome[]} */ (await Promise.all([a.runner.runAct(new ApplyProposal(proposal)), tab.runAct(new ApplyProposal(proposal))]));
    const settled = /** @type {Outcome[]} */ (await Promise.all([a.runner.runAct(new SettleApplying()), tab.runAct(new SettleApplying())]));
    other.close();
    // A tab opened after reads what the two wrote, from the device's store.
    other = await BrowserSyncEngine.open(a.options);
    for (const scope of a.scopes) other.observe(scope);
    const later = new ActionRunner(new EngineReplica(other), roadmapRegistry, a.world.zone);
    const gestures = new Set(other.device.activeReplica.entries().filter((/** @type {any} */ entry) => entry.scope === RoadmapScopes.tree(tree))
      .map((/** @type {any} */ entry) => entry.gestureId));
    assert.deepEqual({ kinds: [first?.kind, second?.kind].sort(), results: [first?.result, second?.result], settled: settled.map((each) => each.kind).sort(),
      labels: labels(later, tree), record: recordOf(later, proposal), gestures: gestures.size }, {
      kinds: ['committed', 'unchanged'], results: ['applied', 'applied'], settled: ['committed', 'unchanged'],
      labels: ['Leave the dock', 'Tie a bowline in the dark'], record: { state: 'applied', undone: false, applying: false }, gestures: 1,
    });
  } finally {
    other?.close();
    a.close();
  }
});

test('an engine started again between an Apply and its settling releases the act\'s hold, and the settle it runs makes the proposal applied', async () => {
  const a = await open();
  try {
    const { tree, ids, turn } = await roadmapOn(a, [['a', 'Leave the dock'], ['b', 'Tie a bowline'], ['c', 'Read the wind']]);
    const { proposal } = await proposed(a.runner, tree, turn, [{ op: 'rename', nodeId: ids.a, label: 'Cast off' }, { op: 'remove_step', nodeId: ids.b }]);
    const applied = /** @type {Outcome} */ (await a.runner.runAct(new ApplyProposal(proposal)));
    assert.notEqual(applied.receipt.releaseAt, null, 'an Apply that removes a step is held');
    await a.restart();
    const held = a.engine.device.activeReplica.entries().filter((/** @type {any} */ entry) => entry.state === 'held');
    const before = recordOf(a.runner, proposal);
    const settled = /** @type {Outcome} */ (await a.runner.runAct(new SettleApplying()));
    await a.sync();
    assert.deepEqual({ held: held.length, before, settled: [settled.kind, settled.result], after: recordOf(a.runner, proposal), labels: labels(a.runner, tree) }, {
      held: 0, before: { state: 'pending', undone: false, applying: true }, settled: ['committed', [proposal.record]],
      after: { state: 'applied', undone: false, applying: false }, labels: ['Cast off', 'Read the wind'],
    });
  } finally {
    a.close();
  }
});

test('a proposal too large for one intent travels as several, under one gesture, and its one Undo takes all of it back', async () => {
  const a = await open();
  try {
    // 260 links moved are 520 writes, past the 500 records an intent takes.
    const sources = Array.from({ length: 260 }, (_, index) => /** @type {[string, string]} */ ([`s${index}`, `Knot ${index}`]));
    const made = /** @type {any} */ (await a.runner.runAct(new CreateRoadmap('Learn to sail', {
      steps: /** @type {[string, string][]} */ ([...sources, ['n', 'Knead'], ['r', 'Rest']]).map(([key, label]) => ({ key, label })), links: sources.map(([key]) => [key, 'r']) })));
    const { tree, steps: ids } = made.result;
    for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) a.observe(scope);
    await a.sync();
    const turn = /** @type {any} */ (await a.runner.runAct(new OpenTurn({ about: { treeId: tree }, question: 'Tidy this?' }))).result;
    const { proposal } = await proposed(a.runner, tree, turn, [{ op: 'merge', nodeId: ids.n, removeId: ids.r }]);
    const applied = /** @type {Outcome} */ (await a.runner.runAct(new ApplyProposal(proposal)));
    await a.runner.runAct(new SettleApplying());
    const intents = a.engine.device.activeReplica.entries().filter((/** @type {any} */ entry) => entry.gestureId === applied.receipt.gestureId);
    const links = () => a.runner.read(RoadmapScopes.tree(tree), (read) => read.views.visible('drawn', 'edge').map((record) => String(/** @type {string[]} */ (record.id)[1])))
      .reduce((/** @type {Record<string, number>} */ count, to) => ({ ...count, [to]: (count[to] ?? 0) + 1 }), {});
    const appliedLinks = links();
    await a.advance(9000);
    await a.sync();
    const undone = await a.runner.undo(applied.receipt.undo);
    await a.sync();
    const structure = intents.filter((/** @type {any} */ entry) => entry.scope === RoadmapScopes.tree(tree)).length;
    assert.deepEqual({ several: structure > 1, appliedLinks, undone: undone.kind, settled: a.runner.inverseResult(/** @type {any} */ (undone).requestId).kind,
      links: links() }, { several: true, appliedLinks: { [ids.n]: 260 }, undone: 'pending', settled: 'settled', links: { [ids.r]: 260 } });
  } finally {
    a.close();
  }
});

test('two devices that apply one proposal before they sync leave each new step once, the creation of the device that sends second refused as taken', async () => {
  const a = await open();
  try {
    const { tree, ids, turn } = await roadmapOn(a, [['a', 'Leave the dock']]);
    const b = await a.device();
    const { proposal, changes } = await proposed(a.runner, tree, turn, [{ op: 'add_step', ref: 'new:jib', label: 'Raise the jib', prerequisites: [ids.a] }]);
    await a.sync();
    const outcomes = [];
    for (const phone of [b, a]) {
      outcomes.push((/** @type {Outcome} */ (await phone.runner.runAct(new ApplyProposal(proposal)))).kind);
      await phone.runner.runAct(new SettleApplying());
    }
    await a.sync();
    const notices = (/** @type {Harness} */ phone) => phone.notices(RoadmapRefusals, RoadmapScopes.tree(tree)).map((/** @type {any} */ notice) => refusalForm(notice.refusal));
    assert.deepEqual({ outcomes, labels: [labels(a.runner, tree), labels(b.runner, tree)], notices: [notices(a), notices(b)], record: recordOf(a.runner, proposal) }, {
      outcomes: ['committed', 'committed'], labels: [['Leave the dock', 'Raise the jib'], ['Leave the dock', 'Raise the jib']],
      notices: [[], [{ taken: { subject: { t: 'node', id: changes[0].nodeId }, path: 'notice' } }]],
      record: { state: 'applied', undone: false, applying: false },
    });
  } finally {
    a.close();
  }
});

test('a proposal about a roadmap the device does not hold whole is refused, and stays pending', async () => {
  const unread = { trees: [{ id: 't_0000000000000001', own: true, read: 'unread', meta: { title: 'Learn to sail' }, nodes: [{ id: 'a', label: 'Leave the dock' }] }],
    stamps: [] };
  const proposal = /** @type {any} */ ({ id: new Id('proposal0003', CoachProposal), treeId: 't_0000000000000001', state: 'pending', base: [], changes: [] });
  const found = { proposal, pending: proposal, applying: false, moment: /** @type {any} */ (null) };
  const decided = new ApplyProposal(found.proposal.id).decide({ found: /** @type {any} */ (found), standing: /** @type {any} */ (unread), note: /** @type {any} */ (null) });
  assert.deepEqual(decided.kind === 'refuse' ? refusalForm(decided.refusal) : decided.kind,
    { other: { code: 'roadmap-unavailable', subject: { t: 'tree', id: 't_0000000000000001' }, detail: null, path: 'predicted' } });
  assert.equal(new ProposalUndone(found.proposal.id, { kind: 'pending', localChanged: true }).outcome, 'undone');
});
