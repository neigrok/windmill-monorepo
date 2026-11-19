// The room's writes on the device's copy (roadmap-on-the-engine.md §5, §8.4): the slice of roadmap's own session that the
// room's write paths call, each write one of the domain's acts on the kit's runner, so every control, toast and event
// stays the room's own. A gesture made of several of the domain's acts runs them one after another, each loading what
// the one before it wrote, and its one receipt holds them all: its Undo takes back every one. The keyboard's Undo and
// Redo walk the room's own stack of those receipts (§5 Undo). It decides nothing: what a write is and what it refuses
// are the domain's.

import { Id } from '../../../platform/domain-kit/entities.js';
import { track as trackEvent } from '../../../telemetry/beacon.js';
import { REFUSED_CAPACITY } from '../copy.js';
import { t } from '../i18n/index.js';
import { InadmissibleGuide, admitsGuide } from '../guide/GuideDraft.js';
import { workspaceLink } from '../model/NodeWorkspace.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { ChangeKind, CreateKind, DeleteKind, RecolourKind } from '../domain/kinds.js';
import { ClearPointer, Complete, Reset, SetPointer } from '../domain/progress.js';
import { RoadmapChecks, RoadmapRefusals, RoadmapScopes } from '../domain/roadmapRules.js';
import { DeleteRoadmap, SetVisibility, WriteRoadmap } from '../domain/roadmaps.js';
import { HeldDeletion } from '../identity/HeldDeletion.js';
import { ChangePrerequisites, ChangeStep, CreateStep, DeleteStep, ImportSteps, MoveStep } from '../domain/steps.js';
import { AddStepLink, AddSubtask, ChangeSubtask, DeleteStepLink, DeleteSubtask, StepNote, StepNoteValue, Subtask } from '../domain/workspace.js';

// What the room says of a write the domain refused where it was made, in the words it says them today: a roadmap at its
// cap and a link that would close a loop. Any other refusal says nothing, as a write that found nothing to change.
function limitWords(refusal) {
  if (refusal.kind === 'full') return REFUSED_CAPACITY.title;
  if (refusal.kind === 'invalid' && refusal.violation.rule === RoadmapChecks.cycle) return t('roadmap.connect.loop');
  return null;
}

// A gesture as the room's stacks hold it: the ids of the acts it wrote, once they have.
class Written {
  constructor(acts) {
    this.acts = acts;
    Object.freeze(this);
  }
}

// A gesture taken back, as the Redo stack holds it: each act's Undo, in the order the acts were written.
class Undone {
  constructor(inverses) {
    this.inverses = inverses;
    Object.freeze(this);
  }
}

export class ReplicaSession {
  // `roadmap` reads the room's roadmap as the replica holds it now (`ReplicaRoadmap`); `say` shows the room's toast;
  // `onStatus` tells the room's status line that its receipts changed.
  constructor({ treeId, runner, roadmap, say, onStatus = () => {}, report = reportRoadmapFailure, track = trackEvent }) {
    this.treeId = treeId;
    this.runner = runner;
    this.roadmap = roadmap;
    this.say = say;
    this.onStatus = onStatus;
    this.report = report;
    this.track = track;
    this.ready = true;
    this.closed = false;
    this.receiptVersion = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.heldAct = null;
    this.workspace = new ReplicaWorkspace(this);
  }

  // Runs one write's acts in order and answers the receipts of those that wrote (`ids`, their act ids), and whether
  // every act was taken. A refusal ends it and is said, in the words the room says it today; a failure is reported under
  // the write's name and ends it.
  async write(acts, what) {
    const written = [];
    for (const act of acts) {
      let outcome;
      try {
        outcome = await this.runner.runAct(act);
      } catch (error) {
        this.report('roadmap-replica-write', error, { write: what });
        return { receipts: written, ids: written.map((receipt) => receipt.gestureId), complete: false };
      }
      if (outcome.kind === 'refused') {
        this.refused(outcome.refusal, what);
        return { receipts: written, ids: written.map((receipt) => receipt.gestureId), complete: false };
      }
      if (outcome.kind === 'committed') written.push(outcome.receipt);
    }
    return { receipts: written, ids: written.map((receipt) => receipt.gestureId), complete: true };
  }

  refused(refusal, what) {
    this.track('roadmap_write_refused', { write: what, refusal: refusal.kind });
    const words = limitWords(refusal);
    if (words) this.say(words, { act: 'notice' });
  }

