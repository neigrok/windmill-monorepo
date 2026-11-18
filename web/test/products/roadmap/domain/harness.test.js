// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';
import { CreateRoadmap, CreateSubtree, DeleteRoadmap, Roadmap, RoadmapMeta, SetVisibility } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { RoadmapKind } from '../../../../src/products/roadmap/domain/kinds.js';
import { ChangeStep, CreateStep, DeleteStep, RoadmapStep } from '../../../../src/products/roadmap/domain/steps.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { roadmapRegistry } from './vectors.js';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';

/** @param {import('../../../../src/platform/domain-kit/acts.js').ActOutcome<any, any>} outcome */
function committed(outcome) {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return /** @type {{ result: any, receipt: import('../../../../src/platform/domain-kit/acts.js').ActReceipt }} */ (outcome);
}

/** @param {Harness} phone @param {string} tree */
const steps = (phone, tree) => phone.drawn(RoadmapStep, RoadmapScopes.tree(tree)).map((step) => step.id.record);

test("a step's delete is held: Undo during the hold brings it back, and after the hold the delete stands", async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: null, scope: RoadmapScopes.account });
  try {
    const tree = committed(await a.runner.runAct(new CreateRoadmap('Learn Rust'))).result.tree;
    const basics = committed(await a.runner.runAct(new CreateStep(tree, { label: 'Basics' }))).result;
    assert.deepEqual(a.runner.read(RoadmapScopes.tree(tree), (read) => read.device(RoadmapScopes.landing(tree))), { nodes: [basics], edges: [], revived: [] });
    const held = committed(await a.runner.runAct(new DeleteStep(tree, basics))).receipt;
    assert.equal(held.releaseAt, a.world.now + CONSTANTS.HOLD_MS);
    assert.deepEqual(steps(a, tree), []);
    assert.deepEqual(a.stored(RoadmapStep, RoadmapScopes.tree(tree)).map((step) => step.id.record), [basics]);
    assert.equal(await a.runner.cancelHeld(held.gestureId), true);
    assert.deepEqual(steps(a, tree), [basics]);
    const again = committed(await a.runner.runAct(new DeleteStep(tree, basics))).receipt;
    await a.advance(CONSTANTS.HOLD_MS);
    assert.equal(await a.runner.cancelHeld(again.gestureId), false);
    assert.deepEqual(steps(a, tree), []);
  } finally {
    a.close();
  }
});

test("a roadmap's delete is held nine seconds with Undo, and stands once the hold ends", async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: null, scope: RoadmapScopes.account });
  try {
    const tree = committed(await a.runner.runAct(new CreateRoadmap('Learn Rust'))).result.tree;
    const held = committed(await a.runner.runAct(new DeleteRoadmap(tree))).receipt;
    assert.equal(held.releaseAt, a.world.now + 9000);
    assert.deepEqual(a.drawn(Roadmap), []);
    assert.equal(await a.runner.cancelHeld(held.gestureId), true);
    assert.deepEqual(a.drawn(Roadmap).map((roadmap) => roadmap.id.record), [tree]);
    const again = committed(await a.runner.runAct(new DeleteRoadmap(tree))).receipt;
    await a.advance(9000);
    assert.equal(await a.runner.cancelHeld(again.gestureId), false);
    assert.deepEqual(a.drawn(Roadmap), []);
  } finally {
    a.close();
  }
});


test('a subtree is made with no connection: its record, meta, kinds and branch are drawn at once, and a visibility reaches it', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: null, scope: RoadmapScopes.account });
  try {
    const tree = committed(await a.runner.runAct(new CreateRoadmap('Learn Rust'))).result.tree;
    const basics = committed(await a.runner.runAct(new CreateStep(tree, { label: 'Basics' }))).result;
    const subtree = committed(await a.runner.runAct(new CreateSubtree(tree, basics))).result.subtree;
    assert.deepEqual(a.drawn(Roadmap).map((roadmap) => [roadmap.id.record, roadmap.parent]).sort(), [[subtree, { tree, step: basics }], [tree, null]].sort());
    assert.deepEqual(a.drawn(RoadmapStep, RoadmapScopes.tree(tree)).map((step) => [step.id.record, step.branch]), [[basics, subtree]]);
    assert.deepEqual(a.drawn(RoadmapKind, RoadmapScopes.tree(subtree)).map((kind) => kind.id.record), ['build', 'learn', 'milestone']);
    const meta = () => a.drawn(RoadmapMeta, RoadmapScopes.tree(subtree)).map((value) => [value.root, value.depth, value.reach]);
    assert.deepEqual(meta(), [[tree, 1, 'private']]);
    committed(await a.runner.runAct(new SetVisibility(tree, 'public')));
    assert.deepEqual(meta(), [[tree, 1, 'public']]);
  } finally {
    a.close();
  }
});

