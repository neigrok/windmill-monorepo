import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { StepSelection, deletable } from './acts.js';
import { stepOf } from './stepAddress.js';
import { boardFocusTarget } from './traversal.js';

const IDLE = { phase: 'idle', visit: null, ids: [], focus: null };
const SELECTING = new Set(['cards', 'kinds', 'closingKinds']);

export function selectionState(state, event) {
  switch (event.type) {
    case 'start':
      if (state.phase !== 'idle') return state;
      return { phase: 'cards', visit: event.visit, ids: [event.visit.id], focus: 'start' };
    case 'toggle':
      if (!SELECTING.has(state.phase)) return state;
      return { ...state, ids: event.ids };
    case 'pruned':
      if (!SELECTING.has(state.phase)) return state;
      return { ...state, ids: state.ids.filter((id) => !event.ids.includes(id)) };
    case 'openKinds':
      if (state.phase !== 'cards') return state;
      return { ...state, phase: 'kinds' };
    case 'closeKinds':
      if (state.phase !== 'kinds') return state;
      return { ...state, phase: 'closingKinds' };
    case 'returned':
      if (!SELECTING.has(state.phase)) return state;
      return { ...state, phase: event.kinds ? 'kinds' : 'cards' };
    case 'end':
      if (!SELECTING.has(state.phase)) return state;
      return {
        ...state,
        phase: state.phase === 'closingKinds' ? 'endingKinds' : 'ending',
        focus: event.restore ? 'restore' : null,
      };
    case 'leaveKinds':
      if (state.phase !== 'endingKinds') return state;
      return { ...state, phase: 'ending' };
    case 'left':
      if (!['ending', 'endingKinds'].includes(state.phase)) return state;
      return { ...IDLE, visit: state.focus ? state.visit : null, focus: state.focus };
    case 'focused':
      if (!state.focus) return state;
      if (state.focus === 'restore' && state.phase !== 'idle') return state;
      return { ...state, visit: state.phase === 'idle' ? null : state.visit, focus: null };
    default:
      return state;
  }
}

