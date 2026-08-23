import React, { useEffect, useRef, useState } from 'react';
import { Card, Button, IconButton, Icon } from '../../../design-system';
import { NodeWorkspace, LinkRow, SAFE_URL } from './tree/NodeWorkspace.jsx';
import { EventRow } from '../activity/EventRow.jsx';
import { NODE_COLORS, NODE_COLOR_NAMES, DEFAULT_NODE_COLOR } from '../theme.js';

const EMPTY_WORKSPACE = { subtasks: [], note: '', links: [] };
const noop = () => {};

const CHIP_LABEL = { available: 'Not started', active: 'In progress', complete: 'Complete', locked: 'Locked' };

const STATE_CHOICES = [
  { target: 'notstarted', label: 'Not started', state: 'available' },
  { target: 'active', label: 'In progress', state: 'active' },
  { target: 'complete', label: 'Complete', state: 'complete' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Never seconds, never ticking.
function relativeTime(at, now) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const stamp = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return sameYear ? stamp : `${stamp}, ${date.getFullYear()}`;
}

function absoluteTime(at) {
  const date = new Date(at);
  const meridiem = date.getHours() < 12 ? 'AM' : 'PM';
  const hour = date.getHours() % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} · ${hour}:${minute} ${meridiem}`;
}

function shortDate(at) {
  const date = new Date(at);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function cap(hue) {
  return hue.charAt(0).toUpperCase() + hue.slice(1);
}

// Authored intent that travels with the tree, distinct from the per-user workspace.
export function NodeAnnotation({ description, links = [] }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [description, expanded]);

  const safeLinks = links.filter((link) => SAFE_URL.test(link.url));
  if (!description && safeLinks.length === 0) return null;

  return (
    <div className="st-step-annotation">
      <div>
        <div className="st-step-heading">About</div>
        {description && (
          <div ref={bodyRef} className={`st-annotation-body${expanded ? '' : ' st-annotation-body--clamped'}`}>{description}</div>
        )}
        {(overflows || expanded) && (
          <button type="button" className="st-annotation-more" onClick={() => setExpanded((open) => !open)}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
      {safeLinks.length > 0 && (
        <div className="st-links">
          {safeLinks.map((link, index) => (
            <LinkRow key={`${index}-${link.url}`} url={link.url} title={link.label} />
          ))}
        </div>
      )}
    </div>
  );
}

function TimestampLine({ state, startedAt, completedAt, now }) {
  const title = [
    startedAt ? `Started ${absoluteTime(startedAt)}` : null,
    completedAt ? `Completed ${absoluteTime(completedAt)}` : null,
  ].filter(Boolean).join(' · ');
  const text = state === 'active'
    ? `Started ${relativeTime(startedAt, now)}`
    : `Completed ${relativeTime(completedAt, now)}`;
  return <div className="st-state-time" title={title}>{text}</div>;
}

// The shared/mobile viewer gets the compact read-only detail, everyone else the full editor.
export function StepPanel(props) {
  if (props.readOnly) return <ReadOnlyStep {...props} />;
  return <EditorStep {...props} />;
}

function EditorStep({ node, state, prerequisites, startedAt, completedAt, history = [], workspace = EMPTY_WORKSPACE, kinds = [], onOpenLegend = noop, autoFocusName, onRename, onPreviewKind, onRestoreKind, onSetKind, onStart, onMarkComplete, onSetState, onReveal, onDelete, onPreviewDeleteCost, onClearDeleteCost, onClose, onAddSubtask = noop, onToggleSubtask = noop, onEditSubtask = noop, onDeleteSubtask = noop, onSetNote = noop, onAddLink = noop, onDeleteLink = noop }) {
  const [editingName, setEditingName] = useState(!!autoFocusName);
  const [draft, setDraft] = useState(node?.label ?? '');
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef(null);
  const chipRef = useRef(null);
  const menuRef = useRef(null);
  const escapedRef = useRef(false); // Esc reverts — the blur that follows must not commit

  useEffect(() => {
    if (!editingName) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingName]);

  useEffect(() => {
    if (!menuOpen) return;
    const checked = menuRef.current?.querySelector('[aria-checked="true"]');
    const first = menuRef.current?.querySelector('[role="menuitemradio"]');
    (checked ?? first)?.focus();
    const onDocDown = (event) => {
      if (menuRef.current?.contains(event.target) || chipRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, [menuOpen]);

  if (!node) return null;

  const now = Date.now();
  const currentKind = node.color ?? DEFAULT_NODE_COLOR;
  const legendKinds = kinds.length > 0 ? kinds : NODE_COLOR_NAMES.map((hue) => ({ id: hue, hue }));
  const hue = NODE_COLORS[currentKind] ?? NODE_COLORS[DEFAULT_NODE_COLOR];
  const chipHue = { '--chip-base': hue.base, '--chip-ring': hue.ring, '--chip-glow': hue.glow };
  const lockedBy = prerequisites.find((prerequisite) => !prerequisite.complete)?.label;

  const commitOrRevertName = () => {
    setEditingName(false);
    if (escapedRef.current) {
      escapedRef.current = false;
      setDraft(node.label);
      return;
    }
    const label = draft.trim();
    if (label !== node.label) onRename(node.id, label);
  };

  // Esc closes the menu, not the panel. stopPropagation keeps the app's global Esc / ⌘Z / ⌫ quiet while it has focus.
  const onMenuKeyDown = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); chipRef.current?.focus(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = [...menuRef.current.querySelectorAll('[role="menuitemradio"]')];
      const index = items.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next]?.focus();
    }
  };

  return (
    <Card style={{ maxHeight: '70vh', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div className="st-step-pinned">
      <div className="st-step-header">
        <div className="st-step-identity">
          <span className="st-step-glyph">
            <Icon name={node.icon} size={20} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            {editingName ? (
              <input
                ref={inputRef}
                className="st-step-name-input"
                value={draft}
                placeholder="Name this step"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitOrRevertName}
                onKeyDown={(event) => {
                  event.stopPropagation(); // typing never reaches the ⌘Z / ⌫ / Esc shortcuts
                  if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                  if (event.key === 'Escape') { event.preventDefault(); escapedRef.current = true; event.currentTarget.blur(); }
                }}
              />
            ) : (
              <button
                type="button"
                className={`st-step-name ${node.label ? '' : 'st-step-name--empty'}`}
                onClick={() => { setDraft(node.label); setEditingName(true); }}
              >
                {node.label || 'Unnamed step'}
              </button>
            )}
          </div>
        </div>
        <IconButton icon={<Icon name="x" />} label="Close" size="sm" onClick={onClose} />
      </div>

      <div className="st-step-state">
        {state === 'locked' ? (
          <>
            <span className="st-state-chip st-state-chip--static">
              <span className="st-state-dot st-state-dot--locked"><Icon name="lock" size={11} /></span>
              Locked
            </span>
            {lockedBy && (
              <div className="st-state-lockedline">Unlocks when ‘{lockedBy}’ is complete.</div>
            )}
          </>
        ) : (
          <>
            <div className="st-state-chip-row">
              <button
                ref={chipRef}
                type="button"
                className="st-state-chip"
                style={chipHue}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <span className={`st-state-dot st-state-dot--${state}`} />
                {CHIP_LABEL[state]}
                <span className="st-state-caret" aria-hidden>▾</span>
              </button>
              {menuOpen && (
                <div ref={menuRef} className="st-state-menu" role="menu" onKeyDown={onMenuKeyDown}>
                  {STATE_CHOICES.map((choice) => (
                    <button
                      key={choice.target}
                      type="button"
                      role="menuitemradio"
                      aria-checked={choice.state === state}
                      className="st-state-menu-item"
                      onClick={() => { setMenuOpen(false); onSetState(node.id, choice.target); }}
                    >
                      <span className="st-state-menu-check">
                        {choice.state === state && <Icon name="check" size={14} />}
                      </span>
                      {choice.label}
                    </button>
                  ))}
                  <div className="st-state-menu-caption">Timestamps adjust with the move</div>
                </div>
              )}
            </div>

            {state === 'available' && (
              <div className="st-state-actions">
                <Button variant="primary" onClick={onStart} icon={<Icon name="play" />}>Start step</Button>
                <Button variant="ghost" onClick={onMarkComplete} icon={<Icon name="check" />}>Mark complete</Button>
              </div>
            )}
            {state === 'active' && (
              <>
                <div className="st-state-actions">
                  <Button variant="primary" onClick={onMarkComplete} icon={<Icon name="check" />}>Mark complete</Button>
                </div>
                {startedAt && <TimestampLine state="active" startedAt={startedAt} completedAt={completedAt} now={now} />}
              </>
            )}
            {state === 'complete' && completedAt && (
              <TimestampLine state="complete" startedAt={startedAt} completedAt={completedAt} now={now} />
            )}
          </>
        )}
      </div>
      </div>

      <div className="st-step-scroll">
      <NodeAnnotation description={node.description} links={node.links} />

      <NodeWorkspace
        nodeId={node.id}
        workspace={workspace}
        hue={hue}
        onAddSubtask={onAddSubtask}
        onToggleSubtask={onToggleSubtask}
        onEditSubtask={onEditSubtask}
        onDeleteSubtask={onDeleteSubtask}
        onSetNote={onSetNote}
        onAddLink={onAddLink}
        onDeleteLink={onDeleteLink}
      />

      <div>
        <div className="st-step-heading">Prerequisites</div>
        {prerequisites.length === 0 ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            None — this is a starting point.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {prerequisites.map((prerequisite) => (
              <li
                key={prerequisite.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 600,
                  color: prerequisite.complete ? 'var(--text-primary)' : 'var(--text-tertiary)',
                }}
              >
                <Icon
                  name={prerequisite.complete ? 'check' : 'lock'}
                  size={14}
                  color={prerequisite.complete ? 'var(--color-success)' : 'var(--text-tertiary)'}
                />
                {prerequisite.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="st-step-heading">History</div>
        {history.length === 0 ? (
          <div className="st-step-empty">No activity yet — this step hasn’t been touched.</div>
        ) : (
          <div className="st-step-history">
            {history.map((event) => (
              <EventRow key={event.id} event={event} node={node} now={Date.now()} onReveal={onReveal} />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="st-step-heading">Kind</div>
        <div className="st-step-kinds">
          {legendKinds.map((kind) => (
            <button
              key={kind.id}
              type="button"
              className={`st-step-swatch ${kind.hue === currentKind ? 'st-step-swatch--current' : ''}`}
              style={{ background: NODE_COLORS[kind.hue].base }}
              title={kind.label || cap(kind.hue)}
              aria-label={`Set kind to ${kind.label || cap(kind.hue)}`}
              onPointerEnter={() => onPreviewKind(node.id, kind.hue)}
              onPointerLeave={() => onRestoreKind(node.id)}
              onClick={() => onSetKind(node.id, kind.hue)}
            />
          ))}
          <button
            type="button"
            className="st-step-swatch st-step-swatch--add"
            title="Manage kinds"
            aria-label="Manage kinds"
            onClick={() => onOpenLegend()}
          >
            +
          </button>
        </div>
      </div>

      <div className="st-step-danger" style={{ marginTop: 'auto' }}>
        <button
          type="button"
          className="st-step-delete"
          onPointerEnter={() => onPreviewDeleteCost(node.id)}
          onPointerLeave={() => onClearDeleteCost()}
          onClick={() => { onClearDeleteCost(); onDelete(node.id); }}
        >
          <Icon name="trash-2" size={16} />
          Delete step
        </button>
      </div>
      </div>
    </Card>
  );
}

// onJump eases the camera to that node and retargets in place.
function ReadOnlyStep({ node, state, prerequisites = [], unlocks = [], completedAt, onMarkComplete, onJump, onClose = noop, fill = false }) {
  if (!node) return null;

  const currentKind = node.color ?? DEFAULT_NODE_COLOR;
  const hue = NODE_COLORS[currentKind] ?? NODE_COLORS[DEFAULT_NODE_COLOR];
  const blocker = prerequisites.find((prerequisite) => !prerequisite.complete)?.label;
  const showChip = state === 'complete' || state === 'locked';

  return (
    <Card style={{ ...(fill ? { height: '100%' } : { maxHeight: '70vh' }), display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div className="st-step-pinned">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 34 }}>
        <SheetStateFruit state={state} hue={hue} />
        <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.label || 'Unnamed step'}
        </span>
        {showChip && <ReadOnlyStateChip state={state} hue={hue} completedAt={completedAt} />}
        {onMarkComplete && state === 'available' && (
          <Button variant="primary" size="sm" onClick={() => onMarkComplete(node.id)} icon={<Icon name="check" />}>
            Mark it done
          </Button>
        )}
        {!fill && <IconButton icon={<Icon name="x" />} label="Close" size="sm" onClick={onClose} />}
      </div>
      </div>

      <div className="st-step-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <NodeAnnotation description={node.description} links={node.links} />

      {state === 'locked' && blocker && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', background: 'var(--surface-sunken)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          <Icon name="lock" size={13} color="var(--text-tertiary)" />
          <span>Finish <strong style={{ color: 'var(--text-secondary)' }}>{blocker}</strong> to unlock</span>
        </div>
      )}

      <SheetRelations title="Needs" items={prerequisites} onJump={onJump} />
      <SheetRelations title="Unlocks" items={unlocks} onJump={onJump} />
      </div>
    </Card>
  );
}

export function ReadOnlyStateChip({ state, hue, completedAt }) {
  const base = { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', padding: '4px 11px', borderRadius: 'var(--radius-full)', fontSize: 'var(--text-sm)', fontWeight: 700, whiteSpace: 'nowrap' };
  if (state === 'complete') {
    return (
      <span style={{ ...base, background: hue.base, border: `1px solid ${hue.ring}`, color: '#fff' }}>
        <Icon name="check" size={13} color="#fff" />
        {completedAt ? `Done · ${shortDate(completedAt)}` : 'Done'}
      </span>
    );
  }
  if (state === 'locked') {
    return (
      <span style={{ ...base, background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}>
        <Icon name="lock" size={12} color="var(--text-tertiary)" />
        Locked
      </span>
    );
  }
  return (
    <span style={{ ...base, background: 'transparent', border: `1.5px solid ${hue.ring}`, color: hue.ring }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', boxShadow: `inset 0 0 0 2px ${hue.ring}`, flexShrink: 0 }} aria-hidden />
      Ready
    </span>
  );
}


// The sheet's density pieces, shared by the owner editor sheet and the read-only one.
function stateFruitStyle(state, hue) {
  const base = { flexShrink: 0, width: 22, height: 22, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
  if (state === 'complete') return { ...base, background: hue.base, boxShadow: `0 0 7px ${hue.glow}` };
  if (state === 'locked') return { ...base, background: `color-mix(in srgb, ${hue.base} 18%, transparent)`, boxShadow: `inset 0 0 0 1.5px color-mix(in srgb, ${hue.base} 35%, transparent)` };
  if (state === 'active') return { ...base, background: 'var(--surface-card)', boxShadow: `inset 0 0 0 2.5px ${hue.ring}, 0 0 7px ${hue.glow}` };
  return { ...base, background: 'var(--surface-card)', boxShadow: `inset 0 0 0 2.5px ${hue.ring}` };
}

function stateDotStyle(state, hue) {
  const base = { flexShrink: 0, width: 11, height: 11, borderRadius: '50%' };
  if (state === 'complete') return { ...base, background: hue.base };
  if (state === 'locked') return { ...base, background: `color-mix(in srgb, ${hue.base} 18%, transparent)`, boxShadow: `inset 0 0 0 1.5px color-mix(in srgb, ${hue.base} 35%, transparent)` };
  if (state === 'active') return { ...base, background: 'var(--surface-card)', boxShadow: `inset 0 0 0 2px ${hue.ring}, 0 0 5px ${hue.glow}` };
  return { ...base, background: 'var(--surface-card)', boxShadow: `inset 0 0 0 2px ${hue.ring}` };
}

export function SheetStateFruit({ state, hue }) {
  return (
    <span style={stateFruitStyle(state, hue)} aria-hidden>
      {state === 'complete' && <Icon name="check" size={12} color="#fff" />}
    </span>
  );
}

const SHEET_CHIP = {
  display: 'inline-flex', alignItems: 'center', gap: 7, minHeight: 34, maxWidth: '100%',
  padding: '0 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-full)',
  background: 'var(--surface-card)', color: 'var(--text-primary)', fontFamily: 'var(--font-body)',
  fontSize: '12.5px', fontWeight: 700, cursor: 'pointer',
};

export function SheetRelations({ title, items, onJump }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="st-step-heading">{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        {items.map((item) => {
          const hue = NODE_COLORS[item.color] ?? NODE_COLORS[DEFAULT_NODE_COLOR];
          const state = item.state ?? (item.complete ? 'complete' : 'locked');
          return (
            <button key={item.id} type="button" style={SHEET_CHIP} onClick={() => onJump?.(item.id)}>
              <span style={stateDotStyle(state, hue)} aria-hidden />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label || 'Untitled step'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
