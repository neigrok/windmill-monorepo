// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProbeProduct } from '../../../../packages/api-contract/sync/reference/probe/product.js';
import { ActDecision, ActPlan, ScopedPlan } from '../../../src/platform/domain-kit/acts.js';
import { Plan } from '../../../src/platform/domain-kit/plans.js';
import { Valid } from '../../../src/platform/domain-kit/validation.js';
import { Harness } from './harness.js';
import { PROBE_SCOPE, Probe, ProbeRefusals, probeValue } from './probe.js';
import { probeRegistry } from './vectors.js';

// §14.2: the harness syncs every scope a test names, so an act's intents in a tree it creates settle on the server
// and reach a second device.
test('an act over a product scope and the tree it creates settles on every device the harness syncs', async () => {
  const a = await Harness.open({ registry: probeRegistry, product: new ProbeProduct(), scope: PROBE_SCOPE });
  try {
    const tree = 'tree/b_00000002';
    const outcome = await a.runner.runAct({
      refusals: ProbeRefusals,
      load: (read) => {
        read.inScope(PROBE_SCOPE, () => null);
        return read.moment;
      },
      decide: (moment) => {
        const board = new Plan();
        board.create(new Valid(probeValue(Probe.board, 'b_00000002', {}), moment));
        const meta = new Plan();
        meta.update(new Valid(probeValue(Probe.meta, 'meta', { title: 'Child' }), moment), { fields: ['title'] });
        return ActDecision.write(new ActPlan([new ScopedPlan(PROBE_SCOPE, board), new ScopedPlan(tree, meta)]), null);
      },
    });
    assert.equal(outcome.kind, 'committed');
    a.observe(tree);
    await a.sync();
    const b = await a.device();
    await a.sync();
    assert.deepEqual(b.drawn(Probe.meta, tree).map((meta) => meta.fields()), [{ title: 'Child' }]);
    assert.deepEqual(a.engine.device.activeReplica.entries(), []);
  } finally {
    a.close();
  }
});
