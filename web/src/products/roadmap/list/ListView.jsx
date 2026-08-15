// The list view (X8): the tree read — and, for its owner, worked — as an outline, one thumb,
// top to bottom. It renders the same model the canvas draws (buildOutline mirrors the canvas
// order) and grows the edit path in place: rename/describe by tapping the text, a kind-tinted
// Mark done, a bud row born under any step, a swipe-right accelerator, a recolor swatch row and
// a needs picker. It also carries the three explore primitives (§4), as two surfaces because they
// are two jobs: the LENS — the legend as a filter row, the first thing in the scroller, persistent
// and composing with everything — and the LOOKUP, the head's search icon expanding to a field that
// grows beside identity in the head and ends on a result. A locked card answers "why" with the
// gate: what you can start now, how much is owed, how deep it runs. Every edit dispatches through
// the `handlers` the host passes; this owns only the fold state, the lens/lookup state, the
// transient edit field (one at a time), and the jump/scroll/flash/keyboard choreography. The
// visitor path (editable=false) renders exactly the wave-1 read view, explore primitives included.
// The explore surfaces write nothing of their own — though tapping one still blurs an open field,
// and a blurred field commits (EditField below), which is the edit path finishing, not this one.
//
// One scroller — the list body. Kind hues come from theme.js (never CSS, so they read 1:1 with
// the canvas); everything else is a token, so light/dark and reduced-motion follow the app.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../design-system';
import { NODE_COLORS, NODE_COLOR_NAMES, DEFAULT_NODE_COLOR } from '../theme.js';
import { deleteCostLine, progressVerb } from '../ui/mobile/editorSheet.js';
import { buildOutline, nextUp, treatmentOf, indentPx, progressOf } from './outline.js';
import { filterOutline, kindOptions, gateOf } from './explore.js';
import { swipeBegin, swipeMove, swipeEnd, swipeCancel, keyboardPin, scrollerClearance, stillEditing, holdCancelledByMove, HOLD_MS } from './editing.js';
import { NeedPicker } from './NeedPicker.jsx';
import './list.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CHEVRON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const SEARCH_GLYPH = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);

