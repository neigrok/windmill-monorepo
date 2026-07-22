// The list view (X8): the tree read as an outline — one thumb, top to bottom. It renders the
// same model the canvas draws (buildOutline mirrors the canvas order), checks nothing off yet
// (wave 1 is the read path), and threads `editable` through untouched so wave 2 grows the verbs
// in place. Purely presentational: the host owns selection and persistence; this owns only the
// fold state (seeded from ViewPrefs, saved on toggle) and the jump/scroll/flash choreography.
//
// One scroller — the list body. Kind hues come from theme.js (never CSS, so they read 1:1 with
// the canvas); everything else is a token, so light/dark and reduced-motion follow the app.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components';
import { NODE_COLORS, DEFAULT_NODE_COLOR } from '../theme.js';
import { buildOutline, nextUp, treatmentOf, indentPx, progressOf } from './outline.js';
import './list.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CHEVRON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const FLASH_MS = 1300;
const JUMP_OFFSET = 84;

function hueOf(color) {
  return NODE_COLORS[color] ?? NODE_COLORS[DEFAULT_NODE_COLOR];
}

function hueVars(hue) {
  return { '--k-base': hue.base, '--k-ring': hue.ring, '--k-soft': hue.soft, '--k-glow': hue.glow };
}

function shortDate(ms) {
  const date = new Date(ms);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ListView({ tree, nodesById, states, completedAt = {}, legend, header, notice, selectedId, onSelect, active, prefs, treeId, editable = false }) {
  const bodyRef = useRef(null);
  const rowsRef = useRef(new Map());
  const seqRef = useRef(0);
  const [pending, setPending] = useState(null); // { id, flash, seq } — a queued scroll (+ flash)
  const [folded, setFolded] = useState(() => new Set(prefs.foldedSections(treeId)));

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
    row.classList.remove('st-list-row--flash');
    void row.offsetWidth; // reflow so a repeat jump restarts the ramp
    row.classList.add('st-list-row--flash');
    const timer = setTimeout(() => row.classList.remove('st-list-row--flash'), FLASH_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current && selectedId) reveal(selectedId, false);
    wasActive.current = active;
  }, [active, selectedId, reveal]);

  if (!tree) return null;

  const registerRow = (id) => (el) => {
    const rows = rowsRef.current;
    if (el) rows.set(id, el); else rows.delete(id);
  };

  const renderRow = (id, depth, isRoot) => {
    const node = nodesById.get(id);
    if (!node) return null;
    const state = states.get(id) ?? 'locked';
    return (
      <Row
        key={id}
        node={node}
        state={state}
        hue={hueOf(node.color ?? DEFAULT_NODE_COLOR)}
        depth={depth}
        crown={!!isRoot && crowned}
        completedAt={completedAt[id]}
        expanded={selectedId === id}
        editable={editable}
        tree={tree}
        states={states}
        onToggle={() => onSelect(selectedId === id ? null : id)}
        onJump={jumpTo}
        registerRow={registerRow(id)}
      />
    );
  };

  return (
    <div className="st-list">
      <ListHeader header={header} done={done} total={total} crowned={crowned} />
      {notice}
      <div className="st-list-body" ref={bodyRef}>
        {ready.length > 0 && (
          <NextUpShelf ready={ready} nodesById={nodesById} states={states} onJump={jumpTo} />
        )}
        {outline.rootId && renderRow(outline.rootId, 1, true)}
        {outline.sections.map((section) => {
          const open = !folded.has(section.head);
          const secDone = section.rows.reduce((count, row) => count + (states.get(row.id) === 'complete' ? 1 : 0), 0);
          return (
            <div className="st-list-section" key={section.head}>
              <SectionHeader
                node={nodesById.get(section.head)}
                open={open}
                done={secDone}
                total={section.rows.length}
                onToggle={() => toggleSection(section.head)}
              />
              {open && section.rows.map((row) => renderRow(row.id, row.depth, false))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListHeader({ header, done, total, crowned }) {
  const hue = hueOf(header?.dominantHue);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="st-list-header" style={hueVars(hue)}>
      <span className="st-list-header-dot" aria-hidden />
      <span className="st-list-header-name">{header?.name || 'Untitled tree'}</span>
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

function SectionHeader({ node, open, done, total, onToggle }) {
  const hue = hueOf(node?.color ?? DEFAULT_NODE_COLOR);
  return (
    <button type="button" className="st-list-sec" onClick={onToggle} aria-expanded={open}>
      <span className={`st-list-chevron${open ? ' st-list-chevron--open' : ''}`} aria-hidden>{CHEVRON}</span>
      <span className="st-list-sec-dot" style={{ background: hue.base }} aria-hidden />
      <span className="st-list-sec-label">{node?.label || 'Untitled branch'}</span>
      <span className="st-list-sec-count">{done}/{total}</span>
    </button>
  );
}

function Row({ node, state, hue, depth, crown, completedAt, expanded, editable, tree, states, onToggle, onJump, registerRow }) {
  const treatment = treatmentOf(state);
  return (
    <div
      className={`st-list-row${expanded ? ' st-list-row--expanded' : ''}`}
      style={{ '--indent': `${indentPx(depth)}px` }}
      data-list-row={node.id}
      ref={registerRow}
    >
      <button type="button" className="st-list-row-line" onClick={onToggle} aria-expanded={expanded}>
        <Fruit hue={hue} state={state} />
        <span className="st-list-name-group">
          <span className={`st-list-name${treatment === 'locked' ? ' st-list-name--locked' : ''}`}>{node.label || 'Untitled step'}</span>
          {crown && <span className="st-list-crown" aria-label="Tree complete"><Icon name="crown" size={14} color="var(--accent-gold-500)" /></span>}
        </span>
        {state === 'complete' && completedAt != null && <span className="st-list-meta">{shortDate(completedAt)}</span>}
        {state === 'locked' && <span className="st-list-lock" aria-hidden><Icon name="lock" size={13} color="var(--text-tertiary)" /></span>}
      </button>
      {expanded && <ExpandedCard node={node} state={state} tree={tree} states={states} editable={editable} onJump={onJump} />}
    </div>
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

function ExpandedCard({ node, state, tree, states, editable, onJump }) {
  const parents = tree.parentsOf(node.id);
  const children = tree.childrenOf(node.id);
  const blocker = state === 'locked' ? parents.find((parent) => states.get(parent.id) !== 'complete') : null;
  const hasDag = parents.length > 0 || children.length > 0;
  return (
    <div className="st-list-card" data-editable={editable ? '' : undefined}>
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

function ChipGroup({ title, items, states, onJump }) {
  return (
    <div className="st-list-dag">
      <div className="st-list-dag-label">{title}</div>
      <div className="st-list-chips">
        {items.map((item) => {
          const hue = hueOf(item.color ?? DEFAULT_NODE_COLOR);
          const treatment = treatmentOf(states.get(item.id) ?? 'locked');
          return (
            <button key={item.id} type="button" className="st-list-chip st-list-jump-chip" style={hueVars(hue)} onClick={() => onJump(item.id)}>
              <span className={`st-list-dot st-list-dot--${treatment}`} aria-hidden />
              <span className="st-list-chip-label">{item.label || 'Untitled step'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ListView;
