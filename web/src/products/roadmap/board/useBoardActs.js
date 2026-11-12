import { useEffect, useRef, useState } from 'react';
import { HeldDelete, StepSelection, completionOutcome, creationOutcome, countBucket, deletable, editGesture, receiptUndo, recolorOutcome } from './acts.js';
import { sharedKind } from '../model/bulkSelection.js';
import { SkillTree } from '../model/SkillTree.js';
import { UnlockRules, takesMark } from '../model/UnlockRules.js';
import { LABELS, SAVE_FAILURE, TREE, deleteFailedToast, treeBand } from '../copy.js';
import { BoardQuery } from './Board.js';

export class BoardComposer {
  constructor({ owner, view = 'board', detailId, composer, acts, onOpen }) {
    this.available = owner;
    this.editable = this.available && detailId != null;
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
    if (selection.count === 0 || sharedKind(tree, selection.ids) === hue) return { ok: true, changed: false };
    if (!c.session) {
      c.report('roadmap-board-recolor', new Error('Missing Board session'));
      return { ok: false };
    }
    let receipt;
    try {
      receipt = c.session.dispatch({ kind: 'BulkRecolor', nodeIds: selection.ids, color: hue });
    } catch (error) {
      c.report('roadmap-board-recolor', error);
      return { ok: false };
    }
    if (!receipt) return { ok: false };
    const outcome = recolorOutcome(selection.ids);
    c.showToast(outcome.message, {
      surface: 'board', act: 'recolor', reveal: null, holdMs: 6000,
      action: receiptUndo({
        session: c.session, receipt,
        before: () => this.collaborators.onQuiet(),
        onReverted: () => this.collaborators.track('roadmap_board_undo', { act: 'recolor' }),
        onFailure: (error) => this.collaborators.report('roadmap-board-recolor', error),
      }),
    });
    c.track('roadmap_board_bulk', { step: 'recolor', count: countBucket(selection.count) });
    return { ok: true, changed: true };
  }