const CLOSE_GLYPH = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const FLASH_MS = 1300;
const JUMP_OFFSET = 84;
const BLUR_COMMIT_MS = 140;
const STATE_WORDS = { done: 'done', ready: 'ready', active: 'in progress', locked: 'locked' };

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
  const [lens, setLens] = useState(null); // the kind the legend row is holding the list to, or null for All
  const [lookup, setLookup] = useState(null); // { query } while the head's search field is open, else null
  const [revealed, setRevealed] = useState(() => new Set()); // section heads the finger opened in full under a filter
  const [back, setBack] = useState(null); // { id, label } — the one step of "back" a jump leaves behind

  const outline = useMemo(() => (tree ? buildOutline(tree) : { rootId: null, sections: [] }), [tree]);
  const kinds = useMemo(() => (tree ? kindOptions(tree, legend) : []), [tree, legend]);
  const query = lookup?.query ?? '';
  const searching = lookup !== null;

  // The lens narrows what's next (§4 rev — "what's next in Backend" is the question, not noise);
  // the lookup hides the shelf instead, because "next up matching auth" is incoherent.
  const { entries: ready, readyCount } = useMemo(
    () => (tree ? nextUp(tree, states, 3, lens) : { entries: [], readyCount: 0 }),
    [tree, states, lens],
  );

  // Both surfaces narrow the same outline, and an open field with nothing typed still reads as
  // the plain list — a lookup only starts filtering once there is something to look up.
  const looking = query.trim() !== '';
  const filtering = looking || lens !== null;
  // Never trust the held hue for copy: for one render after its last step is recoloured away, the
  // lens names a kind with no chip, and "Next up in " is worse than saying nothing.
  const lensKind = lens ? kinds.find((kind) => kind.hue === lens) ?? null : null;
  const filtered = useMemo(
    () => (filtering ? filterOutline(outline, nodesById, { query, kind: lens, revealed }) : null),
    [filtering, outline, nodesById, query, lens, revealed],
  );

  // Which rows this view is actually putting on the screen — null when nothing is filtering, since
  // then every row is. It is the fact behind "the filter is hiding this step", and the only thing
  // any jump should ever consult (a hue comparison was a proxy, and it missed the root entirely).
  const shown = useMemo(() => {
    if (!filtered) return null;
    const ids = new Set(filtered.root ? [filtered.root.id] : []);
    for (const section of filtered.sections) {
      ids.add(section.head);
      for (const row of section.rows) ids.add(row.id);
    }
    return ids;
  }, [filtered]);

  const { done, total, crowned } = tree ? progressOf(tree, states) : { done: 0, total: 0, crowned: false };

  const toggleSection = useCallback((head) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(head)) next.delete(head); else next.add(head);
      prefs.setFoldedSections(treeId, [...next]);
      return next;
    });
  }, [prefs, treeId]);

  // A new ask starts at the top of its own results (the browser would otherwise clamp the old
  // scroll into the shorter list, landing the eye past the first hit on every keystroke) and drops
  // both the counts the finger had opened and the way back, which named the world before it.
  const toTop = useCallback(() => bodyRef.current?.scrollTo({ top: 0, behavior: 'auto' }), []);
  const ask = useCallback((change) => {
    change();
    setRevealed(new Set());
    setBack(null);
    toTop();
  }, [toTop]);
  const askLens = useCallback((kind) => ask(() => setLens(kind)), [ask]);
  const askQuery = useCallback((query) => ask(() => setLookup({ query })), [ask]);
  const clearFilters = useCallback(() => ask(() => {
    setLens(null);
    setLookup((current) => (current ? { query: '' } : null));
  }), [ask]);
  // The lookup opens and closes on the same quiet icon (✕ and Escape are that same act): closing
  // clears the query and never the lens. Two surfaces, and neither owns the other.
  const toggleLookup = useCallback(() => ask(() => setLookup((current) => (current ? null : { query: '' }))), [ask]);
  const revealSection = useCallback((head) => setRevealed((current) => new Set(current).add(head)), []);

  // Everything that can hide a row, lifted in one place, and then the scroll queued: every path
  // that moves the eye goes through here, so none of them can land on a row that isn't there.
  // A filter yields only for a destination the finger chose (§4 rev 4a) — and a fold is unfolded
  // only when a fold is genuinely what's in the way, because that unfold PERSISTS: rewriting the
  // user's folds behind a filtered screen, which doesn't even show folds, would be pure damage.
  const showRow = useCallback((id, flash) => {
    const hidden = !!shown && !shown.has(id);
    if (hidden) { setLens(null); setLookup(null); setRevealed(new Set()); }
    const section = hidden || !filtering
      ? outline.sections.find((candidate) => candidate.rows.some((row) => row.id === id))
      : null;
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
  }, [shown, filtering, outline, prefs, treeId]);

  // A jump is a move: it ends the lookup — a lookup ends on its result — and leaves one step of
  // "back" behind, naming where the finger came from. A jump from the shelf has no origin row; its
  // way back is the shelf itself, at the top.
  const jumpTo = useCallback((id) => {
    setLookup(null);
    setBack(selectedId && selectedId !== id
      ? { id: selectedId, label: nodesById.get(selectedId)?.label || 'Untitled step' }
      : { id: null, label: 'Next up' });
    showRow(id, true);
    onSelect(id);
  }, [nodesById, selectedId, showRow, onSelect]);

  // One level, one chip, no stack: going back re-opens the card the jump left and drops the chip.
  const goBack = useCallback(() => {
    setBack(null);
    if (!back) return;
    if (back.id === null) { toTop(); return; }
    showRow(back.id, true);
    onSelect(back.id);
  }, [back, toTop, showRow, onSelect]);

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
    if (active && !wasActive.current && selectedId) showRow(selectedId, false);
    wasActive.current = active;
  }, [active, selectedId, showRow]);

  // A lens outlives its kind if the last step wearing it is recoloured or deleted while it is
  // held — and a filter no chip can lift is just an empty screen, so it lets go with the kind.
  useEffect(() => {
    if (lens && !kinds.some((kind) => kind.hue === lens)) setLens(null);
  }, [kinds, lens]);

  // Neither filter crosses the view switch (§4 rev): an invisible lens waiting on the canvas is
  // the worst of the options, and the legend row is one tap away on return. The way back from a
  // jump goes with them — it names a place the eye has since left.
  useEffect(() => {
    if (active) return;
    setLens(null);
    setLookup(null);
    setBack(null);
    setRevealed((current) => (current.size === 0 ? current : new Set()));
  }, [active]);

  // Collapsing or switching rows cancels any in-flight edit surface — one transient at a time,
  // and a stale field must never linger on a row the eye has left.
  useEffect(() => {
    setEdit(null);
    setRecoloring(null);
    setPicker(null);
  }, [selectedId]);

  // Entering multi-select is a mode switch (M5): the bulk bar takes the bottom edge and rows
  // become check seats, so every in-place edit surface closes — and the filters go with them. A
  // selection is a set of steps a verb will act on; a filter that hides members of it while the
  // bar still counts them turns "Delete 3 steps" into two deletions the eye never saw.
  useEffect(() => {
    if (!multiMode) return;
    setEdit(null);
    setRecoloring(null);
    setPicker(null);
    setLens(null);
    setLookup(null);
    setRevealed((current) => (current.size === 0 ? current : new Set()));
  }, [multiMode]);

  // A freshly planted or linked row: scroll it into view and flash it once it has actually
  // mounted. The dispatch → re-render is async, so this re-runs as the outline changes until
  // the row appears, then clears itself — independent of the jump machinery above. A step planted
  // under the lens may not wear its kind, so it takes the same yield as a jump: the view lifts
  // what is hiding a row the finger just asked for.
  useEffect(() => {
    if (!born) return undefined;
    if (nodesById.has(born) && shown && !shown.has(born)) { clearFilters(); return undefined; }
    const body = bodyRef.current;
    const row = rowsRef.current.get(born);
    if (!body || !row) return undefined;
    const top = Math.max(0, body.scrollTop + (row.getBoundingClientRect().top - body.getBoundingClientRect().top) - JUMP_OFFSET);
    body.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    const timer = flashRow(row);
    setBorn(null);
    return () => clearTimeout(timer);
  }, [born, outline, nodesById, shown, clearFilters]);

  // The bottom-edge contract. The scroller ENDS where the action lane begins (§5) — the host
  // measures the lane, because its height moves with its tenants (the Tend bar's starter chips
  // come and go) — so no row is ever under the pill at ANY scroll position, not only at rest.
  // While an edit field or the search field is up, the keyboard (§7, the inset the shared hook
  // measures — the same one the picker lifts its sheet by) is padded inside, by only what it
  // covers of the body: the lane is fixed to the layout viewport, so the keyboard is already
  // sitting on top of it, and reserving both would leave a sliver between two fields.
  const editing = edit != null;
  const kbInset = useKeyboardInset(editing || searching);
  const clearance = scrollerClearance({ laneInset: laneInset > 0 ? laneInset : LANE_FALLBACK_PX, keyboardInset: kbInset });

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
    const target = keyboardPin({ rowBottom, bodyHeight: body.clientHeight, keyboardInset: clearance.keyboardCover, scrollTop: body.scrollTop });
    if (target > body.scrollTop) body.scrollTo({ top: target, behavior: 'auto' });
  }, [edit, clearance.keyboardCover]);

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

  const renderRow = (id, depth, isRoot, section, snippet) => {
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
          snippet={snippet}
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

  // The plant row at a branch's foot (P3) survives the LENS — "add a step to Backend" is the very
  // next thought after holding Backend — but not the lookup, which is a reading view.
  const sectionFoot = (headId) => {
    if (!editable || multiMode || looking) return null;
    const head = nodesById.get(headId);
    if (edit?.mode === 'add' && edit.section && edit.parentId === headId) {
      return <Bud hue={hueOf(head?.color ?? DEFAULT_NODE_COLOR)} depth={2} commit={(value) => commitAdd(headId, value)} cancel={() => closeField('add', headId)} registerField={registerField} />;
    }
    return (
      <button type="button" className="st-list-addrow" style={{ '--indent': `${indentPx(2)}px` }} onClick={() => startEdit({ mode: 'add', parentId: headId, section: true })}>
        <Icon name="plus" size={14} />
        <span>Add step to {head?.label || 'branch'}</span>
      </button>
    );
  };

  // Filtered or not, the body hands React the same three slots — root, sections, empty line — and
  // each section the same four. Swapping an array and an element between slots is the one thing
  // React cannot reconcile, and it would remount every row (and every ref, gesture and pending
  // blur-commit with it) on each tap of a kind chip.
  const rootRow = filtered
    ? filtered.root && renderRow(filtered.root.id, 1, true, undefined, filtered.root.snippet)
    : outline.rootId && renderRow(outline.rootId, 1, true);

  const sections = filtered
    // A head that missed still renders — sections keep their headers so depth survives (§4) — but
    // dimmed, so the eye reads it as scaffolding. It carries no fold and no tally under a filter:
    // both would describe the other list.
    ? filtered.sections.map((section) => (
      <div className={`st-list-section${section.headMatches ? '' : ' st-list-section--scaffold'}`} key={section.head}>
        {renderRow(section.head, 1, false, { open: true, foldable: false }, section.headSnippet)}
        {section.rows.map((row) => renderRow(row.id, row.depth, false, undefined, row.snippet))}
        {section.hidden > 0 && (
          <button type="button" className="st-list-more" style={{ '--indent': `${indentPx(2)}px` }} onClick={() => revealSection(section.head)}>
            +{section.hidden} more in this branch
          </button>
        )}
        {sectionFoot(section.head)}
      </div>
    ))
    : outline.sections.map((section) => {
      const open = !folded.has(section.head);
      // The branch's tally counts the head with its steps — the head is part of the branch, not a
      // label above it — and the same row carries the fold, so it is rendered ONCE.
      const branch = [section.head, ...section.rows.map((row) => row.id)];
      const secDone = branch.reduce((count, id) => count + (states.get(id) === 'complete' ? 1 : 0), 0);
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
          {/* the hidden-count line's slot, empty when nothing is filtering */}
          {null}
          {open && sectionFoot(section.head)}
        </div>
      );
    });

  const kindPrefix = lensKind ? `${lensKind.label} ` : '';
  const emptyLine = filtered && filtered.matches === 0 ? (
    <div className="st-list-empty">
      <span>{looking ? `No ${kindPrefix}steps match “${query.trim()}”` : `No ${kindPrefix}steps`}</span>
      <button type="button" className="st-list-empty-clear" onClick={clearFilters}>Clear filters</button>
    </div>
  ) : null;

  const bodyStyle = { '--lane-inset': `${clearance.lane}px`, '--keyboard-cover': `${clearance.keyboardCover}px` };

  return (
    <div className="st-list">
      <ListHeader
        header={header}
        done={done}
        total={total}
        crowned={crowned}
        switcher={switcher}
        searchable={!multiMode}
        searching={searching}
        query={query}
        onSearch={toggleLookup}
        onQuery={askQuery}
      />
      {notice}
      {/* The filter speaks: 180 rows leaving the screen is silent to a screen reader otherwise. */}
      <span className="st-list-live" aria-live="polite">
        {filtered ? `${filtered.matches} matching step${filtered.matches === 1 ? '' : 's'}` : ''}
      </span>
      {/* The way back reserves its own strip rather than floating over live rows (§10): it names
          its destination, so it stands until it is taken, replaced, or the world it names moves. */}
      {back && (
        <div className="st-list-backlane" role="status">
          <button type="button" className="st-list-back" onClick={goBack}>
            <span className="st-list-back-arrow" aria-hidden>←</span>
            <span className="st-list-back-label">Back to {back.label}</span>
          </button>
        </div>
      )}
      <div className="st-list-body" ref={bodyRef} style={bodyStyle}>
        {kinds.length > 0 && !multiMode && <KindLens kinds={kinds} lens={lens} onPick={askLens} />}
        {!looking && ready.length > 0 && (
          <NextUpShelf entries={ready} readyCount={readyCount} lensLabel={lensKind?.label ?? ''} nodesById={nodesById} states={states} onJump={jumpTo} />
        )}
        {rootRow}
        {sections}
        {emptyLine}
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
// The readout is 46px of brand gradient with a 6px floor (audit fix 2): a 71px track holding a 4px
// nub reads as a failed load, not as early. The count carries the truth — done in the reading
// weight, the total quieter behind it — and the search affordance the explore job was missing
// takes the room the empty track was wasting. The field GROWS BESIDE identity rather than
// replacing it (§5: the head exists so that identity never scrolls away); the readout yields the
// width, the kind dot and the name stay. One trailing button wears both faces, so closing the
// field leaves the finger — and the focus ring — exactly where it already was.
function ListHeader({ header, done, total, crowned, switcher, searchable, searching, query, onSearch, onQuery }) {
  const hue = hueOf(header?.dominantHue);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const name = header?.name || 'Untitled tree';
  const field = useRef(null);
  const searchBtn = useRef(null);
  const wasSearching = useRef(false);
  useEffect(() => {
    if (searching) { field.current?.focus(); wasSearching.current = true; return; }
    if (!wasSearching.current) return;
    wasSearching.current = false;
    searchBtn.current?.focus(); // the field left under the finger — hand focus back to what opened it
  }, [searching]);

  return (
    <div className={`st-list-header${searching ? ' st-list-header--searching' : ''}`} style={hueVars(hue)}>
      <span className="st-list-header-dot" aria-hidden />
      {switcher && !searching ? (
        <button type="button" className="st-list-header-door" aria-haspopup="dialog" onClick={switcher}>
          <span className="st-list-header-name">{name}</span>
          <span className="st-list-header-caret" aria-hidden>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </span>
        </button>
      ) : (
        <span className="st-list-header-name">{name}</span>
      )}
      {searching ? (
        <span className="st-list-search-field">
          <span className="st-list-search-glyph" aria-hidden>{SEARCH_GLYPH}</span>
          <input
            ref={field}
            type="text"
            className="st-list-search-input"
            value={query}
            placeholder="Find a step"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="search"
            aria-label="Find a step"
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              // Enter is "I'm done typing", not "I'm done searching": the keyboard leaves, the
              // query and its results stay. Escape is the one that gives the query up.
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); return; }
              if (event.key === 'Escape') { event.preventDefault(); onSearch(); }
            }}
          />
        </span>
      ) : (
        <>
          {crowned && <span className="st-list-crown" aria-label="Tree complete"><Icon name="crown" size={15} color="var(--accent-gold-500)" /></span>}
          <span className="st-list-header-count">{done}<span className="st-list-header-total">/{total}</span></span>
          <span className="st-list-header-bar">
            <span className="st-list-header-fill" style={{ width: `${pct}%`, minWidth: pct > 0 ? '6px' : 0 }} />
          </span>
        </>
      )}
      {searchable && (
        <button
          ref={searchBtn}
          type="button"
          className="st-list-search-btn"
          aria-label={searching ? 'Close search' : 'Find a step'}
          aria-expanded={searching}
          onClick={onSearch}
        >
          {searching ? CLOSE_GLYPH : SEARCH_GLYPH}
        </button>
      )}
    </div>
  );
}