  // A write no stack holds: its acts' Undo is never asked, so the engine keeps nothing of them.
  async settle(acts, what) {
    const written = await this.write(acts, what);
    await this.release(written.ids);
    return written;
  }

  async release(actIds) {
    for (const id of actIds) {
      try {
        await this.runner.release(id);
      } catch (error) {
        this.report('roadmap-replica-write', error, { write: 'release' });
      }
    }
  }

  // One of the room's gestures as the domain's acts, written one after another; its receipt is on the Undo stack at once,
  // and its Undo waits for them to be written. A gesture none of the acts applies to is null, as today.
  dispatch(gesture) {
    const acts = this.actsOf(gesture);
    if (acts.length === 0) return null;
    const receipt = new Written(this.write(acts, gesture.kind).then((written) => written.ids));
    this.undoStack.push(receipt);
    this.dropRedo();
    return receipt;
  }

  // The domain's acts that make one of the room's gestures, in the order they run. A gesture on several steps is the act
  // on each in turn; links to remove are each step's prerequisites, one act a step; a paste's new kinds follow its steps,
  // whose colours name their hues.
  actsOf(gesture) {
    const tree = this.treeId;
    const fields = (names) => Object.fromEntries(names.filter((name) => name in gesture).map((name) => [name, gesture[name]]));
    const unlinking = (links) => [...new Set(links.map((link) => link.to))]
      .map((to) => new ChangePrerequisites(tree, to, { remove: links.filter((link) => link.to === to).map((link) => link.from) }));
    switch (gesture.kind) {
      case 'CreateNode': return [new CreateStep(tree, { label: gesture.label ?? '', icon: gesture.icon ?? '', color: gesture.color ?? 'terracotta',
        ...(gesture.description ? { description: gesture.description } : {}) }, gesture.prerequisites ?? (gesture.parentId ? [gesture.parentId] : []), gesture.id)];
      case 'RenameNode':
      case 'DescribeNode':
      case 'SetNodeColor': return [new ChangeStep(tree, gesture.id, fields(['label', 'description', 'color']))];
      case 'EditNode': {
        const changes = fields(['label', 'description', 'color']);
        const prerequisites = { add: gesture.addPrerequisites ?? [], remove: gesture.removePrerequisites ?? [] };
        return [
          ...(Object.keys(changes).length ? [new ChangeStep(tree, gesture.id, changes)] : []),
          ...(prerequisites.add.length || prerequisites.remove.length ? [new ChangePrerequisites(tree, gesture.id, prerequisites)] : []),
        ];
      }
      case 'SetNodeOrder': return [new MoveStep(tree, gesture.id, gesture.below, gesture.siblings)];
      case 'AddEdge': return [new ChangePrerequisites(tree, gesture.to, { add: [gesture.from] })];
      case 'RemoveEdge': return unlinking([gesture]);
      case 'ReconnectEdge': return gesture.oldTo === gesture.newTo
        ? [new ChangePrerequisites(tree, gesture.newTo, { add: [gesture.newFrom], remove: [gesture.oldFrom] })]
        : [...unlinking([{ from: gesture.oldFrom, to: gesture.oldTo }]), new ChangePrerequisites(tree, gesture.newTo, { add: [gesture.newFrom] })];
      case 'DeleteNode': return [new DeleteStep(tree, gesture.id)];
      case 'BulkDelete': {
        const doomed = new Set(gesture.nodeIds);
        return [...gesture.nodeIds.map((id) => new DeleteStep(tree, id)),
          ...unlinking((gesture.edges ?? []).filter((link) => !doomed.has(link.from) && !doomed.has(link.to)))];
      }
      case 'BulkRecolor': return gesture.nodeIds.map((id) => new ChangeStep(tree, id, { color: gesture.color }));
      case 'ImportSubgraph': {
        const keys = new Set(gesture.nodes.map((step) => step.id));
        const imported = {
          steps: gesture.nodes.map((step) => ({ key: step.id, label: step.label ?? '', icon: step.icon ?? '', color: step.color ?? 'terracotta',
            ...(step.description ? { description: step.description } : {}), ...(step.links?.length ? { links: step.links } : {}) })),
          links: gesture.edges.filter((link) => keys.has(link.from)).map((link) => [link.from, link.to]),
        };
        return [new ImportSteps(tree, imported, gesture.edges.find((link) => !keys.has(link.from))?.from ?? null),
          ...(gesture.kinds ?? []).map((kind) => new CreateKind(tree, { hue: kind.hue, label: kind.label ?? '', description: kind.description ?? '' }))];
      }
      case 'SetNodeTree': return [gesture.opens ? SetPointer(tree, gesture.id, gesture.opens) : ClearPointer(tree, gesture.id)];
      case 'AddKind': return [new CreateKind(tree, { hue: gesture.hue })];
      case 'RenameKind':
      case 'DescribeKind': return [new ChangeKind(tree, gesture.id, fields(['label', 'description']))];
      case 'RecolorKind': return [new RecolourKind(tree, gesture.id, gesture.hue)];
      case 'RemoveKind': return [new DeleteKind(tree, gesture.id)];
      default: return [];
    }
  }