  edit(request) {
    const c = this.collaborators;
    if ((!c.active && !c.graphActive) || !c.owner || !c.tree) return { ok: false };
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
      receipt = c.session.dispatch(gesture);
    } catch (error) {
      c.report('roadmap-board-edit', error);
      return { ok: false };
    }
    if (!receipt) return { ok: false };
    if ('label' in gesture) {
      try {
        c.emit({ verb: 'renamed', nodeId: request.id, label: request.label, kind: request.color }, { silent: true });
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
    if (!takesMark(tree.nodesById.get(id))) {
      this.sayTreeCompletes(tree.nodesById.get(id));
      return false;
    }
    const before = c.progress;
    const after = c.completeStep(id, { door: 'board', at: c.now() });
    const outcome = completionOutcome(tree, before, after, id);
    c.showToast(outcome.message, {
      surface: 'board', act: 'complete', reveal: outcome.reveal, holdMs: 6000,
      action: { label: LABELS.undo, run: () => {
        const current = this.collaborators;
        try {
          current.onQuiet();
          current.restoreStep(id, before);
          current.onReveal(id);
          current.track('roadmap_board_undo', { act: 'complete' });
        } catch (error) {
          current.report('roadmap-step-restore', error);
        }
      } },
    });
    c.track('roadmap_board_complete', { door });
    return true;
  }

  // A step that opens a tree completes nothing by hand: the toast says what does, and offers the way in where there is one.
  sayTreeCompletes(step) {
    const c = this.collaborators;
    const said = treeBand(step.opening, { column: 'upNext' });
    if (!said) return;
    c.showToast(said, {
      surface: 'board', act: 'tree', reveal: null, holdMs: 6000,
      ...(step.opening.dangling ? {} : { action: { label: TREE.open, run: () => this.collaborators.openTree(step.id, 'toast') } }),
    });
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
      receipt = c.session.dispatch({ kind: 'CreateNode', ...request });
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
      action: receiptUndo({
        session: c.session, receipt,
        onReverted: () => {
          const current = this.collaborators;
          current.onQuiet();
          if (graph) current.track('roadmap_graph_toast', { act: 'create', step: 'undo' });
          else current.track('roadmap_board_undo', { act: 'create' });
        },
        onFailure: (error) => this.collaborators.report('roadmap-board-create', error),
      }),
    });
    if (graph) c.track('roadmap_graph_toast', { act: 'create', step: 'shown' });
    c.track('roadmap_board_create', { step: 'saved', column: outcome.column, filterCleared: outcome.filterCleared });
    return { ok: true };
  }

  deletePrompt(step) {
    if (step !== 'confirm' && step !== 'cancel') return;
    const c = this.collaborators;
    const view = c.active ? 'board' : 'graph';
    c.track('roadmap_board_delete', { step, view });
  }

  delete(ids, door = 'menu') {
    const c = this.collaborators;
    const selected = [...new Set(ids)];
    if ((!c.active && !c.graphActive) || !c.owner || !c.tree || !['menu', 'key', 'bulk'].includes(door)) return false;
    const graph = !c.active && c.graphActive;
    if (graph && door !== 'menu') return false;
    const surface = graph ? 'graph' : 'board';
    const tree = this.held ? this.held.projected(c.tree) : c.tree;
    if (!deletable(tree, selected)) return false;
    this.release('replaced');
    const held = new HeldDelete(selected, tree.nodesById.get(selected[0]).label);
    if (!c.session?.ready && !c.session?.rebaselining) {
      this.deleteFailed(held, { door, surface, outcome: 'not_ready' });
      return false;
    }
    this.held = held;
    this.pending = { held, session: c.session, surface, door };
    c.session.holdAct(() => {
      this.cancelHold(held, graph);
      this.collaborators.clearBoardToast?.();
    });
    c.onHeld(held);
    c.showToast(held.message, {
      surface, act: 'delete', reveal: null, holdMs: 9000, overRefusal: true,
      onLeave: (via) => { if (this.held === held) this.release(via); },
      action: { label: LABELS.undo, run: () => this.cancelHold(held, graph) },
    });
    if (graph) c.track('roadmap_graph_toast', { act: 'delete', step: 'shown' });
    c.track('roadmap_board_delete', { step: 'held', door, view: surface });
    if (door === 'bulk') c.track('roadmap_board_bulk', { step: 'delete', count: countBucket(selected.length) });
    return true;
  }

  // Toast Undo and ⌘Z both end here: nothing was written, so nothing is sent and the stack is as it was.
  cancelHold(held, graph) {
    if (this.held !== held) return;
    this.pending.session.endHeldAct();
    this.held = null;
    this.pending = null;
    const current = this.collaborators;
    current.onQuiet();
    current.onHeld(null);
    if (graph) {
      current.onGraphReveal(held.ids[0]);
      current.track('roadmap_graph_toast', { act: 'delete', step: 'undo' });
      return;
    }
    current.onReveal(held.ids[0]);
    current.track('roadmap_board_undo', { act: 'delete' });
  }

  release(via = 'left') {
    const pending = this.pending;
    if (!pending) return;
    if (pending.session.rebaselining) {
      pending.releaseVia = via;
      return;
    }
    this.pending = null;
    this.held = null;
    pending.session.endHeldAct();
    const c = this.collaborators;
    let outcome = null;
    try {
      const receipt = pending.session.dispatch({ kind: 'BulkDelete', nodeIds: pending.held.ids });
      if (receipt) c.track('roadmap_board_delete', { step: 'sent', via, view: pending.surface });
      if (!receipt) c.onQuiet();
      if (!receipt && !pending.session.ready) outcome = 'not_ready';
    } catch (error) {
      c.onQuiet();
      c.report('roadmap-board-delete', error);
      outcome = 'error';
    }
    c.onHeld(null);
    if (outcome) this.deleteFailed(pending.held, { door: pending.door, surface: pending.surface, outcome, say: via === 'timer' });
  }

  // The step stands, and the person is told while their toast is the one to tell them: a replacing or left toast says nothing.
  deleteFailed(held, { door, surface, outcome, say = true }) {
    const c = this.collaborators;
    if (outcome === 'not_ready') console.warn('[sync] a delete could not land: the session is not ready');
    c.track('roadmap_board_delete', { step: 'failed', outcome, view: surface });
    if (!say) return;
    c.showToast(deleteFailedToast({ step: held.subject, count: held.ids.length }), {
      surface, act: 'delete', reveal: null, overRefusal: true,
      action: { label: SAVE_FAILURE.retry, run: () => {
        this.collaborators.track('roadmap_board_delete', { step: 'retry', view: surface });
        this.delete(held.ids, door);
      } },
    });
  }

  // The page is going: the session turns synchronous first, so the release lands before the document does.
  leavePage() {
    this.pending?.session.leavePage();
    this.release('left');
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
  const receiptRef = useRef({ session: collaborators.session, version: collaborators.receiptVersion });
  useEffect(() => {
    const previous = receiptRef.current;
    receiptRef.current = { session: collaborators.session, version: collaborators.receiptVersion };
    if (previous.session !== collaborators.session || previous.version == null || collaborators.receiptVersion <= previous.version) return;
    acts.collaborators.dismissInvalidatedToast?.();
  }, [acts, collaborators.session, collaborators.receiptVersion]);
  useEffect(() => {
    if (collaborators.session?.ready && acts.pending?.releaseVia) acts.release(acts.pending.releaseVia);
  }, [acts, collaborators.session, collaborators.syncReady]);
  useEffect(() => {
    const surface = collaborators.active ? 'board' : collaborators.graphActive ? 'graph' : null;
    if (collaborators.owner && surface && (!acts.pending || acts.pending.surface === surface)) {
      if (!collaborators.active) collaborators.clearBoardToast?.();
      return;
    }
    acts.release('left');
    collaborators.clearBoardToast?.();
  }, [acts, collaborators.active, collaborators.graphActive, collaborators.owner]);
  useEffect(() => () => acts.release('left'), [acts, collaborators.treeId]);
  useEffect(() => {
    const leave = () => {
      acts.leavePage();
      acts.collaborators.clearBoardToast?.();
    };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); acts.release('left'); };
  }, [acts]);
  return { held, acts };
}
