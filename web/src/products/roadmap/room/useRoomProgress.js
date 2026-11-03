import { useRef, useState } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { countBucket } from '../board/acts.js';
import { LABELS, completedStepsToast, completedToast } from '../board/copy.js';
import { COACHED_NODE_ID, DEMO_COPY } from '../demo/demoStage.js';
import { MilestoneLedger } from '../persistence/MilestoneLedger.js';
import { ReturnLedger } from '../persistence/ReturnLedger.js';
import { detectMilestones } from '../model/milestones.js';
import { advanceProgress, milestoneAnnouncement, progressChanges } from '../model/progress.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { markDoneTargets } from '../selection/bulkSelection.js';

const NO_PROGRESS = Object.freeze({ completed: new Set(), completedAt: {} });

// Every mark on a step, from any surface or any device: the room's progress, what it unlocked, the milestone it may have
// reached and the Graph toast that says so. The snapshot is always the freshest, so a held Undo never restores stale marks.
export class RoomProgress {
  constructor(collaborators) {
    this.update(collaborators);
    this.snapshot = NO_PROGRESS;
  }

  update(collaborators) { this.collaborators = collaborators; }

  commit(next) {
    this.snapshot = next;
    this.collaborators.onChange(next);
  }

  // A demo, a shared view or a demotion marks nothing that belongs to the reader.
  get ownMarks() {
    const { demo, shared, demotion, seedRef } = this.collaborators;
    return !demo && !shared && !demotion && Boolean(seedRef.current?.mine);
  }

  witness(next) {
    if (!this.ownMarks) return;
    const { seedRef, returnLedger } = this.collaborators;
    returnLedger.save(seedRef.current.id, { completed: [...next.completed], at: Date.now() });
  }

  push(nodeIds, wireStatus) {
    const { demo, sessionRef } = this.collaborators;
    if (!demo) sessionRef.current?.markProgress(nodeIds, wireStatus);
  }

  mark(ids, target, wire = ids, at = Date.now()) {
    const next = advanceProgress(this.snapshot, ids, target, at);
    this.commit(next);
    this.witness(next);
    this.push(wire, target);
    return next;
  }

  announceChanges(changes) {
    const { emit, treeRef } = this.collaborators;
    for (const [verb, ids] of [['completed', changes.completed], ['unlocked', changes.unlocked]]) {
      for (const id of ids) {
        const node = treeRef.current?.nodesById.get(id);
        emit({ verb, nodeId: id, label: node?.label, kind: node?.color }, { silent: true });
      }
    }
  }

  // Once ever per milestone: the ledger survives reloads and an undo and re-complete.
  milestoneOffer(before, after) {
    const { treeId, treeRef, milestoneLedger, openShare, track: trackEvent, band } = this.collaborators;
    if (!this.ownMarks || !treeRef.current) return null;
    const fresh = detectMilestones(treeRef.current, before, after).filter((milestone) => !milestoneLedger.has(treeId, milestone.id));
    const announcement = milestoneAnnouncement(fresh);
    if (!announcement) return null;
    for (const milestone of fresh) milestoneLedger.markOffered(treeId, milestone.id);
    return { summary: announcement.summary, action: { label: announcement.label, run: () => {
      trackEvent('roadmap_verb', { verb: 'share', door: 'ceremony', view: 'graph', band });
      openShare();
    } } };
  }

  // The detail says its outcome in place; Board acts and Graph completions own their Undo toast. `tree` is what the
  // caller is showing, which a held delete may have projected.
  complete(id, { quiet = false, door, at = Date.now(), tree } = {}) {
    const c = this.collaborators;
    const before = this.snapshot;
    const shown = tree ?? c.treeRef.current;
    const next = this.mark([id], 'complete', id, at);
    const changes = progressChanges(shown, before, next);
    this.announceChanges({ completed: [id], unlocked: changes.unlocked });
    if (quiet || door === 'board') return next;
    c.noteCompletion(id);
    const offer = this.milestoneOffer(before.completed, next.completed);
    if (offer) {
      c.sceneRef.current?.announceCeremony(offer.summary, { action: offer.action });
      return next;
    }
    const nodes = c.treeRef.current?.nodesById;
    const summary = c.demo && id === COACHED_NODE_ID
      ? DEMO_COPY.unlockToast
      : completedToast({ step: nodes?.get(id)?.label?.trim() || 'Step', unlocked: changes.unlocked.map((otherId) => nodes?.get(otherId)?.label || 'Step') });
    c.showToast(summary, {
      surface: 'graph', act: 'complete', holdMs: 6000, focusTarget: document.activeElement,
      action: { label: LABELS.undo, run: () => {
        const current = this.collaborators;
        try {
          this.restore(id, before);
          current.track('roadmap_graph_toast', { act: 'complete', step: 'undo' });
        } catch (error) {
          current.report('roadmap-step-restore', error);
        }
      } },
    });
    c.track('roadmap_graph_toast', { act: 'complete', step: 'shown' });
    return next;
  }

  markDone(selectedIds) {
    const targets = markDoneTargets(selectedIds, this.snapshot.completed);
    if (!targets.length) return;
    const before = this.snapshot;
    const next = this.mark(targets, 'complete');
    this.collaborators.track('roadmap_board_complete', { door: 'bulk', count: countBucket(targets.length) });
    this.announceChanges({ completed: targets, unlocked: progressChanges(this.collaborators.treeRef.current, before, next).unlocked });
    const offer = this.milestoneOffer(before.completed, next.completed);
    if (offer) this.collaborators.sceneRef.current?.announceCeremony(offer.summary, { action: offer.action });
  }

  reset(id) {
    if (id) this.mark([id], 'none', id);
  }

  // The step's mark goes back as it was, with no ceremony and no activity. Its completion time cannot: the progress lattice
  // dates every mark it sends, so an Undo of Reset completes the step at the Undo's time.
  restore(id, snapshot) {
    this.mark([id], snapshot.completed.has(id) ? 'complete' : 'none', id);
  }

  adoptLoaded(overlay) {
    const next = { completed: new Set(overlay.completed), completedAt: overlay.completedAt };
    this.commit(next);
    return next;
  }

  // A viewer keeps the owner's displayed progress; every owner surface adopts its private lane. Returns what to say about it.
  adoptRemote(overlay) {
    const tree = this.collaborators.treeRef.current;
    if (!this.ownMarks || !tree) return null;
    const next = { completed: new Set(overlay.completed), completedAt: overlay.completedAt };
    const changes = progressChanges(tree, this.snapshot, next);
    this.commit(next);
    this.witness(next);
    this.announceChanges(changes);
    if (changes.completed.length === 0) return null;
    if (changes.completed.length > 1) return completedStepsToast({ count: changes.completed.length, unlocked: changes.unlocked.length });
    return completedToast({
      step: tree.nodesById.get(changes.completed[0])?.label?.trim() || 'Step',
      unlocked: changes.unlocked.map((id) => tree.nodesById.get(id)?.label || 'Step'),
    });
  }
}

export function useRoomProgress(collaborators) {
  const [progress, setProgress] = useState(NO_PROGRESS);
  const [returnLedger] = useState(() => new ReturnLedger());
  const [milestoneLedger] = useState(() => new MilestoneLedger());
  const acts = useRef(null);
  const args = { track, report: reportRoadmapFailure, returnLedger, milestoneLedger, ...collaborators, onChange: setProgress };
  if (!acts.current) acts.current = new RoomProgress(args);
  acts.current.update(args);
  return { progress, progressActs: acts.current };
}