  // The owner's marks: each step's Complete or Reset. A step whose pointer opens a standing roadmap is read so from the
  // account, as the domain asks of its caller.
  markProgress(nodeIds, status) {
    const roadmap = this.roadmap();
    const opening = new Map(roadmap.account.openingsOf(this.treeId).map((each) => [each.node, each]));
    const opensStanding = (id) => opening.get(id)?.kind === 'pointer' && roadmap.account.locate(opening.get(id).tree).standing === 'standing';
    const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    this.settle(ids.map((id) => (status === 'complete' ? Complete(this.treeId, id, { opensStanding: opensStanding(id) }) : Reset(this.treeId, id))), 'mark');
  }

  // A roadmap's name, out of the Undo stack as a rename is today. A subtree's name is its owning step's label, so a
  // subtree is renamed there.
  renameTree(title) {
    const next = title.trim();
    if (next) this.renameRoadmap(this.treeId, next);
    return true;
  }

  // Any roadmap of the account renamed, answering whether the name landed.
  async renameRoadmap(id, title) {
    const parent = this.roadmap().account.locate(id).place?.parent ?? null;
    const act = parent === null ? new WriteRoadmap(id, { title }) : new ChangeStep(parent.tree, parent.step, { label: title });
    const { complete } = await this.settle([act], 'title');
    return complete;
  }

  // A root's deletion, held nine seconds and permanent once the hold ends (R-7), out of the Undo stack: its one Undo is
  // `undeleteRoadmap` within the hold. Answers the deletion while it is held, null where the roadmap was gone already;
  // throws where it was not written.
  async deleteRoadmap(id) {
    const { receipts, complete } = await this.write([new DeleteRoadmap(id)], 'deleteRoadmap');
    if (!complete) throw new Error('The roadmap was not deleted');
    const [held] = receipts;
    return held ? new HeldDeletion({ treeId: id, actId: held.gestureId, releaseAt: held.releaseAt }) : null;
  }

  // Answers whether the deletion was taken back: only while every entry of it is still held.
  async undeleteRoadmap(deletion) {
    try {
      return await this.runner.cancelHeld(deletion.actId);
    } catch (error) {
      this.report('roadmap-replica-write', error, { write: 'undeleteRoadmap' });
      return false;
    }
  }

  // The guide, out of the Undo stack as today. Text a guide may not hold never reaches the replica.
  setGuide(guide) {
    if (!admitsGuide(guide)) throw new InadmissibleGuide();
    this.settle([new WriteRoadmap(this.treeId, { guide })], 'guide');
    return true;
  }

  // A root's visibility, settled before the share dialog says so; a write that did not land throws, as a refused
  // request does.
  async setVisibility(visibility) {
    const { complete } = await this.settle([new SetVisibility(this.treeId, visibility)], 'visibility');
    if (!complete) throw new Error('The visibility was not written');
  }

  // A held delete is the last act though nothing is written yet: the next Undo takes it back.
  holdAct(cancel) {
    this.heldAct = cancel;
  }

  endHeldAct() {
    this.heldAct = null;
  }

  // The last gesture on the stack, taken back act by act, last act first; it waits on the Redo stack.
  undo() {
    if (this.heldAct) {
      this.heldAct();
      return;
    }
    const done = this.undoStack.pop();
    if (!done) return;
    this.bump();
    this.redoStack.push(new Undone(this.inverse(done)));
  }

  redo() {
    const undone = this.redoStack.pop();
    if (!undone) return;
    this.bump();
    this.undoStack.push(new Written(this.reapply(undone)));
  }

  // Takes back what the receipt wrote, leaving alone anything written since, and drops it from the stack; Redo cannot
  // bring it back.
  revert(receipt) {
    const index = this.undoStack.indexOf(receipt);
    if (index === -1) return false;
    this.undoStack.splice(index, 1);
    this.dropRedo();
    this.inverse(receipt).then((inverses) => this.release(inverses.map((inverse) => inverse.inverseActId)));
    return true;
  }

