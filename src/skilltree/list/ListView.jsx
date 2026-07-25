// The list view (X8): the tree read — and, for its owner, worked — as an outline, one thumb,
// top to bottom. It renders the same model the canvas draws (buildOutline mirrors the canvas
// order) and grows the edit path in place: rename/describe by tapping the text, a kind-tinted
// Mark done, a bud row born under any step, a swipe-right accelerator, a recolor swatch row and
// a needs picker. Every edit dispatches through the `handlers` the host passes; this owns only
// the fold state, the transient edit field (one at a time), and the jump/scroll/flash/keyboard
// choreography. The visitor path (editable=false) renders exactly the wave-1 read view.
//
// One scroller — the list body. Kind hues come from theme.js (never CSS, so they read 1:1 with
// the canvas); everything else is a token, so light/dark and reduced-motion follow the app.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components';
import { NODE_COLORS, NODE_COLOR_NAMES, DEFAULT_NODE_COLOR } from '../theme.js';
import { deleteCostLine, progressVerb } from '../ui/mobile/editorSheet.js';
import { buildOutline, nextUp, treatmentOf, indentPx, progressOf } from './outline.js';
import { swipeBegin, swipeMove, swipeEnd, swipeCancel, keyboardPin, stillEditing, holdCancelledByMove, HOLD_MS } from './editing.js';
import { NeedPicker } from './NeedPicker.jsx';
import './list.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CHEVRON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const FLASH_MS = 1300;
const JUMP_OFFSET = 84;
const BLUR_COMMIT_MS = 140;

// Shared across the list package (ListView + NeedPicker): the kind hue lookup, its CSS custom
// properties, and the reduced-motion query. Exported so the picker reads them 1:1 rather than
// keeping its own copies. The keyboard inset hook is shared the same way (see below).
export function hueOf(color) {
  return NODE_COLORS[color] ?? NODE_COLORS[DEFAULT_NODE_COLOR];
}

export function hueVars(hue) {
  return { '--k-base': hue.base, '--k-ring': hue.ring, '--k-soft': hue.soft, '--k-glow': hue.glow };
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The keyboard inset (X8 L4): while `active`, measure how much of the viewport the on-screen
// keyboard eats (innerHeight − visualViewport.height) and keep it live as the keyboard opens or
// closes. The list body pads by it; the picker lifts its sheet by it. Falls back to 0 where
// visualViewport is absent, and drops back to 0 the moment `active` goes false.
export function useKeyboardInset(active) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
    if (!vv) return undefined;
    const measure = () => setInset(Math.max(0, window.innerHeight - vv.height));
    measure();
    vv.addEventListener('resize', measure);
    return () => { vv.removeEventListener('resize', measure); setInset(0); };
  }, [active]);
  return inset;
}

