import { useEffect, useRef, useState } from 'react';
import { HeldDelete, StepSelection, completionOutcome, creationOutcome, countBucket, deletable, editGesture, recolorOutcome } from './acts.js';
import { SkillTree } from '../model/SkillTree.js';
import { UnlockRules } from '../model/UnlockRules.js';
import { LABELS } from './copy.js';
import { BoardQuery } from './Board.js';

export class BoardComposer {
  constructor({ gate, active, owner, view = 'board', detailId, composer, acts, onOpen }) {
    this.available = gate && owner && (active || view === 'tree');
    this.editable = gate && active && owner && view === 'board';
    this.view = view;
    this.detailId = detailId;
    this.composer = composer;
    this.acts = acts;
    this.onOpen = onOpen;
  }

  get shown() {
    if (!this.available) return null;
    if (this.composer?.view && this.composer.view !== this.view) return null;
    if (this.composer?.editing && !this.editable) return null;
    if (this.composer?.editing && this.composer.editing !== this.detailId) return null;
    return this.composer;
  }

  openEdit(id) {
    if (!this.editable || id === null || id !== this.detailId) return;
    this.onOpen({ door: 'detail', editing: id });
  }

  saveEdit(request) {
    if (!this.shown?.editing || request.id !== this.detailId) return { ok: false };
    return this.acts.edit(request);
  }
}

export class BoardActs {
  constructor(collaborators) {
    this.update(collaborators);
    this.held = null;
    this.pending = null;
  }

  update(collaborators) { this.collaborators = collaborators; }

  recolor(ids, hue) {
    const c = this.collaborators;
    if (!c.active || !c.owner || !c.tree) return { ok: false };
    const tree = this.held ? this.held.projected(c.tree) : c.tree;
    const selection = new StepSelection(ids.filter((id) => tree.nodesById.has(id)));
    if (selection.count === 0 || selection.sharedKind(tree) === hue) return { ok: true, changed: false };
    if (!c.session) {
      c.report('roadmap-board-recolor', new Error('Missing Board session'));
      return { ok: false };
    }
    let receipt;
    try {
      receipt = c.session.dispatch({ kind: 'BulkRecolor', nodeIds: selection.ids, color: hue }, { captureFailures: true });
    } catch (error) {
      c.report('roadmap-board-recolor', error);
      return { ok: false };
    }
    if (!receipt) return { ok: false };
    const outcome = recolorOutcome(selection.ids);
    c.showToast(outcome.message, {
      surface: 'board', act: 'recolor', reveal: null, holdMs: 6000,
      action: { label: LABELS.undo, run: () => {
        const current = this.collaborators;
        try {
          current.onQuiet();
          if (!c.session.revert(receipt)) return;
          current.track('roadmap_board_undo', { act: 'recolor' });
        } catch (error) {
          current.report('roadmap-board-recolor', error);
        }
      } },
    });
    c.track('roadmap_board_bulk', { step: 'recolor', count: countBucket(selection.count) });
    return { ok: true, changed: true };
  }

  edit(request) {
    const c = this.collaborators;
    if (!c.active || !c.owner || !c.tree) return { ok: false };
    const tree = this.held ? this.held.projected(c.tree) : c.tree;
    if (!tree.nodesById.has(request.id)) return { ok: false };
    const gesture = editGesture(tree, request);
    if (gesture === false) return { ok: false };
    if (!gesture) return { ok: true };
    if (!c.session) {
      c.report('roadmap-board-edit', new Error('Missing Board session'));
      return { ok: false };
    }
    let receipt;
    try {
      c.onQuiet();
      receipt = c.session.dispatch(gesture, { captureFailures: true });
    } catch (error) {
      c.report('roadmap-board-edit', error);
      return { ok: false };
    }
    if (!receipt) return { ok: false };
    if ('label' in gesture) {
      try {
        c.emit({ verb: 'renamed', nodeId: request.id, label: request.label, kind: request.color });
      } catch (error) {
        c.report('roadmap-board-edit', error);
      }
    }
    try {
      c.track('roadmap_board_edit', {
        step: 'saved', name: 'label' in gesture, description: 'description' in gesture,
        kind: 'color' in gesture, prerequisites: gesture.addPrerequisites.length > 0 || gesture.removePrerequisites.length > 0,
      });
    } catch (error) {
      c.report('roadmap-board-edit', error);
    }
    return { ok: true };
  }

