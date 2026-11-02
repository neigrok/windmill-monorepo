import { useEffect, useRef, useState } from 'react';
import { HeldDelete, completionOutcome, creationOutcome } from './acts.js';
import { SkillTree } from '../model/SkillTree.js';
import { UnlockRules } from '../model/UnlockRules.js';
import { LABELS } from './copy.js';

export class BoardActs {
  constructor(collaborators) {
    this.update(collaborators);
    this.held = null;
    this.pending = null;
  }

  update(collaborators) { this.collaborators = collaborators; }

  complete(id, door) {
    const c = this.collaborators;
    if (!c.active || !c.owner || !c.tree || !['swipe', 'key'].includes(door)) return;
    const tree = this.held ? this.held.projected(c.tree) : c.tree;
    if (UnlockRules.derive(tree, c.progress).get(id) !== 'available') return;
    const before = c.progress;
    const after = c.completeStep(id, { door: 'board', at: c.now() });
    const outcome = completionOutcome(tree, before, after, id);
    c.showToast(outcome.message, {
      surface: 'board', act: 'complete', reveal: outcome.reveal, holdMs: 6000,
      action: { label: LABELS.undo, run: () => {
        const current = this.collaborators;
        current.onQuiet();
        current.restoreStep(id, before);
        current.onReveal(id);
        current.track('roadmap_board_undo', { act: 'complete' });
      } },
    });
    c.track('roadmap_board_complete', { door });
  }

  create(request) {
    const c = this.collaborators;
    if (!c.active || !c.owner || !c.tree) return { ok: false };
    if (!c.session) {
      c.report('roadmap-board-create');
      return { ok: false };
    }
    let receipt;
    let outcome;
    try {
      const tree = this.held ? this.held.projected(c.tree) : c.tree;
      const nextTree = new SkillTree({ id: tree.id, title: tree.title, author: tree.author,
        nodes: [...tree.nodes, { ...request, prerequisites: [...request.prerequisites] }] });
      outcome = creationOutcome(nextTree, c.progress, c.query, request.id);
      receipt = c.session.dispatch({ kind: 'CreateNode', ...request }, { captureFailures: true });
    } catch {
      c.report('roadmap-board-create');
      return { ok: false };
    }
    if (!receipt) return { ok: false };
    if (outcome.filterCleared) c.setQuery(outcome.query);
    c.onReveal(outcome.reveal);
    c.showToast(outcome.message, {
      surface: 'board', act: 'create', reveal: outcome.reveal, holdMs: 6000,
      action: { label: LABELS.undo, run: () => {
        const current = this.collaborators;
        if (!c.session.revert(receipt)) return;
        current.onQuiet();
        current.track('roadmap_board_undo', { act: 'create' });
      } },
    });
    c.track('roadmap_board_create', { step: 'saved', column: outcome.column, filterCleared: outcome.filterCleared });
    return { ok: true };
  }

  deletePrompt(step) {
    if (step === 'confirm' || step === 'cancel') this.collaborators.track('roadmap_board_delete', { step });
  }

  delete(id) {
    const c = this.collaborators;
    if (!c.active || !c.owner || !c.tree?.nodesById.has(id)) return;
    this.release('replaced');
    const held = new HeldDelete([id], c.tree.nodesById.get(id).label);
    this.held = held;
    this.pending = { held, session: c.session };
    c.onHeld(held);
    c.showToast(held.message, {
      surface: 'board', act: 'delete', reveal: null, holdMs: 9000,
      onLeave: (via) => { if (this.held === held) this.release(via); },
      action: { label: LABELS.undo, run: () => {
        if (this.held !== held) return;
        this.held = null;
        this.pending = null;
        const current = this.collaborators;
        current.onQuiet();
        current.onHeld(null);
        current.onReveal(id);
        current.track('roadmap_board_undo', { act: 'delete' });
      } },
    });
    c.track('roadmap_board_delete', { step: 'held' });
  }

  release(via = 'left') {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.held = null;
    const c = this.collaborators;
    try {
      const receipt = pending.session?.dispatch({ kind: 'BulkDelete', nodeIds: pending.held.ids }, { captureFailures: true });
      if (!receipt) { c.onQuiet(); c.report('roadmap-board-delete'); }
      else c.track('roadmap_board_delete', { step: 'sent', via });
    } catch {
      c.onQuiet();
      c.report('roadmap-board-delete');
    }
    c.onHeld(null);
  }

  revealToast(toast) {
    if (!toast?.reveal || !['complete', 'create'].includes(toast.act)) return;
    const c = this.collaborators;
    const tree = this.held ? this.held.projected(c.tree) : c.tree;
    const step = tree?.nodesById.get(toast.reveal);
    if (!step) return;
    const query = c.query.revealing(step, tree);
    if (query !== c.query) c.setQuery(query);
    c.onReveal(toast.reveal);
    c.track('roadmap_board_toast_reveal', { act: toast.act });
  }
}

export function useBoardActs(collaborators) {
  const [held, setHeld] = useState(null);
  const controller = useRef(null);
  const args = { ...collaborators, onHeld: setHeld };
  if (!controller.current) controller.current = new BoardActs(args);
  controller.current.update(args);
  const acts = controller.current;
  useEffect(() => {
    if (collaborators.active && collaborators.owner) return;
    acts.release('left');
    collaborators.clearBoardToast?.();
  }, [acts, collaborators.active, collaborators.owner]);
  useEffect(() => () => acts.release('left'), [acts, collaborators.treeId]);
  useEffect(() => {
    const leave = () => {
      acts.release('left');
      acts.collaborators.clearBoardToast?.();
    };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); acts.release('left'); };
  }, [acts]);
  return { held, acts };
}