export function useStepSelection({ tree, board, shown, doneExpanded, active, enabled, root, leaving, onSelect, onRecolor, onDelete }) {
  const [state, setState] = useState(IDLE);
  const current = useRef(null);
  const ownedTokens = useRef(new Set());
  const derived = useMemo(() => {
    const valid = enabled && board && state.visit?.treeId === tree?.treeId && state.visit?.column === shown;
    if (!SELECTING.has(state.phase) || !valid) return { selection: null, removed: [], valid };
    const pruned = new StepSelection(state.ids).prune(board, shown, { doneExpanded });
    const ids = pruned.ids.filter((id) => deletable(tree, [id]));
    const removed = state.ids.filter((id) => !ids.includes(id));
    return { selection: ids.length ? new StepSelection(ids) : null, removed, valid };
  }, [state.ids, state.visit, state.phase, enabled, board, shown, tree, doneExpanded]);
  current.current = { state, ...derived, tree, board, shown, doneExpanded, active, enabled, onSelect, onRecolor, onDelete };

  const transition = useCallback((event) => {
    const next = selectionState(current.current.state, event);
    if (next === current.current.state) return;
    current.current = { ...current.current, state: next };
    setState(next);
  }, []);

  const handlers = useMemo(() => {
    const end = (via, pop = true) => {
      const context = current.current;
      const present = context.state;
      if (!SELECTING.has(present.phase)) return;
      const sameRoadmap = !context.tree || context.tree.treeId === present.visit.treeId;
      const stillActive = context.active && sameRoadmap && window.location.href === present.visit.href;
      transition({ type: 'end', restore: via !== 'left' || stillActive });
      track('roadmap_board_select', { step: 'end', via });
      const entry = window.history.state?.boardSelection;
      const ownsEntry = entry?.token === present.visit.token && window.location.href === present.visit.href;
      if (!pop || !ownsEntry) {
        transition({ type: 'left' });
        return;
      }
      if (present.phase === 'closingKinds') return;
      window.history.go(entry.kinds ? -2 : -1);
    };

    const kinds = (open) => {
      const { state: present } = current.current;
      if (open && present.phase === 'cards') {
        transition({ type: 'openKinds' });
        window.history.pushState({ ...window.history.state, boardSelection: { token: present.visit.token, kinds: true } }, '', window.location.href);
        return true;
      }
      if (!open && present.phase === 'kinds') {
        transition({ type: 'closeKinds' });
        window.history.back();
        return true;
      }
      return false;
    };

    return {
      end,
      kinds,
      start(id) {
        const context = current.current;
        if (!context.enabled || context.state.phase !== 'idle' || stepOf(window.location.hash) !== null || !deletable(context.tree, [id])) return;
        const candidate = new StepSelection([id]).prune(context.board, context.shown, { doneExpanded: context.doneExpanded });
        if (candidate.count === 0) return;
        const visit = { token: crypto.randomUUID(), id, column: context.shown, treeId: context.tree.treeId, href: window.location.href };
        ownedTokens.current.add(visit.token);
        transition({ type: 'start', visit });
        window.history.pushState({ ...window.history.state, boardSelection: { token: visit.token, kinds: false } }, '', window.location.href);
        track('roadmap_board_select', { step: 'start' });
      },
      selectable(id) {
        return deletable(current.current.tree, [id]);
      },
      pick(id) {
        const context = current.current;
        if (context.state.phase === 'idle') {
          context.onSelect(id);
          return;
        }
        if (!['cards', 'kinds'].includes(context.state.phase) || !context.selection || !deletable(context.tree, [id])) return;
        const next = context.selection.toggle(id, context.board, context.shown, { doneExpanded: context.doneExpanded });
        if (next.count === 0) {
          end('emptied');
          return;
        }
        transition({ type: 'toggle', ids: next.ids });
      },
      recolor(hue) {
        const context = current.current;
        if (!['cards', 'kinds'].includes(context.state.phase) || !context.selection) return { ok: false };
        const result = context.onRecolor?.(context.selection.ids, hue) ?? { ok: false };
        if (!result.ok) return result;
        if (!result.changed) {
          kinds(false);
          return result;
        }
        end('acted');
        navigator.vibrate?.(8);
        return result;
      },
      deleteSelected() {
        const context = current.current;
        if (!['cards', 'kinds'].includes(context.state.phase) || !context.selection) return;
        const accepted = context.onDelete?.(context.selection.ids, 'bulk');
        if (!accepted) return;
        end('acted');
      },
      deleteFromKey(ids, door) {
        const context = current.current;
        if (!deletable(context.tree, ids)) return false;
        return context.onDelete?.(ids, door) ?? false;
      },
      done() { end('done'); },
      back() {
        const { state: present } = current.current;
        const entry = window.history.state?.boardSelection;
        if (present.phase === 'idle') {
          if (!ownedTokens.current.has(entry?.token)) return;
          const { boardSelection, ...rest } = window.history.state;
          window.history.replaceState(rest, '', window.location.href);
          return;
        }
        if (present.phase === 'endingKinds' && entry?.token === present.visit.token && window.location.href === present.visit.href) {
          transition({ type: 'leaveKinds' });
          window.history.back();
          return;
        }
        if (present.phase === 'ending' || present.phase === 'endingKinds') {
          transition({ type: 'left' });
          return;
        }
        if (entry?.token !== present.visit.token) {
          end('back', false);
          return;
        }
        transition({ type: 'returned', kinds: entry.kinds });
      },
      escape(event) {
        const { phase } = current.current.state;
        if (!current.current.enabled) return;
        if (!SELECTING.has(phase) || event.key !== 'Escape' || event.defaultPrevented) return;
        if (document.querySelector('[aria-modal="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
        if (phase === 'kinds') kinds(false);
        if (phase === 'cards') end('back');
      },
    };
  }, [transition]);

  useEffect(() => {
    window.addEventListener('popstate', handlers.back);
    window.addEventListener('keydown', handlers.escape, true);
    return () => {
      window.removeEventListener('popstate', handlers.back);
      window.removeEventListener('keydown', handlers.escape, true);
      handlers.end('left');
      if (current.current.state.phase === 'endingKinds') window.addEventListener('popstate', handlers.back, { once: true });
    };
  }, [handlers]);

  useEffect(() => {
    if (!SELECTING.has(state.phase)) return;
    if (!derived.valid) {
      handlers.end('left');
      return;
    }
    if (!derived.selection) {
      handlers.end('emptied');
      return;
    }
    if (derived.removed.length) transition({ type: 'pruned', ids: derived.removed });
  }, [state.phase, derived, handlers, transition]);

  useLayoutEffect(() => {
    if (!state.focus || !active || !state.visit) return;
    if (state.focus === 'restore' && state.phase !== 'idle') return;
    const { id, column } = state.visit;
    const shownIds = board?.shownCards(column, { doneExpanded }).cards.map((card) => card.id) ?? [];
    const stillShown = shown === column && shownIds.includes(id) && !leaving.has(id);
    const starter = stillShown ? root.current?.querySelector(`.st-board-phone-pane.is-shown .st-board-card:not(.is-leaving)[data-step-id="${CSS.escape(id)}"]`) : null;
    const fallback = state.focus === 'restore' ? boardFocusTarget(root.current, { cards: false }) : null;
    const target = starter ?? fallback;
    if (!target) return;
    target.focus({ preventScroll: true });
    if (state.focus === 'restore') target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    transition({ type: 'focused' });
  }, [state.focus, state.phase, state.visit, active, board, shown, doneExpanded, leaving, root, transition]);

  const starterId = state.visit && (SELECTING.has(state.phase) || state.focus) ? state.visit.id : null;
  return { selection: derived.selection, starterId, ...handlers };
}
