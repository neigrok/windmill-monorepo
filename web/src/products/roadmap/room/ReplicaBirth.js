// A roadmap's birth where the room reads the device's copy (roadmap-on-the-engine.md §5 Create a roadmap, Signed out): the
// domain's `CreateRoadmap` on the replica the engine holds active, so a roadmap made signed out lives in the browser's
// anon replica until a sign-in's lineage rule takes it to an account, and one made signed in in the account's replica,
// which the engine sends. A plan's legend of its own takes the genesis kinds' place, and the steps it brings done are
// then marked, its owner's marks. Nothing here asks the server, and the engine keeps no Undo of a birth.

import { ActionRunner, EngineReplica } from '../../../platform/domain-kit/runner.js';
import { syncSession } from '../../../platform/sync/session.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Complete } from '../domain/progress.js';
import { CreateRoadmap } from '../domain/roadmaps.js';
import { GENESIS_KINDS } from '../domain/roadmapRules.js';
import { DEVICE_ZONE, standingEngine } from './ReplicaReading.js';
import { importedStep } from './ReplicaSession.js';

export class ReplicaBirth {
  constructor({ session = syncSession, timers = globalThis } = {}) {
    this.session = session;
    this.timers = timers;
  }

  // Plants `plan` and answers the new roadmap's id and whether it lives in the anon replica (`local`). Throws, with no
  // words of the person's, where the copy did not open within the bound or the domain refused the plan.
  async plant(plan) {
    const { engine } = await standingEngine(this.session, new AbortController().signal, this.timers);
    if (!engine) throw new Error('the device’s copy did not open');
    const runner = new ActionRunner(new EngineReplica(engine), engine.registry, DEVICE_ZONE);
    const created = await runner.runAct(ReplicaBirth.creation(plan));
    if (created.kind !== 'committed') throw new Error(`the birth was ${created.kind}`);
    await runner.release(created.receipt.gestureId);
    const { tree, steps } = created.result;
    const done = plan.nodes.filter((node) => node.status === 'complete').map((node) => Complete(String(tree), steps[node.id]));
    if (done.length > 0) {
      const marked = await runner.runComposed(done);
      if (marked.kind !== 'committed') throw new Error(`the birth's marks were ${marked.kind}`);
      await runner.release(marked.receipt.gestureId);
    }
    return { treeId: String(tree), local: engine.getSnapshot().state !== 'bound' };
  }

  // The domain's creation of a plan as the blank birth, a pasted plan or a quest names it (`{ title, nodes, kinds }`):
  // its steps as the room's paste imports them, each after those it follows; and its legend, where it is not the
  // genesis kinds'.
  static creation({ title, nodes, kinds = [] }) {
    const steps = nodes.map(importedStep);
    const links = nodes.flatMap((node) => (node.prerequisites ?? []).map((from) => [from, node.id]));
    const legend = kinds.map(({ hue, label, description }) => ({ hue, label: label ?? '', description: description ?? '' }));
    const genesis = GENESIS_KINDS.map(({ hue, label, description }) => ({ hue, label, description }));
    return new CreateRoadmap(title, { steps, links }, legend.length === 0 || jcs(legend) === jcs(genesis) ? null : legend);
  }
}