// The lens (§4 rev): the F6 legend as a filter row, and the first thing in the scroller rather
// than a band pinned above the fold — it is content, it scrolls away, and it earns its place as
// the colour key the phone list never had before it filters anything. Single-select; tapping the
// held kind lets go of it.
function KindLens({ kinds, lens, onPick }) {
  return (
    <div className="st-list-lens" role="group" aria-label="Filter by kind">
      <button type="button" className={`st-list-kindchip${lens === null ? ' is-on' : ''}`} aria-pressed={lens === null} onClick={() => onPick(null)}>
        <span className="st-list-chip-label">All</span>
      </button>
      {kinds.map((kind) => (
        <button
          key={kind.id}
          type="button"
          className={`st-list-kindchip${lens === kind.hue ? ' is-on' : ''}`}
          style={hueVars(hueOf(kind.hue))}
          aria-pressed={lens === kind.hue}
          onClick={() => onPick(lens === kind.hue ? null : kind.hue)}
        >
          <span className="st-list-kindchip-dot" aria-hidden />
          <span className="st-list-chip-label">{kind.label}</span>
          {/* Which chip is held cannot rest on colour: the ring hues have no dark palette. */}
          {lens === kind.hue && <span className="st-list-kindchip-held" aria-hidden><Icon name="check" size={13} /></span>}
        </button>
      ))}
    </div>
  );
}