// A model server with no roadmap binding: deltas admitted by the engine's own rules.
const unbound = { effects: () => ({ byScope: {} }) };

test('INV-1: a change to a step another device deleted is admitted, and the step is present on both devices', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: unbound, scope: RoadmapScopes.account });
  try {
    const tree = committed(await a.runner.runAct(new CreateRoadmap('Learn Rust'))).result.tree;
    const basics = committed(await a.runner.runAct(new CreateStep(tree, { label: 'Basics' }))).result;
    a.observe(RoadmapScopes.tree(tree));
    await a.sync();
    const b = await a.device();
    await a.sync();
    assert.deepEqual(steps(b, tree), [basics]);
    committed(await b.runner.runAct(new DeleteStep(tree, basics)));
    await a.advance(CONSTANTS.HOLD_MS);
    await b.senderStep();
    committed(await a.runner.runAct(new ChangeStep(tree, basics, { label: 'The basics' })));
    await a.sync();
    for (const phone of [a, b]) {
      assert.deepEqual(phone.drawn(RoadmapStep, RoadmapScopes.tree(tree)).map((step) => [step.id.record, step.label]), [[basics, 'The basics']]);
    }
    assert.deepEqual(a.runner.read(RoadmapScopes.tree(tree), (read) => read.device(RoadmapScopes.landing(tree))), { nodes: [basics], edges: [], revived: [] });
  } finally {
    a.close();
  }
});

// The model server with roadmap's binding (engine.md A.1): what the domain predicts is what the server writes.
test('a subtree made with no connection lands as the server plants it, and a visibility reaches it', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const tree = committed(await a.runner.runAct(new CreateRoadmap('Learn Rust'))).result.tree;
    const basics = committed(await a.runner.runAct(new CreateStep(tree, { label: 'Basics' }))).result;
    const subtree = committed(await a.runner.runAct(new CreateSubtree(tree, basics))).result.subtree;
    const drawn = () => ({
      roadmaps: a.drawn(Roadmap).map((roadmap) => [roadmap.id.record, roadmap.parent]).sort(),
      branch: a.drawn(RoadmapStep, RoadmapScopes.tree(tree)).map((step) => [step.id.record, step.branch]),
      meta: a.drawn(RoadmapMeta, RoadmapScopes.tree(subtree)).map((value) => [value.root, value.depth, value.reach]),
      kinds: a.drawn(RoadmapKind, RoadmapScopes.tree(subtree)).map((kind) => [kind.id.record, kind.hue, kind.label, kind.ord]),
    });
    const predicted = drawn();
    for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree), RoadmapScopes.tree(subtree)]) a.observe(scope);
    await a.sync();
    assert.deepEqual(drawn(), predicted);
    assert.equal(a.server.row(`tree:${subtree}`, 'meta', 'meta').f.depth[1].endsWith(':srv'), true);
    committed(await a.runner.runAct(new SetVisibility(tree, 'public')));
    await a.sync();
    assert.deepEqual(a.server.row(`tree:${subtree}`, 'meta', 'meta').f.reach[0], 'public');
    assert.deepEqual(drawn().meta, [[tree, 1, 'public']]);
  } finally {
    a.close();
  }
});

test('a step deleted on another device ends its subtree\'s standing, and a change made without knowing brings it back on both', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const tree = committed(await a.runner.runAct(new CreateRoadmap('Learn Rust'))).result.tree;
    const basics = committed(await a.runner.runAct(new CreateStep(tree, { label: 'Basics' }))).result;
    const subtree = committed(await a.runner.runAct(new CreateSubtree(tree, basics))).result.subtree;
    for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree), RoadmapScopes.tree(subtree)]) a.observe(scope);
    committed(await a.runner.runAct(new SetVisibility(tree, 'unlisted')));
    await a.sync();
    const b = await a.device();
    await a.sync();
    const reach = (phone) => phone.drawn(RoadmapMeta, RoadmapScopes.tree(subtree)).map((value) => value.reach);
    assert.deepEqual([reach(a), reach(b)], [['unlisted'], ['unlisted']]);
    committed(await b.runner.runAct(new DeleteStep(tree, basics)));
    await a.advance(CONSTANTS.HOLD_MS);
    await b.senderStep();
    assert.equal(a.server.row(`tree:${subtree}`, 'meta', 'meta').f.reach[0], 'private');
    committed(await a.runner.runAct(new ChangeStep(tree, basics, { label: 'The basics' })));
    await a.sync();
    assert.equal(a.server.row(`tree:${subtree}`, 'meta', 'meta').f.reach[0], 'unlisted');
    assert.deepEqual([reach(a), reach(b)], [['unlisted'], ['unlisted']]);
    assert.deepEqual(b.drawn(RoadmapStep, RoadmapScopes.tree(tree)).map((step) => [step.id.record, step.label, step.branch]), [[basics, 'The basics', subtree]]);
  } finally {
    a.close();
  }
});