  complete(id, door) {
    const c = this.collaborators;
    if (!c.active || !c.owner || !c.tree || !['swipe', 'key'].includes(door)) return false;
    const tree = this.held ? this.held.projected(c.tree) : c.tree;
    if (UnlockRules.derive(tree, c.progress).get(id) !== 'available') return false;
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
    return true;
  }

  create(request) {
    const c = this.collaborators;
    if ((!c.active && !c.graphActive) || !c.owner || !c.tree) return { ok: false };
    const graph = !c.active && c.graphActive;
    if (!c.session) {
      c.report('roadmap-board-create', new Error('Missing Board session'));
      return { ok: false };
    }
    let receipt;
    let outcome;
    try {
      const tree = this.held ? this.held.projected(c.tree) : c.tree;
      const nextTree = new SkillTree({ id: tree.id, title: tree.title, author: tree.author,
        nodes: [...tree.nodes, { ...request, prerequisites: [...request.prerequisites] }] });
      outcome = creationOutcome(nextTree, c.progress, graph ? new BoardQuery() : c.query, request.id);
      receipt = c.session.dispatch({ kind: 'CreateNode', ...request }, { captureFailures: true });
    } catch (error) {
      c.report('roadmap-board-create', error);
      return { ok: false };
    }
    if (!receipt) return { ok: false };
    if (outcome.filterCleared) c.setQuery(outcome.query);
    const reveal = graph ? c.onGraphReveal : c.onReveal;
    reveal(outcome.reveal);
    c.showToast(outcome.message, {
      surface: graph ? 'graph' : 'board', act: 'create', reveal: outcome.reveal, holdMs: 6000,
      ...(graph ? { focusTarget: c.graphFocusTarget } : {}),
      action: { label: LABELS.undo, run: () => {
        const current = this.collaborators;
        try {
          if (!c.session.revert(receipt)) return;
          current.onQuiet();
          if (graph) {
            current.track('roadmap_graph_toast', { act: 'create', step: 'undo' });
            return;
          }
          current.track('roadmap_board_undo', { act: 'create' });
        } catch (error) {
          current.report('roadmap-board-create', error);
        }
      } },
    });
    if (graph) c.track('roadmap_graph_toast', { act: 'create', step: 'shown' });
    c.track('roadmap_board_create', { step: 'saved', column: outcome.column, filterCleared: outcome.filterCleared });
    return { ok: true };
  }

  deletePrompt(step) {
    if (step === 'confirm' || step === 'cancel') this.collaborators.track('roadmap_board_delete', { step });
  }

  delete(ids, door = 'menu') {
    const c = this.collaborators;
    const selected = [...new Set(ids)];
    if (!c.active || !c.owner || !c.tree || !['menu', 'key', 'bulk'].includes(door)) return false;
    const tree = this.held ? this.held.projected(c.tree) : c.tree;
    if (!deletable(tree, selected)) return false;
    this.release('replaced');
    const held = new HeldDelete(selected, tree.nodesById.get(selected[0]).label);
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
        current.onReveal(selected[0]);
        current.track('roadmap_board_undo', { act: 'delete' });
      } },
    });
    c.track('roadmap_board_delete', { step: 'held', door });
    if (door === 'bulk') c.track('roadmap_board_bulk', { step: 'delete', count: countBucket(selected.length) });
    return true;
  }

  release(via = 'left') {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.held = null;
    const c = this.collaborators;
    try {
      if (!pending.session) throw new Error('Missing Board session');
      const receipt = pending.session.dispatch({ kind: 'BulkDelete', nodeIds: pending.held.ids, retireIncidentEdges: true }, { captureFailures: true });
      if (receipt) c.track('roadmap_board_delete', { step: 'sent', via });
      if (!receipt) c.onQuiet();
    } catch (error) {
      c.onQuiet();
      c.report('roadmap-board-delete', error);
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