// Next up as rows, not pills (audit fix 3): three widths hugging three strings left a ragged edge
// and nowhere for the consequence to go, so each offer is a full-bleed row carrying the count the
// ranking already paid for. Under the lens it answers the same question inside one kind (§4 rev).
function NextUpShelf({ entries, readyCount, lensLabel, nodesById, states, onJump }) {
  return (
    <div className="st-list-nextup">
      <div className="st-list-nextup-label">
        <span>{lensLabel ? `Next up in ${lensLabel}` : 'Next up'}</span>
        <span className="st-list-nextup-ready">{readyCount} ready</span>
      </div>
      {entries.map(({ id, unlocks }) => {
        const node = nodesById.get(id);
        const hue = hueOf(node?.color ?? DEFAULT_NODE_COLOR);
        return (
          <button key={id} type="button" className="st-list-nextup-row" style={hueVars(hue)} onClick={() => onJump(id)}>
            <Fruit hue={hue} state={states.get(id) ?? 'available'} />
            <span className="st-list-nextup-main">
              <span className="st-list-nextup-name">{node?.label || 'Untitled step'}</span>
              {unlocks > 0 && <span className="st-list-nextup-unlocks">unlocks {unlocks} more step{unlocks === 1 ? '' : 's'}</span>}
            </span>
            <span className="st-list-nextup-chevron" aria-hidden>{CHEVRON}</span>
          </button>
        );
      })}
    </div>
  );
}

