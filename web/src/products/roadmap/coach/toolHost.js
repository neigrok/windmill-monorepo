// Roadmap Coach §6, INV-2: the tool host over the device's copy. A call is one synchronous task up to the room's door: it
// reads the standing roadmap as the room shows it now (D-2), decides through the ability, and hands the write at once to
// the room's own door, structure as the room's gesture through its session and a mark through its mark door. So no change
// the room shows comes between the check and the write, and the write is saved, sent, merged and refused as the person's
// own, the door deciding it again over the device's copy as it commits. The door then says what it wrote: a write it
// refused or could not store is `roadmap-not-ready`, one that changed nothing `no-change`, never a success, and such a
// write leaves nothing to undo. A write answers with its receipt (D-4), which carries its Undo.
//
// A call tells no product event and reports nothing itself: the turn's engine tells each call it runs
// (`roadmap_coach_ability`), a direct write's one product event, and reports, once, anything that throws out of one, as it
// does for gym's Coach (§13). A write the door wrote tells the room's Activity the row the room's Board tells of the same
// change (R-7). An Undo runs outside a turn, so the host tells what each came to (`roadmap_coach_write_undone`).

import catalogFile from '../../../../../packages/api-contract/roadmap/catalog.json' with { type: 'json' };
import { Catalog, JsonSchema } from '../../../platform/domain-kit/abilities.js';
import { precondition } from '../../../platform/domain-kit/values.js';
import { track as trackEvent } from '../../../telemetry/beacon.js';
import { AbilityCodes, refusal } from '../domain/abilities/answers.js';
import { ReadAbilities } from '../domain/abilities/reads.js';
import { StandingRoadmaps } from '../domain/abilities/standing.js';
import { WriteAbilities } from '../domain/abilities/writes.js';
import { inverseOutcome } from '../room/ReplicaSession.js';

// The room's gesture each structure act of a direct write is, one for one (`ReplicaSession.actsOf`).
const GESTURES = Object.freeze({
  CreateStep: ({ step, prerequisites, id }) => ({ kind: 'CreateNode', id, ...step, prerequisites }),
  ChangeStep: ({ step, changes }) => ({ kind: 'EditNode', id: step, ...changes }),
  ChangePrerequisites: ({ step, add: [from] }) => ({ kind: 'AddEdge', from, to: step }),
});

// The status each mark puts on its step.
const MARKS = Object.freeze({ Complete: 'complete', Reset: 'none' });

// The code a write the door wrote nothing of is refused with: one it refused at its commit, or did not store, and one in
// which the domain found nothing to change.
const WROTE_NOTHING = Object.freeze({ refused: AbilityCodes.roadmapNotReady, unchanged: AbilityCodes.noChange });

// What an Undo came to, once the engine has settled it, as the host tells it: the room's `applied` is the write undone.
const UNDONE = Object.freeze({ applied: 'undone', skipped: 'skipped', unavailable: 'unavailable' });

// D-4: one direct write, for the conversation's receipt, and the room's receipt of its act (`room`), through which its
// Undo goes, held in this process's memory.
export class WriteReceipt {
  constructor({ ability, treeId, nodeId, room }) {
    this.ability = ability;
    this.treeId = treeId;
    this.nodeId = nodeId;
    this.room = room;
    Object.freeze(this);
  }
}

// `session` is the room's session open on the conversation's roadmap (`ReplicaSession`), `standing` reads the standing
// roadmap as the room shows it now, `activity` is the room's Activity (`useActivity`'s `emit`), and `about` is the roadmap
// the conversation is about, null for all of the person's.
export class RoadmapToolHost {
  constructor({ session, standing, activity, about, catalog = new Catalog(catalogFile), abilities = { ...ReadAbilities, ...WriteAbilities },
    mint = () => session.mintStepId(), track = trackEvent }) {
    this.session = session;
    this.standing = standing;
    this.activity = activity;
    this.about = about;
    this.catalog = catalog;
    this.abilities = abilities;
    this.mint = mint;
    this.track = track;
  }

  // One call of an ability the catalog runs on the copy: `{ answer, receipt }`, the answer as the model reads it (`result`
  // or `refused`) and, for a write that landed, its receipt. An input outside the ability's schema never reaches it.
  // Whatever throws in the call, reading the standing roadmap, the ability or the room's door, throws out of it.
  async run(name, input) {
    const ability = this.catalog.ability(name);
    precondition(ability?.agent === 'runs' && Object.hasOwn(this.abilities, name), `the tool host runs ${name}`);
    if (new JsonSchema(ability.input).fault(input) !== null) return { answer: refusal(AbilityCodes.invalidInput), receipt: null };
    const standing = this.standing();
    const decided = this.abilities[name](standing, input, this.about, this.mint);
    if (!('writes' in decided)) return { answer: decided, receipt: null };
    precondition(decided.writes.length === 1, 'a direct write is one act');
    const room = this.handOver(decided.writes[0]);
    const landed = room === null ? 'refused' : await landing(room);
    if (landed !== 'written') {
      if (room !== null) this.session.forget(room);
      return { answer: refusal(WROTE_NOTHING[landed], input.nodeId), receipt: null };
    }
    this.tellActivity(name, input, standing);
    const nodeId = decided.result.nodeId ?? input.nodeId;
    return { answer: { result: decided.result }, receipt: new WriteReceipt({ ability: name, treeId: input.treeId, nodeId, room }) };
  }

  // R-7: the Activity row the room's Board tells of the same change, the person's own and told silently, as the person is
  // in the conversation, not on the canvas. Of the direct writes only a new name has one, in the step's hue: the Board
  // tells none of a step's words, a new step or a link, and a mark's rows come as the room adopts the copy's marks.
  tellActivity(name, input, standing) {
    if (name !== 'rename_node') return;
    const { roadmap } = StandingRoadmaps.of(standing).open(input.treeId, this.about);
    this.activity({ verb: 'renamed', nodeId: input.nodeId, label: input.label, kind: roadmap.shown(input.nodeId).color }, { silent: true });
  }

  // One act handed to the room's door at once, answering the room's receipt of it, or null where the door refused it at
  // once: a mark through its mark door, which keeps its Undo for this receipt, and a structure act as the room's own
  // gesture through its session, on the room's Undo stack.
  handOver({ action, input }) {
    precondition(input.tree === this.session.treeId, 'a direct write reaches the room open on its roadmap');
    const status = MARKS[action];
    if (status) return this.session.markUndoably(input.step, status);
    return this.session.dispatch(GESTURES[action](input));
  }

  // Takes back one direct write by the room's Undo of its act, which spares anything written since: a structure act, and
  // a mark, which is put back unless the person has marked the step since; a completion's first date is not restored.
  // Answers, once the engine has settled the Undo, which waits for the server where the server settles it, what it came
  // to: `undone`, `skipped` where a later write stood in its way, or `unavailable` where the room no longer holds it.
  async undo(receipt) {
    const asked = this.session.revert(receipt.room);
    const outcome = UNDONE[asked === false ? 'unavailable' : inverseOutcome(await asked)];
    this.track('roadmap_coach_write_undone', { ability: receipt.ability, outcome });
    return outcome;
  }
}

// What the door wrote of a receipt's act: `written`, `unchanged` where the domain found nothing to change, or `refused`
// where it refused the act at its commit or its store did not take it.
async function landing(room) {
  const [act, results] = await Promise.all([room.act, room.landed]);
  if (results === null) return 'refused';
  return act === null ? 'unchanged' : 'written';
}