function shortDate(ms) {
  const date = new Date(ms);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function flashRow(row) {
  row.classList.remove('st-list-row--flash');
  void row.offsetWidth; // reflow so a repeat flash restarts the ramp
  row.classList.add('st-list-row--flash');
  return setTimeout(() => row.classList.remove('st-list-row--flash'), FLASH_MS);
}

// Until the action lane has measured itself (one frame), the body clears a lane's worth of the
// screen on faith — never zero, because a row born under the Tend bar cannot be scrolled clear.
const LANE_FALLBACK_PX = 132;

export function ListView({ tree, nodesById, states, completedAt = {}, legend, header, notice, selectedId, onSelect, active, prefs, treeId, laneInset = 0, editable = false, handlers, portalTarget, switcher, multiMode = false, selectedIds, onEnterMulti, onToggleMember }) {
  const bodyRef = useRef(null);
  const rowsRef = useRef(new Map());
  const fieldRef = useRef(null); // the .st-list-field wrapper of whichever edit input is focused
  const seqRef = useRef(0);
  const [pending, setPending] = useState(null); // { id, flash, seq } — a queued scroll (+ flash)
  const [folded, setFolded] = useState(() => new Set(prefs.foldedSections(treeId)));
  const [edit, setEdit] = useState(null); // { mode:'rename'|'describe', id } | { mode:'add', parentId, section }
  const [recoloring, setRecoloring] = useState(null); // id whose foot shows the swatch row
  const [picker, setPicker] = useState(null); // id we are adding a need to (the half-sheet)
  const [born, setBorn] = useState(null); // a freshly-created/linked row to scroll to and flash once it mounts

  const outline = useMemo(() => (tree ? buildOutline(tree) : { rootId: null, sections: [] }), [tree]);
  const ready = useMemo(() => (tree ? nextUp(tree, states, 3) : []), [tree, states]);

  const { done, total, crowned } = tree ? progressOf(tree, states) : { done: 0, total: 0, crowned: false };

  const toggleSection = useCallback((head) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(head)) next.delete(head); else next.add(head);
      prefs.setFoldedSections(treeId, [...next]);
      return next;
    });
  }, [prefs, treeId]);

  const reveal = useCallback((id, flash) => {
    const section = outline.sections.find((candidate) => candidate.rows.some((row) => row.id === id));
    if (section) {
      setFolded((prev) => {
        if (!prev.has(section.head)) return prev;
        const next = new Set(prev);
        next.delete(section.head);
        prefs.setFoldedSections(treeId, [...next]);
        return next;
      });
    }
    seqRef.current += 1;
    setPending({ id, flash, seq: seqRef.current });
  }, [outline, prefs, treeId]);

  const jumpTo = useCallback((id) => { reveal(id, true); onSelect(id); }, [reveal, onSelect]);

  useLayoutEffect(() => {
    if (!pending) return undefined;
    const body = bodyRef.current;
    const row = rowsRef.current.get(pending.id);
    if (!body || !row) return undefined;
    const top = Math.max(0, body.scrollTop + (row.getBoundingClientRect().top - body.getBoundingClientRect().top) - JUMP_OFFSET);
    body.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    if (!pending.flash) return undefined;
    const timer = flashRow(row);
    return () => clearTimeout(timer);
  }, [pending]);

  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current && selectedId) reveal(selectedId, false);
    wasActive.current = active;
  }, [active, selectedId, reveal]);

  // Collapsing or switching rows cancels any in-flight edit surface — one transient at a time,
  // and a stale field must never linger on a row the eye has left.
  useEffect(() => {
    setEdit(null);
    setRecoloring(null);
    setPicker(null);
  }, [selectedId]);

  // Entering multi-select is a mode switch (M5): the bulk bar takes the bottom edge and rows
  // become check seats, so every in-place edit surface closes — the same one-transient discipline.
  useEffect(() => {
    if (!multiMode) return;
    setEdit(null);
    setRecoloring(null);
    setPicker(null);
  }, [multiMode]);

  // A freshly planted or linked row: scroll it into view and flash it once it has actually
  // mounted. The dispatch → re-render is async, so this re-runs as the outline changes until
  // the row appears, then clears itself — independent of the jump machinery above.
  useEffect(() => {
    if (!born) return undefined;
    const body = bodyRef.current;
    const row = rowsRef.current.get(born);
    if (!body || !row) return undefined;
    const top = Math.max(0, body.scrollTop + (row.getBoundingClientRect().top - body.getBoundingClientRect().top) - JUMP_OFFSET);
    body.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    const timer = flashRow(row);
    setBorn(null);
    return () => clearTimeout(timer);
  }, [born, outline]);

  // The keyboard contract: while an edit field is up, the body pads its bottom by the keyboard
  // inset the shared hook measures — the same inset the picker lifts its sheet by.
  const editing = edit != null;
  const kbInset = useKeyboardInset(editing);

  // Pin the active field just above the keyboard: scroll the body down to it, never up, never
  // the page. Runs once the field is mounted and again as the measured inset settles.
  useLayoutEffect(() => {
    if (!edit || kbInset <= 0) return;
    const body = bodyRef.current;
    const field = fieldRef.current;
    if (!body || !field) return;
    const bodyRect = body.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();
    const rowBottom = body.scrollTop + (fieldRect.bottom - bodyRect.top);
    const target = keyboardPin({ rowBottom, bodyHeight: body.clientHeight, keyboardInset: kbInset, scrollTop: body.scrollTop });
    if (target > body.scrollTop) body.scrollTo({ top: target, behavior: 'auto' });
  }, [edit, kbInset]);

  const startEdit = useCallback((next) => {
    setRecoloring(null);
    setPicker(null);
    setEdit(next);
  }, []);

  const registerField = useCallback((el) => { fieldRef.current = el; }, []);

  if (!tree) return null;

  // Every commit targets its field's own id and closes the editor ONLY if that field is still
  // the one open (stillEditing) — so a blur-commit draining on unmount can't close the editor a
  // later tap has already opened in its place. Each dispatches through the host's handler.
  const commitRename = (id, value) => {
    setEdit((current) => (stillEditing(current, 'rename', id) ? null : current));
    const node = nodesById.get(id);
    const label = value.trim();
    if (node && label && label !== (node.label ?? '').trim()) handlers.rename(id, label);
  };

  const commitDescribe = (id, value) => {
    setEdit((current) => (stillEditing(current, 'describe', id) ? null : current));
    const node = nodesById.get(id);
    const text = value.trim();
    if (node && text !== (node.description ?? '').trim()) handlers.describe(id, text);
  };

  const commitAdd = (parentId, value) => {
    setEdit((current) => (stillEditing(current, 'add', parentId) ? null : current));
    const label = value.trim();
    if (!parentId || !label) return;
    const id = handlers.addStep(parentId, label);
    if (id) setBorn(id);
  };

  const closeField = (mode, key) => setEdit((current) => (stillEditing(current, mode, key) ? null : current));

  const edits = editable ? {
    legend: legend ?? [],
    renaming: edit?.mode === 'rename' ? edit.id : null,
    describing: edit?.mode === 'describe' ? edit.id : null,
    recoloring,
    markDone: (id) => handlers.markDone(id),
    markUndone: (id) => handlers.markUndone(id),
    remove: (id) => handlers.remove(id),
    startRename: (id) => startEdit({ mode: 'rename', id }),
    startDescribe: (id) => startEdit({ mode: 'describe', id }),
    startAddSub: (id) => startEdit({ mode: 'add', parentId: id, section: false }),
    startRecolor: (id) => { setEdit(null); setPicker(null); setRecoloring(id); },
    commitRecolor: (id, hue) => {
      setRecoloring(null);
      const node = nodesById.get(id);
      if (node && (node.color ?? DEFAULT_NODE_COLOR) === hue) return; // tapping the current kind returns the foot, no no-op recolor
      handlers.recolor(id, hue);
    },
    openPicker: (id) => { setEdit(null); setRecoloring(null); setPicker(id); },
    commitRename,
    commitDescribe,
    commitAdd,
    closeField,
    registerField,
  } : null;

  const registerRow = (id) => (el) => {
    const rows = rowsRef.current;
    if (el) rows.set(id, el); else rows.delete(id);
  };

  const renderRow = (id, depth, isRoot, section) => {
    const node = nodesById.get(id);
    if (!node) return null;
    const state = states.get(id) ?? 'locked';
    const budBelow = editable && !multiMode && edit?.mode === 'add' && !edit.section && edit.parentId === id;
    return (
      <React.Fragment key={id}>
        <Row
          node={node}
          state={state}
          hue={hueOf(node.color ?? DEFAULT_NODE_COLOR)}
          depth={depth}
          isRoot={!!isRoot}
          crown={!!isRoot && crowned}
          completedAt={completedAt[id]}
          expanded={selectedId === id}
          edits={edits}
          tree={tree}
          states={states}
          section={section}
          multiMode={multiMode}
          selected={selectedIds?.has(id) ?? false}
          onEnterMulti={onEnterMulti}
          onToggleMember={onToggleMember}
          onToggle={() => onSelect(selectedId === id ? null : id)}
          onJump={jumpTo}
          registerRow={registerRow(id)}
        />
        {budBelow && (
          <Bud hue={hueOf(node.color ?? DEFAULT_NODE_COLOR)} depth={depth + 1} commit={(value) => commitAdd(id, value)} cancel={() => closeField('add', id)} registerField={registerField} />
        )}
      </React.Fragment>
    );
  };

  // The scroller clears the action lane by what the lane actually occupies (§5) — the host
  // measures it, because its height moves with its tenants (the Tend bar's starter chips come
  // and go) — plus the keyboard when one is up (§7).
  const bodyStyle = { '--lane-inset': `${(laneInset > 0 ? laneInset : LANE_FALLBACK_PX) + kbInset}px` };

  return (
    <div className="st-list">
      <ListHeader header={header} done={done} total={total} crowned={crowned} switcher={switcher} />
      {notice}
      <div className="st-list-body" ref={bodyRef} style={bodyStyle}>
        {ready.length > 0 && (
          <NextUpShelf ready={ready} nodesById={nodesById} states={states} onJump={jumpTo} />
        )}
        {outline.rootId && renderRow(outline.rootId, 1, true)}
        {outline.sections.map((section) => {
          const open = !folded.has(section.head);
          const head = nodesById.get(section.head);
          // The branch's tally counts the head with its steps — the head is part of the branch,
          // not a label above it — and the same row carries the fold, so it is rendered ONCE.
          const branch = [section.head, ...section.rows.map((row) => row.id)];
          const secDone = branch.reduce((count, id) => count + (states.get(id) === 'complete' ? 1 : 0), 0);
          const budAtEnd = editable && !multiMode && edit?.mode === 'add' && edit.section && edit.parentId === section.head;
          return (
            <div className="st-list-section" key={section.head}>
              {renderRow(section.head, 1, false, {
                open,
                foldable: section.rows.length > 0,
                done: secDone,
                total: branch.length,
                onToggle: () => toggleSection(section.head),
              })}
              {open && section.rows.map((row) => renderRow(row.id, row.depth, false))}
              {open && editable && !multiMode && (
                budAtEnd ? (
                  <Bud hue={hueOf(head?.color ?? DEFAULT_NODE_COLOR)} depth={2} commit={(value) => commitAdd(section.head, value)} cancel={() => closeField('add', section.head)} registerField={registerField} />
                ) : (
                  <button type="button" className="st-list-addrow" style={{ '--indent': `${indentPx(2)}px` }} onClick={() => startEdit({ mode: 'add', parentId: section.head, section: true })}>
                    <Icon name="plus" size={14} />
                    <span>Add step to {head?.label || 'branch'}</span>
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>
      {picker && (
        <NeedPicker
          tree={tree}
          states={states}
          targetId={picker}
          portalTarget={portalTarget}
          onPick={(pickedId) => { handlers.addNeed(picker, pickedId); setBorn(picker); }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

// The header repeats the plaque facts on one line. For an owner the host passes `switcher` — a
// callback that raises the tree switcher — and the name grows a caret and becomes its door
// (X8 L6). A visitor's header stays a plain label: no caret, no door, the plaque rule intact.
function ListHeader({ header, done, total, crowned, switcher }) {
  const hue = hueOf(header?.dominantHue);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const name = header?.name || 'Untitled tree';
  return (
    <div className="st-list-header" style={hueVars(hue)}>
      <span className="st-list-header-dot" aria-hidden />
      {switcher ? (
        <button type="button" className="st-list-header-door" aria-haspopup="dialog" onClick={switcher}>
          <span className="st-list-header-name">{name}</span>
          <span className="st-list-header-caret" aria-hidden>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </span>
        </button>
      ) : (
        <span className="st-list-header-name">{name}</span>
      )}
      {crowned && <span className="st-list-crown" aria-label="Tree complete"><Icon name="crown" size={15} color="var(--accent-gold-500)" /></span>}
      <span className="st-list-header-count">{done}/{total}</span>
      <span className="st-list-header-bar">
        <span className="st-list-header-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

function NextUpShelf({ ready, nodesById, states, onJump }) {
  return (
    <div className="st-list-nextup">
      <div className="st-list-nextup-label">Next up</div>
      <div className="st-list-nextup-row">
        {ready.map((id) => {
          const node = nodesById.get(id);
          const hue = hueOf(node?.color ?? DEFAULT_NODE_COLOR);
          return (
            <button key={id} type="button" className="st-list-chip st-list-nextup-chip" style={hueVars(hue)} onClick={() => onJump(id)}>
              <Fruit hue={hue} state={states.get(id) ?? 'available'} />
              <span className="st-list-chip-label">{node?.label || 'Untitled step'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// A single edit field — the one input the keyboard is ever attached to. Focuses on mount (and
// selects, for a single-line rename), commits on Enter (shift+Enter is a newline in a textarea),
// reverts on Escape, and — so a tap on the hint doesn't drop the edit — commits a short beat
// after blur. `emptyCancels` makes an empty value a cancel (the bud vanishes rather than plants).
// If the field unmounts while a blur-commit is still pending (a tap that changed the selection,
// opened another editor, or opened the picker within the 140ms window), the pending commit
// DRAINS on unmount rather than being dropped — one idempotent resolve, so an Escape that already
// reverted can't be re-committed by the unmount that follows.
function EditField({ multiline, initial, placeholder, hint, emptyCancels = false, commit, cancel, registerField }) {
  const [draft, setDraft] = useState(initial ?? '');
  const inputRef = useRef(null);
  const resolved = useRef(false);
  const blurTimer = useRef(null);
  const io = useRef(null);
  io.current = { draft, commit, cancel, emptyCancels };

  const resolve = (cancelled) => {
    if (resolved.current) return;
    resolved.current = true;
    if (blurTimer.current) { clearTimeout(blurTimer.current); blurTimer.current = null; }
    const { draft: value, commit: doCommit, cancel: doCancel, emptyCancels: empty } = io.current;
    if (cancelled || (empty && value.trim() === '')) { doCancel(); return; }
    doCommit(value);
  };

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); if (!multiline) el.select?.(); }
    // Drain only a PENDING blur commit — the exact case a fast unmount would drop. With nothing
    // pending (StrictMode's throwaway remount, an already-resolved field) there's nothing to run.
    return () => { if (blurTimer.current) resolve(false); };
  }, [multiline]);

  const onKeyDown = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !(multiline && event.shiftKey)) { event.preventDefault(); resolve(false); return; }
    if (event.key === 'Escape') { event.preventDefault(); resolve(true); }
  };

  const onBlur = () => { blurTimer.current = setTimeout(() => resolve(false), BLUR_COMMIT_MS); };

  const shared = {
    ref: inputRef,
    value: draft,
    placeholder,
    spellCheck: false,
    className: multiline ? 'st-list-input st-list-input--area' : 'st-list-input',
    onChange: (event) => setDraft(event.target.value),
    onKeyDown,
    onBlur,
  };

  return (
    <span className="st-list-field" ref={registerField}>
      {multiline ? <textarea {...shared} rows={3} /> : <input {...shared} type="text" />}
      <span className="st-list-hint">{hint}</span>
    </span>
  );
}

function Bud({ hue, depth, commit, cancel, registerField }) {
  return (
    <div className="st-list-row st-list-bud" style={{ '--indent': `${indentPx(depth)}px` }}>
      <div className="st-list-row-line st-list-row-line--editing">
        <span className="st-list-fruit st-list-fruit--bud" style={hueVars(hue)} aria-hidden />
        <EditField multiline={false} initial="" placeholder="Name this step" hint="↵ plant · esc remove" emptyCancels commit={commit} cancel={cancel} registerField={registerField} />
      </div>
    </div>
  );
}

// A row is three targets on one line, never one that means three things (§3): the fruit marks it
// done, the chevron folds the branch (head rows only), and everything between them opens the card.
// A branch head IS its section (§2), so it wears the fold and the branch tally and is rendered
// exactly once — as a row like any other, with the same fruit and the same card.
function Row({ node, state, hue, depth, isRoot, crown, completedAt, expanded, edits, tree, states, section, multiMode, selected, onEnterMulti, onToggleMember, onToggle, onJump, registerRow }) {
  const treatment = treatmentOf(state);
  const rowRef = useRef(null);
  const lineRef = useRef(null);
  const gestureRef = useRef(null);
  const swallowRef = useRef(false);
  const swallowTimer = useRef(null);
  const holdTimer = useRef(null);
  const holdStart = useRef(null);
  const holdFired = useRef(false);
  // A collapsed editable row is interactive: it can be held into multi-select (any state) and, when
  // ready, swiped right to Mark done. Both gestures share the one pointer stream — the hold arms
  // unless the finger moves (a scroll or the swipe arming both cancel it), and a fired hold drops
  // the swipe. Expanded rows, visitors, and multi-mode rows are none of this.
  const swipeEnabled = !!edits && !multiMode && !expanded && state === 'available';
  const holdEnabled = !!edits && !multiMode && !expanded && !!onEnterMulti;

  const setRowEl = (el) => { rowRef.current = el; registerRow(el); };

  const armSwallow = () => {
    swallowRef.current = true;
    if (swallowTimer.current) clearTimeout(swallowTimer.current);
    swallowTimer.current = setTimeout(() => { swallowRef.current = false; swallowTimer.current = null; }, 200);
  };

  const clearHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };

  useEffect(() => () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (swallowTimer.current) clearTimeout(swallowTimer.current);
  }, []);

  const onPointerDown = (event) => {
    if (holdEnabled) {
      holdFired.current = false;
      holdStart.current = { x: event.clientX, y: event.clientY };
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        holdFired.current = true;
        armSwallow(); // the lift that ends the hold must not also toggle the just-selected member
        gestureRef.current = null; // a hold cancels any nascent swipe so the line never lands shifted
        rowRef.current?.classList.remove('st-list-row--swiping');
        if (lineRef.current) lineRef.current.style.transform = '';
        onEnterMulti?.(node.id);
      }, HOLD_MS);
    }
    if (swipeEnabled) {
      gestureRef.current = { ...swipeBegin(), x0: event.clientX, y0: event.clientY, pointerId: event.pointerId };
    }
  };

  const onPointerMove = (event) => {
    if (holdTimer.current && holdStart.current && holdCancelledByMove(event.clientX - holdStart.current.x, event.clientY - holdStart.current.y)) {
      clearHold();
    }
    const gesture = gestureRef.current;
    if (!gesture || !gesture.live) return;
    const next = swipeMove(gesture, event.clientX - gesture.x0, event.clientY - gesture.y0);
    const armedNow = next.armed && !gesture.armed;
    gestureRef.current = { ...next, x0: gesture.x0, y0: gesture.y0, pointerId: gesture.pointerId };
    if (armedNow) {
      clearHold(); // the swipe won the gesture — the hold is off
      try { lineRef.current?.setPointerCapture(gesture.pointerId); } catch { /* capture is a nicety, not required */ }
      rowRef.current?.classList.add('st-list-row--swiping');
    }
    if (next.armed) {
      event.preventDefault();
      if (lineRef.current) lineRef.current.style.transform = `translateX(${next.dx}px)`;
    }
  };

  // Spring the line home, arm the trailing-click swallow, and mark done only on a committing
  // release. A cancelled pointer (swipeCancel) reaches the same settle but never commits.
  const settleGesture = (verdict) => {
    rowRef.current?.classList.remove('st-list-row--swiping');
    const line = lineRef.current;
    if (line) {
      line.style.transition = 'transform 200ms var(--ease-standard)';
      line.style.transform = '';
      setTimeout(() => { if (line) line.style.transition = ''; }, 220);
    }
    if (verdict.swallow) armSwallow();
    if (verdict.commit) edits.markDone(node.id);
  };

  const onPointerUp = () => {
    clearHold();
    if (holdFired.current) { holdFired.current = false; return; } // the hold consumed the gesture — the swallow eats its click
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture || !gesture.armed) return;
    settleGesture(swipeEnd(gesture));
  };

  const onPointerCancel = () => {
    clearHold();
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture || !gesture.armed) return;
    settleGesture(swipeCancel(gesture));
  };

  // The swallow lives on the row container's capture phase so it survives the branch swap: a
  // committed swipe or a fired hold re-renders the row to a different line (the plain line, or the
  // check seat) whose own onClick would otherwise expand it or toggle the just-armed member.
  // Capturing here eats that one click for every branch and all pointers.
  const onRowClickCapture = (event) => {
    if (!swallowRef.current) return;
    event.stopPropagation();
    event.preventDefault();
    swallowRef.current = false;
    if (swallowTimer.current) { clearTimeout(swallowTimer.current); swallowTimer.current = null; }
  };

  const label = node.label || 'Untitled step';

  const nameGroup = (
    <span className="st-list-name-group">
      <span className={`st-list-name${treatment === 'locked' ? ' st-list-name--locked' : ''}`}>{label}</span>
      {crown && <span className="st-list-crown" aria-label="Tree complete"><Icon name="crown" size={14} color="var(--accent-gold-500)" /></span>}
    </span>
  );

  const meta = (
    <>
      {state === 'complete' && completedAt != null && <span className="st-list-meta">{shortDate(completedAt)}</span>}
      {state === 'locked' && <span className="st-list-lock" aria-hidden><Icon name="lock" size={13} color="var(--text-tertiary)" /></span>}
    </>
  );

  const cardOpen = expanded && !multiMode;

  // §6 — the fruit IS the control: 24px of state in a 44px hit, the same object that shows it.
  // The root never toggles (the crown is earned) and a locked step has nothing to offer, so both
  // wear the fruit as plain state. The card's Mark done button stays as the visible twin (§3).
  const toggle = edits && !multiMode && !isRoot ? progressVerb(state) : null;

  let seat;
  if (multiMode) {
    seat = (
      <button type="button" className="st-list-seat" aria-pressed={selected} aria-label={`${selected ? 'Deselect' : 'Select'} ${label}`} onClick={() => onToggleMember?.(node.id)}>
        <CheckSeat selected={selected} />
      </button>
    );
  } else if (toggle) {
    seat = (
      <button
        type="button"
        className="st-list-seat"
        aria-label={`${toggle === 'complete' ? 'Mark done' : 'Mark not done'}: ${label}`}
        onClick={() => (toggle === 'complete' ? edits.markDone(node.id) : edits.markUndone(node.id))}
      >
        <Fruit hue={hue} state={state} />
      </button>
    );
  } else {
    seat = <span className="st-list-seat"><Fruit hue={hue} state={state} /></span>;
  }

  // A head with nothing under it is a branch of one: heading weight, but no tally to keep and
  // nothing to fold. Only a head that actually holds steps earns the count and the chevron.
  const count = section?.foldable ? <span className="st-list-sec-count">{section.done}/{section.total}</span> : null;

  let body;
  if (edits?.renaming === node.id) {
    body = (
      <EditField multiline={false} initial={node.label ?? ''} placeholder="Name this step" hint="↵ save · esc cancel" commit={(value) => edits.commitRename(node.id, value)} cancel={() => edits.closeField('rename', node.id)} registerField={edits.registerField} />
    );
  } else if (edits && expanded) {
    body = (
      <div className="st-list-row-open" role="button" tabIndex={0} aria-expanded onClick={onToggle}>
        <span className="st-list-name-group">
          <button type="button" className="st-list-name-btn" onClick={(event) => { event.stopPropagation(); edits.startRename(node.id); }}>
            <span className={`st-list-name${treatment === 'locked' ? ' st-list-name--locked' : ''}`}>{label}</span>
            <span className="st-list-pencil" aria-hidden><Icon name="pencil" size={13} color="var(--text-tertiary)" /></span>
          </button>
          {crown && <span className="st-list-crown" aria-label="Tree complete"><Icon name="crown" size={14} color="var(--accent-gold-500)" /></span>}
        </span>
        {meta}
        {count}
      </div>
    );
  } else {
    body = (
      <button type="button" className="st-list-row-open" aria-expanded={expanded} onClick={multiMode ? () => onToggleMember?.(node.id) : onToggle}>
        {nameGroup}
        {meta}
        {count}
      </button>
    );
  }

  const fold = section?.foldable ? (
    <button type="button" className="st-list-fold" aria-expanded={section.open} aria-label={`${section.open ? 'Collapse' : 'Expand'} ${label}`} onClick={section.onToggle}>
      <span className={`st-list-chevron${section.open ? ' st-list-chevron--open' : ''}`} aria-hidden>{CHEVRON}</span>
    </button>
  ) : null;

  return (
    <div
      className={`st-list-row${section ? ' st-list-row--head' : ''}${cardOpen ? ' st-list-row--expanded' : ''}`}
      style={{ '--indent': `${indentPx(depth)}px` }}
      data-list-row={node.id}
      ref={setRowEl}
      onClickCapture={onRowClickCapture}
    >
      {swipeEnabled && (
        <div className="st-list-swband" aria-hidden>
          <Icon name="check" size={16} color="#fff" />
        </div>
      )}
      <div
        ref={lineRef}
        className={`st-list-row-line${swipeEnabled ? ' st-list-row-line--swipe' : ''}`}
        style={swipeEnabled ? { touchAction: 'pan-y' } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {seat}
        {body}
        {fold}
      </div>
      {cardOpen && <ExpandedCard node={node} state={state} hue={hue} isRoot={isRoot} tree={tree} states={states} edits={edits} onJump={onJump} />}
    </div>
  );
}

// The multi-select seat (M5): in multi mode the fruit gives way to a selection control — a hollow
// bark ring when unset, a filled bark disc with a white check when a member. Bark, not a kind:
// this is the selection tool, not the step's category, and it matches the bulk bar's chrome.
function CheckSeat({ selected }) {
  return (
    <span className={`st-list-fruit st-list-check${selected ? ' st-list-check--on' : ''}`} aria-hidden>
      {selected && <Icon name="check" size={13} color="#fff" />}
    </span>
  );
}

function Fruit({ hue, state }) {
  const treatment = treatmentOf(state);
  return (
    <span className={`st-list-fruit st-list-fruit--${treatment}`} style={hueVars(hue)} aria-hidden>
      {treatment === 'done' && <Icon name="check" size={13} color="#fff" />}
    </span>
  );
}

function ExpandedCard({ node, state, hue, isRoot, tree, states, edits, onJump }) {
  const parents = tree.parentsOf(node.id);
  const children = tree.childrenOf(node.id);
  const blocker = state === 'locked' ? parents.find((parent) => states.get(parent.id) !== 'complete') : null;

  if (!edits) {
    const hasDag = parents.length > 0 || children.length > 0;
    return (
      <div className="st-list-card">
        {node.description && <div className="st-list-desc">{node.description}</div>}
        {blocker && (
          <div className="st-list-why">
            <Icon name="lock" size={13} color="var(--text-tertiary)" />
            <span>Finish <strong>{blocker.label}</strong> to unlock</span>
          </div>
        )}
        {hasDag && <div className="st-list-hairline" />}
        {parents.length > 0 && <ChipGroup title="Needs" items={parents} states={states} onJump={onJump} />}
        {children.length > 0 && <ChipGroup title="Unlocks" items={children} states={states} onJump={onJump} />}
      </div>
    );
  }

  const progress = progressVerb(state);
  const currentKind = node.color ?? DEFAULT_NODE_COLOR;
  const swatchKinds = edits.legend.length > 0 ? edits.legend : NODE_COLOR_NAMES.map((h) => ({ id: h, hue: h }));

  // The card reads down the priority ladder (§1): what this step is, why it's locked, the one
  // verb the phone is actually for, then the branch it sits in — and only then the structural
  // edits. P3 is available and unhurried at the foot; it no longer sets the card's layout.
  return (
    <div className="st-list-card" data-editable="">
      {edits.describing === node.id ? (
        <EditField multiline initial={node.description ?? ''} placeholder="Add a description" hint="↵ save · esc cancel" commit={(value) => edits.commitDescribe(node.id, value)} cancel={() => edits.closeField('describe', node.id)} registerField={edits.registerField} />
      ) : (
        <button type="button" className={`st-list-desc-edit${node.description ? '' : ' st-list-desc-edit--empty'}`} onClick={() => edits.startDescribe(node.id)}>
          <span className="st-list-desc-text">{node.description || 'Add a description'}</span>
          <span className="st-list-pencil" aria-hidden><Icon name="pencil" size={13} color="var(--text-tertiary)" /></span>
        </button>
      )}

      {blocker && (
        <div className="st-list-why">
          <Icon name="lock" size={13} color="var(--text-tertiary)" />
          <span>Finish <strong>{blocker.label}</strong> to unlock</span>
        </div>
      )}

      {progress && (
        <div className="st-list-verbs">
          {progress === 'complete' ? (
            <button type="button" className="st-list-verb st-list-verb--done" style={hueVars(hue)} onClick={() => edits.markDone(node.id)}>
              <Icon name="check" size={16} color="#fff" />Mark done
            </button>
          ) : (
            <button type="button" className="st-list-verb" onClick={() => edits.markUndone(node.id)}>
              <Icon name="rotate-ccw" size={16} />Mark not done
            </button>
          )}
        </div>
      )}

      {(parents.length > 0 || children.length > 0) && <div className="st-list-hairline" />}
      {parents.length > 0 && <ChipGroup title="Needs" items={parents} states={states} onJump={onJump} />}
      {children.length > 0 && <ChipGroup title="Unlocks" items={children} states={states} onJump={onJump} />}

      <div className="st-list-hairline" />

      {edits.recoloring === node.id ? (
        <div className="st-list-swatches" role="group" aria-label="Recolor this step">
          <div className="st-list-dag-label">Kind</div>
          <div className="st-list-swatch-row">
            {swatchKinds.map((kind) => (
              <button key={kind.id} type="button" className="st-list-swatch-hit" aria-label={`Set kind to ${kind.label || kind.hue}`} onClick={() => edits.commitRecolor(node.id, kind.hue)}>
                <span className={`st-list-swatch${kind.hue === currentKind ? ' st-list-swatch--on' : ''}`} style={{ background: hueOf(kind.hue).base }} />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="st-list-edits" role="group" aria-label="Edit this step">
          <button type="button" className="st-list-edit-btn" onClick={() => edits.startAddSub(node.id)}>
            <Icon name="plus" size={15} />Add step
          </button>
          {!isRoot && (
            <button type="button" className="st-list-edit-btn" onClick={() => edits.openPicker(node.id)}>
              <Icon name="plus" size={15} />Add need
            </button>
          )}
          <button type="button" className="st-list-edit-btn" onClick={() => edits.startRecolor(node.id)}>
            <span className="st-list-foot-dot" style={{ background: hue.base }} aria-hidden />Recolor
          </button>
          {!isRoot && (
            <button type="button" className="st-list-edit-btn st-list-edit-del" onClick={() => edits.remove(node.id)}>
              <Icon name="trash-2" size={15} color="var(--color-danger)" />{deleteCostLine(children.length)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChipGroup({ title, items, states, onJump }) {
  return (
    <div className="st-list-dag">
      <div className="st-list-dag-label">{title}</div>
      <div className="st-list-chips">
        {items.map((item) => (
          <JumpChip key={item.id} item={item} states={states} onJump={onJump} />
        ))}
      </div>
    </div>
  );
}

function JumpChip({ item, states, onJump }) {
  const hue = hueOf(item.color ?? DEFAULT_NODE_COLOR);
  const treatment = treatmentOf(states.get(item.id) ?? 'locked');
  return (
    <button type="button" className="st-list-chip st-list-jump-chip" style={hueVars(hue)} onClick={() => onJump(item.id)}>
      <span className={`st-list-dot st-list-dot--${treatment}`} aria-hidden />
      <span className="st-list-chip-label">{item.label || 'Untitled step'}</span>
    </button>
  );
}

export default ListView;
