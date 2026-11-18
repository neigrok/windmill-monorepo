// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';
import { CreateRoadmap, DeleteRoadmap, Roadmap } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { CreateStep, DeleteStep, RoadmapStep } from '../../../../src/products/roadmap/domain/steps.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { roadmapRegistry } from './vectors.js';

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
    assert.equal(await a.runner.undo(held.gestureId), true);
    assert.deepEqual(steps(a, tree), [basics]);
    const again = committed(await a.runner.runAct(new DeleteStep(tree, basics))).receipt;
    await a.advance(CONSTANTS.HOLD_MS);
    assert.equal(await a.runner.undo(again.gestureId), false);
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
    assert.equal(await a.runner.undo(held.gestureId), true);
    assert.deepEqual(a.drawn(Roadmap).map((roadmap) => roadmap.id.record), [tree]);
    const again = committed(await a.runner.runAct(new DeleteRoadmap(tree))).receipt;
    await a.advance(9000);
    assert.equal(await a.runner.undo(again.gestureId), false);
    assert.deepEqual(a.drawn(Roadmap), []);
  } finally {
    a.close();
  }
});