// A single edit field — the one input on the EDIT path (the lookup keeps its own in the head, and
// it writes nothing, so none of the commit machinery below is its business). Focuses on mount (and
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
function Row({ node, state, hue, depth, isRoot, crown, completedAt, expanded, snippet, edits, tree, states, section, multiMode, selected, onEnterMulti, onToggleMember, onToggle, onJump, registerRow }) {
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

  // A row that matched on its description alone carries the fragment as a second line (§4 rev):
  // without it the result is a title that doesn't contain what was typed, and reads as a bug. The
  // title keeps its own line so the crown stays beside the name rather than between the two.
  const nameGroup = (
    <span className={`st-list-name-group${snippet ? ' st-list-name-group--snippet' : ''}`}>
      <span className="st-list-name-line">
        <span className={`st-list-name${treatment === 'locked' ? ' st-list-name--locked' : ''}`}>{label}</span>
        {crown && <span className="st-list-crown" aria-label="Tree complete"><Icon name="crown" size={14} color="var(--accent-gold-500)" /></span>}
      </span>
      {snippet && <span className="st-list-snippet">{snippet}</span>}
    </span>
  );

  // Tier belongs to the fruit (audit fix 7): the lock rides inside the dim fruit, so the trailing
  // rail is gone and the title keeps a name's own colour instead of the meta token.
  const meta = state === 'complete' && completedAt != null ? <span className="st-list-meta">{shortDate(completedAt)}</span> : null;

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
    // The fruit is aria-hidden and a locked row has no verb, so without this a locked step and a
    // ready one read identically aloud — the tier only ever existed in the paint.
    body = (
      <button type="button" className="st-list-row-open" aria-expanded={expanded} aria-label={`${label}, ${STATE_WORDS[treatment]}`} onClick={multiMode ? () => onToggleMember?.(node.id) : onToggle}>
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
      {treatment === 'locked' && <Icon name="lock" size={11} color="var(--text-tertiary)" />}
    </span>
  );
}

