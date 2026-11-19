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
import { reportRoadmapFailure, reportUnexpectedFailure } from '../reportFailure.js';
import { DEVICE_ZONE, standingEngine } from './ReplicaReading.js';
import { importedStep } from './ReplicaSession.js';

// What a birth on the device's copy came to, short of a roadmap that stands with every mark, in a bounded word: `unkept`
// where the browser's copy could not open, as in a browser that keeps nothing, `unopened` where it did not open within the
// bound, and `refused` where the domain refused the plan, as a name past its bound; each of these plants nothing. `marks`
// is a roadmap born whose done steps could not be marked. `unopened` and `marks` are ours to fix and report; `unkept` and
// `refused` are answers, which the platform and the domain already give.
export class BirthFailure extends Error {
  static REASONS = Object.freeze(['unkept', 'unopened', 'refused', 'marks']);
  static REPORTED = Object.freeze(['unopened', 'marks']);

  constructor(reason) {
    if (!BirthFailure.REASONS.includes(reason)) throw new TypeError('a birth fails for a reason BirthFailure.REASONS names');
    super('the birth on the device’s copy did not stand whole');
    this.name = 'BirthFailure';
    this.reason = reason;
  }

  // A birth that failed at its door, reported as the door reports it: a failure of ours with its reason as a tag, an
  // answer not at all, and anything else as any unexpected failure.
  static reportFailed(error, report = reportUnexpectedFailure) {
    if (!(error instanceof BirthFailure)) report('roadmap-plant', error);
    else if (BirthFailure.REPORTED.includes(error.reason)) report('roadmap-plant', error, { reason: error.reason });
  }

  // The reason the door's `roadmap_board_create` carries: a failed birth's, and none for a failure of another road.
  static reasonOf(error) {
    return error instanceof BirthFailure ? error.reason : undefined;
  }
}

export class ReplicaBirth {
  constructor({ session = syncSession, timers = globalThis, report = reportRoadmapFailure } = {}) {
    this.session = session;
    this.timers = timers;
    this.report = report;
  }

  // Plants `plan` and answers the new roadmap's id and whether it was born in the anon replica (`local`), once its creation
  // commits: what follows the creation cannot unmake it, so a failure there reports `marks` and the birth stands. Throws a
  // `BirthFailure`, with no words of the person's, where nothing was planted.
  async plant(plan) {
    const { engine, unshown } = await standingEngine(this.session, new AbortController().signal, this.timers);
    if (!engine) throw new BirthFailure(unshown);
    const local = engine.getSnapshot().state !== 'bound';
    const runner = new ActionRunner(new EngineReplica(engine), engine.registry, DEVICE_ZONE);
    const created = await runner.runAct(ReplicaBirth.creation(plan));
    if (created.kind !== 'committed') throw new BirthFailure('refused');
    const { tree, steps } = created.result;
    const done = plan.nodes.filter((node) => node.status === 'complete').map((node) => Complete(String(tree), steps[node.id]));
    try {
      await runner.release(created.receipt.gestureId);
      const marked = done.length === 0 ? null : await runner.runComposed(done);
      if (marked?.kind === 'committed') await runner.release(marked.receipt.gestureId);
      else if (marked !== null) this.report('roadmap-plant', new BirthFailure('marks'), { reason: 'marks' });
    } catch (error) {
      this.report('roadmap-plant', error, { reason: 'marks' });
    }
    return { treeId: String(tree), local };
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
