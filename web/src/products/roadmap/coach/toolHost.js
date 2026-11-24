// Roadmap Coach §6, INV-2: the tool host over the device's copy. A call is one synchronous task up to the room's door: it
// reads the standing roadmap as the room shows it now (D-2), decides through the ability, and hands the write at once to
// the room's own door, structure as the room's gesture through its session and a mark through its mark door. So no change
// the room shows comes between the check and the write, and the write is saved, sent, merged and refused as the person's
// own, the door deciding it again over the device's copy as it commits. The door then says what it wrote: a write it
// refused or could not store is `roadmap-not-ready`, one that changed nothing `no-change`, never a success. A write
// answers with its receipt (D-4), which carries its Undo.

import catalogFile from '../../../../../packages/api-contract/roadmap/catalog.json' with { type: 'json' };
import { Catalog, JsonSchema } from '../../../platform/domain-kit/abilities.js';
import { precondition } from '../../../platform/domain-kit/values.js';
import { track as trackEvent } from '../../../telemetry/beacon.js';
import { AbilityCodes, refusal } from '../domain/abilities/answers.js';
import { ReadAbilities } from '../domain/abilities/reads.js';
import { WriteAbilities } from '../domain/abilities/writes.js';
import { BoundaryFailure, reportRoadmapFailure } from '../reportFailure.js';

// The room's gesture each structure act of a direct write is, one for one (`ReplicaSession.actsOf`).
const GESTURES = Object.freeze({
  CreateStep: ({ step, prerequisites, id }) => ({ kind: 'CreateNode', id, ...step, prerequisites }),
  ChangeStep: ({ step, changes }) => ({ kind: 'EditNode', id: step, ...changes }),
  ChangePrerequisites: ({ step, add: [from] }) => ({ kind: 'AddEdge', from, to: step }),
});

// The status a mark puts on its step, and the one its Undo puts back.
const MARKS = Object.freeze({ Complete: { status: 'complete', back: 'none' }, Reset: { status: 'none', back: 'complete' } });

// What the door wrote of a direct write, and the code a call that wrote nothing is refused with.
const WROTE_NOTHING = Object.freeze({ refused: AbilityCodes.roadmapNotReady, unchanged: AbilityCodes.noChange });

// D-4: one direct write, for the conversation's receipt, and the means of its Undo, held in this process's memory: the
// room's receipt of a structure act (`act`), or the mark the step held before the write (`mark`).
export class WriteReceipt {
  constructor({ ability, treeId, nodeId, undo }) {
    this.ability = ability;
    this.treeId = treeId;
    this.nodeId = nodeId;
    this.undo = Object.freeze(undo);
    Object.freeze(this);
  }
}

// `session` is the room's session open on the conversation's roadmap (`ReplicaSession`), `standing` reads the standing
// roadmap as the room shows it now, and `about` is the roadmap the conversation is about, null for all of the person's.
export class RoadmapToolHost {
  constructor({ session, standing, about, catalog = new Catalog(catalogFile), abilities = { ...ReadAbilities, ...WriteAbilities },
    mint = () => session.mintStepId(), track = trackEvent, report = reportRoadmapFailure }) {
    this.session = session;
    this.standing = standing;
    this.about = about;
    this.catalog = catalog;
    this.abilities = abilities;
    this.mint = mint;
    this.track = track;
    this.report = report;
  }

  // One call of an ability the catalog runs on the copy: `{ answer, receipt }`, the answer as the model reads it (`result`
  // or `refused`) and, for a write that landed, its receipt. An input outside the ability's schema never reaches it. An
  // ability that throws reports once and throws on, judged (`BoundaryFailure`).
  async run(name, input) {
    const ability = this.catalog.ability(name);
    precondition(ability?.agent === 'runs' && Object.hasOwn(this.abilities, name), `the tool host runs ${name}`);
    let decided;
    try {
      decided = new JsonSchema(ability.input).fault(input) === null ? this.abilities[name](this.standing(), input, this.about, this.mint)
        : refusal(AbilityCodes.invalidInput);
    } catch (error) {
      this.report('roadmap-coach-ability', error, { ability: name });
      this.told(name, 'failed');
      throw new BoundaryFailure('a Coach ability threw', { cause: error });
    }
    if (!('writes' in decided)) {
      this.told(name, 'refused' in decided ? decided.refused.code : 'ok');
      return { answer: decided, receipt: null };
    }
    precondition(decided.writes.length === 1, 'a direct write is one act');
    const handed = this.handOver(decided.writes[0]);
    const landed = await handed.landing;
    if (landed !== 'written') {
      this.told(name, WROTE_NOTHING[landed]);
      return { answer: refusal(WROTE_NOTHING[landed], input.nodeId), receipt: null };
    }
    this.told(name, 'ok');
    const nodeId = decided.result.nodeId ?? input.nodeId;
    return { answer: { result: decided.result }, receipt: new WriteReceipt({ ability: name, treeId: input.treeId, nodeId, undo: handed.undo }) };
  }

  // One act handed to the room's door at once: a mark through its mark door, which answers its write once settled, and a
  // structure act as the room's own gesture through its session, whose receipt says what landed. `landing` is what the
  // door came to (`written`, `unchanged` or `refused`), and `undo` what the act's Undo takes.
  handOver({ action, input }) {
    precondition(input.tree === this.session.treeId, 'a direct write reaches the room open on its roadmap');
    const mark = MARKS[action];
    if (mark) return { undo: { mark: mark.back }, landing: this.marking(input.step, mark.status) };
    const receipt = this.session.dispatch(GESTURES[action](input));
    if (receipt === null) return { undo: null, landing: Promise.resolve('refused') };
    return { undo: { act: receipt }, landing: Promise.all([receipt.act, receipt.landed]).then(([act, results]) => wrote(act, results !== null)) };
  }

  // Takes back one direct write, answering whether it did: a structure act by the room's Undo of its receipt, which spares
  // what was written since, while the room's stack still holds it; a mark by marking the step back, which does not restore
  // a completion's first date.
  async undo(receipt) {
    const undone = 'act' in receipt.undo ? this.session.revert(receipt.undo.act) : await this.marking(receipt.nodeId, receipt.undo.mark) === 'written';
    this.track('roadmap_coach_write_undone', { ability: receipt.ability, outcome: undone ? 'undone' : 'unavailable' });
    return undone;
  }

  // A mark through the room's mark door, and what it came to once settled.
  marking(step, status) {
    const marked = this.session.markProgress(step, status);
    return marked === false ? Promise.resolve('refused') : marked.then(({ act, complete }) => wrote(act, complete));
  }

  // §13: each call the host ran, by the ability's catalog name and what it came to, a refusal by its code; no text, no id.
  told(name, outcome) {
    this.track('roadmap_coach_ability', { ability: name, outcome });
  }
}

// What the door came to: a write it took and stored, one that changed nothing, or one it refused or could not store.
function wrote(act, complete) {
  if (!complete) return 'refused';
  return act === null ? 'unchanged' : 'written';
}
