import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ArrowRight, ChevronDown, ChevronRight, Compass, Search } from 'lucide-react';
import { Button } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { ROADMAP_SHEET } from '../copy.js';
import { t } from '../i18n/index.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { listServerTrees } from '../persistence/TreeRegistry.js';
import { usePopoverDismissal } from '../popoverDismissal.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { readDeviceTrees } from '../sync/localTrees.js';
import { roadmapMatch } from './roadmapSearch.js';

// This door navigates known list rows; it has no current tree and no mutation authority. `listHeld` reads the person's roadmaps
// where the room reads the device's copy, which keeps the account's and the browser's alike, and answers as the server's
// list does, not authoritative where the copy cannot say; elsewhere the server's list and this device's index do.
export function RecoveryTreeSwitcher({ place, listHeld = null, onPickTree, onNew, onBrowse }) {
  const root = useRef(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const searched = useRef(false);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState({ state: 'loading', rows: [] });
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(new Set());
  const panelId = useId();
  const label = place === 'account' ? t('roadmap.recovery.account') : t('roadmap.recovery.device');

  const close = useCallback((step = 'close', restoreFocus = true) => {
    track('roadmap_recovery', { step, place });
    flushSync(() => setOpen(false));
    if (restoreFocus) trigger.current?.focus();
  }, [place]);
  usePopoverDismissal({ open, root, onClose: close, restoreOutsideFocus: false });

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    const request = new AbortController();
    const timeout = place === 'account' ? setTimeout(() => request.abort(), 15000) : null;
    setList({ state: 'loading', rows: [] });
    setQuery('');
    setExpanded(new Set());
    searched.current = false;
    const read = async () => {
      if (listHeld) {
        const held = await listHeld();
        return { ...held, rows: held.rows.map(({ id, title }) => ({ id, title })) };
      }
      if (place === 'account') return listServerTrees({ signal: request.signal });
      const rows = new LocalTreeRegistry().readList(null);
      const trees = await readDeviceTrees({ registry: { list: () => rows } });
      if ([...trees.values()].some((tree) => tree.unread)) return { authoritative: false, rows: [], reported: true };
      return { authoritative: true, rows: [...trees].map(([id, tree]) => ({ id, title: tree.title })) };
    };
    read().then((result) => {
      if (!active) return;
      if (!result.authoritative) {
        if (!result.reported) {
          const reason = result.status === 401 ? 'auth' : result.status === 0 ? 'network' : result.status === 200 ? 'shape' : 'server';
          reportRoadmapFailure('roadmap-recovery-list', result.failure, { place, reason });
        }
        setList({ state: 'failed', rows: [] });
        track('roadmap_recovery', { step: 'list', place, outcome: 'failed' });
        return;
      }
      setList({ state: 'ready', rows: result.rows });
      track('roadmap_recovery', { step: 'list', place, outcome: result.rows.length ? 'available' : 'empty' });
    }, (error) => {
      if (!active) return;
      reportRoadmapFailure('roadmap-recovery-list', error, { place, reason: 'read' });
      setList({ state: 'failed', rows: [] });
      track('roadmap_recovery', { step: 'list', place, outcome: 'failed' });
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); request.abort(); };
  }, [open, attempt, place, listHeld]);

  useLayoutEffect(() => {
    if (!open) return;
    const box = panel.current;
    // A late answer must not take focus from a control outside this door.
    const focused = document.activeElement;
    if (!root.current?.contains(focused) && !focused?.contains(root.current)) return;
    if (list.state === 'loading') {
      box?.focus();
      return;
    }
    (box?.querySelector('input, button') ?? box)?.focus();
  }, [open, list]);

  const act = (step, callback) => {
    close(step, false);
    callback();
  };
  const available = list.state === 'ready' && list.rows.length > 0;
  const hasQuery = query.trim().length > 0;
  const rows = list.rows.filter((row) => roadmapMatch(row.title ?? '', query));
  const childrenById = new Map(rows.map((tree) => [tree.id, hasQuery ? [] : list.rows.filter((child) => child.id !== tree.id
    && Array.isArray(child.openers) && child.openers.some((opener) => opener?.treeId === tree.id && Number.isInteger(opener.steps) && opener.steps > 0))]));
  const nestedIds = new Set(rows.flatMap((tree) => expanded.has(tree.id) ? childrenById.get(tree.id).map((child) => child.id) : []));
  const peers = rows.filter((tree) => !nestedIds.has(tree.id));
  const row = (tree, nested = false) => {
    const title = tree.title || t('roadmap.common.untitled');
    const below = nested ? [] : childrenById.get(tree.id);
    const isExpanded = !nested && !hasQuery && expanded.has(tree.id);
    return <React.Fragment key={tree.id}>
      <div className={`st-recovery-row${nested ? ' st-recovery-row--child' : ''}`}>
        {below.length > 0 ? <button type="button" className="st-recovery-expand" aria-expanded={isExpanded}
          aria-label={isExpanded ? t('roadmap.recovery.collapse', { title }) : t('roadmap.recovery.expand', { title })}
          onClick={() => {
            setExpanded((value) => {
              const next = new Set(value);
              if (next.has(tree.id)) {
                next.delete(tree.id);
                return next;
              }
              // A nested row cannot expand, so its expansion must not hide any peers.
              for (const child of below) next.delete(child.id);
              next.add(tree.id);
              return next;
            });
            track('roadmap_recovery', { step: isExpanded ? 'collapse' : 'expand', place });
          }}><ChevronRight size={16} aria-hidden /></button> : <span className="st-recovery-inset" />}
        <button type="button" className="st-recovery-pick" aria-label={t('roadmap.recovery.open', { title })}
          onClick={() => act('switch', () => onPickTree(tree.id))}>{title}</button>
      </div>
      {isExpanded && below.map((child) => row(child, true))}
    </React.Fragment>;
  };
  const message = list.state === 'loading' ? t('roadmap.recovery.loading')
    : list.state === 'failed' ? t('roadmap.recovery.failed')
    : available ? t('roadmap.recovery.loaded')
    : place === 'account' ? t('roadmap.recovery.emptyAccount') : t('roadmap.recovery.emptyDevice');

  return <div ref={root} className="st-recovery-switcher">
    <button ref={trigger} type="button" className="st-recovery-trigger" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? panelId : undefined} onClick={() => {
        if (open) { close(); return; }
        track('roadmap_recovery', { step: 'open', place });
        setOpen(true);
      }}>
      <span>{label}</span><ChevronDown size={20} strokeWidth={1.66667} absoluteStrokeWidth aria-hidden />
    </button>
    {open && <div ref={panel} id={panelId} role="dialog" aria-label={label} tabIndex={-1} className="st-recovery-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = [...panel.current.querySelectorAll('input, button:not([disabled])')];
        const next = controls[controls.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1)];
        if (!next) return;
        event.preventDefault();
        next.focus();
      }}>
      {available && <label className="st-recovery-search">
        <Search size={18} strokeWidth={1.66667} absoluteStrokeWidth aria-hidden />
        <input aria-label={t('roadmap.recovery.search')} placeholder={t('roadmap.recovery.search')} value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!searched.current) {
              searched.current = true;
              track('roadmap_recovery', { step: 'search', place });
            }
          }} />
      </label>}
      <h2 className="st-recovery-scope">{label}</h2>
      <p role="status" aria-live="polite" className={available ? 'st-recovery-announcement' : 'st-recovery-message'}>{message}</p>
      {list.state === 'failed' && <Button onClick={() => {
        track('roadmap_recovery', { step: 'retry', place });
        setAttempt((value) => value + 1);
      }}>{t('roadmap.recovery.retry')}</Button>}
      {available && <div className="st-recovery-rows">
        {peers.map((tree) => row(tree))}
        {rows.length === 0 && <p className="st-recovery-message" role="status">{t('roadmap.recovery.noMatches')}</p>}
      </div>}
      {(onNew || onBrowse) && <div className="st-recovery-divider" />}
      {onNew && <button type="button" className="st-recovery-action st-recovery-new" onClick={() => act('new', onNew)}>
        <span className="st-recovery-bud" aria-hidden />{t('roadmap.switcher.newTree')}
      </button>}
      {onBrowse && <button type="button" className="st-recovery-action" onClick={() => act('browse', onBrowse)}>
        <span className="st-recovery-public" aria-hidden><Compass size={14} /></span><span>{ROADMAP_SHEET.plantedInPublic}</span><ArrowRight size={13} aria-hidden />
      </button>}
    </div>}
  </div>;
}