  async inverse(done) {
    const acts = await done.acts;
    const inverses = [];
    for (const id of [...acts].reverse()) {
      try {
        const result = await this.runner.undo(id);
        if (result.kind !== 'unavailable') inverses.unshift(result);
      } catch (error) {
        this.report('roadmap-replica-write', error, { write: 'undo' });
      }
    }
    await this.release(acts);
    return inverses;
  }

  async reapply(undone) {
    const inverses = await undone.inverses;
    const acts = [];
    for (const inverse of inverses) {
      try {
        const result = await this.runner.redo(inverse.requestId);
        if (result.kind !== 'unavailable') acts.push(result.inverseActId);
      } catch (error) {
        this.report('roadmap-replica-write', error, { write: 'redo' });
      }
    }
    await this.release(inverses.map((inverse) => inverse.inverseActId));
    return acts;
  }

  dropRedo() {
    const dropped = this.redoStack.splice(0);
    for (const undone of dropped) undone.inverses.then((inverses) => this.release(inverses.map((inverse) => inverse.inverseActId)));
  }

  bump() {
    this.receiptVersion += 1;
    this.onStatus();
  }

  // Every step the roadmap holds, present or deleted, so a new step never takes one's id.
  knownNodeIds() {
    return this.roadmap().account.trees.get(this.treeId)?.nodes.map((step) => step.id) ?? [];
  }

  // The roadmap as the room's tree data, as the replica holds it now.
  treeData() {
    return this.roadmap().seed;
  }

  // The engine keeps what was written in the device's store; nothing waits on the page to flush.
  leavePage() {}

  close() {
    this.closed = true;
    this.ready = false;
    this.heldAct = null;
    for (const done of this.undoStack.splice(0)) done.acts.then((acts) => this.release(acts));
    this.dropRedo();
  }
}

// The owner's workspace of a step on the device's copy (R-3): subtasks and links by the domain's actions, and the note
// through the kit's one draft of it, saved in place. Nothing here enters the Undo stack, as nothing of the workspace
// does today.
export class ReplicaWorkspace {
  constructor(session) {
    this.session = session;
    this.notes = new Map();
  }

  get treeId() { return this.session.treeId; }

  addSubtask(step, label) {
    const text = label.trim();
    if (text) this.session.settle([AddSubtask(this.treeId, step, text)], 'workspace');
  }

  toggleSubtask(step, subtask) {
    const scope = RoadmapScopes.overlay(this.treeId);
    const held = this.session.runner.read(scope, (read) => read.repository(Subtask).find(new Id(subtask, Subtask), 'drawn'));
    if (held) this.session.settle([ChangeSubtask(this.treeId, subtask, { done: !held.done })], 'workspace');
  }

  editSubtask(step, subtask, label) {
    const text = label.trim();
    if (text) this.session.settle([ChangeSubtask(this.treeId, subtask, { label: text })], 'workspace');
  }

  deleteSubtask(step, subtask) {
    this.session.settle([DeleteSubtask(this.treeId, subtask)], 'workspace');
  }

  // A link as the room reads an address today, its title the person's own words where they gave any.
  addLink(step, value) {
    const link = workspaceLink(value);
    if (link) this.session.settle([AddStepLink(this.treeId, step, { url: link.url, title: link.title })], 'workspace');
  }

  deleteLink(step, link) {
    this.session.settle([DeleteStepLink(this.treeId, link)], 'workspace');
  }

  // The step's one note draft, opened again while it holds nothing unsaved so it starts from what the replica holds.
  async setNote(step, text) {
    const scope = RoadmapScopes.overlay(this.treeId);
    const id = new Id(step, StepNote);
    const held = this.notes.get(step);
    const open = held?.isDirty ? held : this.session.runner.openOrNew(StepNote, id, new StepNoteValue(id), scope);
    const draft = open.edit((note) => new StepNoteValue(note.id, text));
    this.notes.set(step, draft);
    const { result, draft: after } = await this.session.runner.save(draft, RoadmapRefusals, scope);
    if (this.notes.get(step) === draft) this.notes.set(step, after);
    if (result.kind === 'failed') this.session.report('roadmap-replica-write', result.error, { write: 'note' });
    if (result.kind === 'refused') this.session.refused(result.refusal, 'note');
    if (result.kind === 'saved' && result.receipt) await this.session.release([result.receipt.gestureId]);
  }
}