function ExpandedCard({ node, state, hue, isRoot, tree, states, edits, onJump }) {
  const parents = tree.parentsOf(node.id);
  const children = tree.childrenOf(node.id);
  // The gate is a graph walk, and this card re-renders for every keystroke anywhere in the list.
  const gate = useMemo(() => (state === 'locked' ? gateOf(tree, states, node.id) : null), [state, tree, states, node.id]);

  if (!edits) {
    const hasDag = parents.length > 0 || children.length > 0;
    return (
      <div className="st-list-card">
        {node.description && <div className="st-list-desc">{node.description}</div>}
        <Gate node={node} gate={gate} states={states} onJump={onJump} />
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

      <Gate node={node} gate={gate} states={states} onJump={onJump} />

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

// Why a step is locked, answered the way the question is actually asked (§4 rev): what can I start
// now — the ready frontier, tappable — how much is owed, and how deep it runs. One chain would
// point at the MOST blocked thing up there, the one place the work cannot begin; a chain is the
// honest shape only when the gate really is a line, and then it reads better than any set could.
function Gate({ node, gate, states, onJump }) {
  if (!gate || gate.blockedBy === 0) return null;

  if (gate.line) {
    return (
      <div className="st-list-why">
        <div className="st-list-why-label"><Icon name="lock" size={12} color="var(--text-secondary)" />Why is this locked?</div>
        <div className="st-list-trace">
          {gate.clipped && <span className="st-list-trace-sep" aria-hidden>…</span>}
          {gate.line.slice(0, -1).map((ancestor) => (
            <React.Fragment key={ancestor.id}>
              <JumpChip item={ancestor} states={states} onJump={onJump} />
              <span className="st-list-trace-sep" aria-hidden>›</span>
            </React.Fragment>
          ))}
          <span className="st-list-trace-self">{node.label || 'Untitled step'}</span>
        </div>
      </div>
    );
  }

  // With nothing startable (only a cyclic gate can do that) the promise of a set goes with the set.
  return (
    <div className="st-list-why">
      <div className="st-list-why-label"><Icon name="lock" size={12} color="var(--text-secondary)" />Why is this locked?</div>
      <div className="st-list-why-line">
        Blocked by {gate.blockedBy} step{gate.blockedBy === 1 ? '' : 's'}{gate.frontier.length > 0 ? ` — ${gate.frontier.length} you can start now.` : '.'}
      </div>
      {gate.frontier.length > 0 && (
        <div className="st-list-chips">
          {gate.frontier.map((item) => <JumpChip key={item.id} item={item} states={states} onJump={onJump} />)}
        </div>
      )}
      {gate.longestChain > 1 && <div className="st-list-why-depth">Longest chain: {gate.longestChain} steps deep.</div>}
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
