import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronRight, Compass, Download, Plus, Search, Share, Sparkles, Sun, X } from 'lucide-react';
import { track } from '../../../telemetry/beacon.js';
import { hueOf } from '../theme.js';
import { Sheet } from './BoardControls.jsx';
import { useComposerViewport } from './composerFocus.js';
import { COMPACT_COUNT_THRESHOLD, LABELS, ROADMAP_SHEET, ROADMAP_VERBS, exactProgress, progressFigure, progressLabel, roadmapMatches, roadmapsHeading } from './copy.js';
import './identity.css';

export const SEARCH_THRESHOLD = 8;

export function RoadmapSheet({ sheet, view, band, onAskAI, onShare, onExport, onSettings, onActivity, onClose }) {
  const { current, listTrees } = sheet;
  const [loaded, setLoaded] = useState(null);
  const roadmapsId = useId();
  const [query, setQuery] = useState('');
  const searched = useRef(false);
  const searchField = useRef(null);
  const viewport = useComposerViewport(band === 'phone');
  const keyboard = viewport.style && viewport.style.top + viewport.style.height < window.innerHeight;

  useEffect(() => {
    let active = true;
    Promise.resolve().then(listTrees).then((rows) => {
      if (active) setLoaded({ id: current.id, rows });
    }, () => {
      if (active) setLoaded({ id: current.id, rows: [] });
    });
    return () => { active = false; };
  }, [listTrees, current.id]);

  const close = (via) => {
    if (via === 'escape' && query) {
      setQuery('');
      searchField.current?.focus();
      return;
    }
    track('roadmap_sheet', { step: 'close', via });
    onClose(via);
  };

  const act = (callback, event) => {
    onClose('act');
    track(event.name, event.props);
    callback();
  };

  const hasStateCounts = current.upNext != null && current.locked != null;
  const currentProgress = hasStateCounts ? exactProgress(current) : progressLabel(current);
  const rows = [current, ...(loaded?.id === current.id ? loaded.rows : []).filter((tree) => tree.id !== current.id)];
  const searchable = rows.length > SEARCH_THRESHOLD;
  const matching = searchable && query.length > 0;
  const search = query.toLocaleLowerCase();
  const matches = matching ? rows.filter((tree) => tree.title.toLocaleLowerCase().includes(search)) : rows;
  const verbs = [
    { verb: 'askAI', label: ROADMAP_VERBS.askAI, Icon: Sparkles, callback: onAskAI },
    { verb: 'share', label: ROADMAP_VERBS.share, Icon: Share, callback: onShare },
    { verb: 'export', label: ROADMAP_VERBS.export, Icon: Download, callback: onExport },
    { verb: 'settings', label: ROADMAP_VERBS.settings, Icon: Sun, callback: onSettings },
  ].filter(({ callback }) => callback);

  return (
    <Sheet host={document.body} variant="roadmap" className={searchable ? 'st-roadmap-sheet--search' : ''}
      style={searchable ? viewport.style : undefined} title={ROADMAP_SHEET.title} onClose={close}>
      <div className="st-roadmap-sheet-content" tabIndex={-1}>
        {!matching && <>
          <h3 className="st-roadmap-sheet-name">{current.title}</h3>
          {current.total >= COMPACT_COUNT_THRESHOLD && <p className="st-roadmap-sheet-progress">{currentProgress}</p>}
          {verbs.length > 0 && (
            <div className="st-roadmap-sheet-verbs">
              {verbs.map(({ verb, label, Icon, callback }) => (
                <button
                  key={verb}
                  type="button"
                  onClick={() => act(callback, {
                    name: 'roadmap_verb', props: { verb, door: 'sheet', view: view === 'tree' ? 'graph' : 'board', band },
                  })}
                >
                  <Icon size={20} strokeWidth={1.7} aria-hidden />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
          {onActivity && (
            <button type="button" className="st-roadmap-sheet-link" onClick={() => act(onActivity, {
              name: 'roadmap_verb', props: { verb: 'activity', door: 'sheet', view: view === 'tree' ? 'graph' : 'board', band },
            })}>
              <ActivityIcon />
              <span>{ROADMAP_VERBS.activity}</span>
              <ChevronRight size={20} strokeWidth={1.7} aria-hidden />
            </button>
          )}
        </>}
        <h4 id={roadmapsId} className="st-roadmap-sheet-label">{
          matching ? roadmapMatches({ shown: matches.length, total: rows.length })
            : searchable ? roadmapsHeading({ count: rows.length }) : ROADMAP_SHEET.yourRoadmaps
        }</h4>
        <div className="st-roadmap-sheet-trees" role="group" aria-labelledby={roadmapsId}>
          {matches.map((tree) => {
            const selected = tree.id === current.id;
            const matchStart = matching ? tree.title.toLocaleLowerCase().indexOf(search) : -1;
            const progress = { done: tree.done ?? 0, total: tree.total ?? 0 };
            const hue = hueOf(tree.dominantKind).base;
            return (
              <button
                key={tree.id}
                type="button"
                className="st-roadmap-sheet-tree"
                aria-current={selected || undefined}
                aria-label={matching ? tree.title : undefined}
                onClick={() => {
                  if (selected) {
                    onClose('act');
                    return;
                  }
                  act(() => sheet.onPickTree(tree.id), { name: 'roadmap_sheet', props: { step: 'switch' } });
                }}
              >
                <span className="st-roadmap-sheet-dot" style={{ background: hue }} aria-hidden />
                <span className="st-roadmap-sheet-tree-name">{matchStart < 0 ? tree.title : <>
                  {tree.title.slice(0, matchStart)}<mark>{tree.title.slice(matchStart, matchStart + query.length)}</mark>{tree.title.slice(matchStart + query.length)}
                </>}</span>
                <span className="st-roadmap-sheet-count" aria-label={progressLabel(progress)}>{progressFigure({ ...progress, compact: true })}</span>
                <span className="st-roadmap-sheet-check" aria-hidden>{selected && <Check size={20} strokeWidth={1.7} />}</span>
              </button>
            );
          })}
        </div>
        {!searchable && sheet.onNewRoadmap && (
          <button type="button" className="st-roadmap-sheet-link" onClick={() => act(sheet.onNewRoadmap, { name: 'roadmap_sheet', props: { step: 'new' } })}>
            <Plus size={20} strokeWidth={1.7} aria-hidden />
            <span>{ROADMAP_SHEET.newRoadmap}</span>
          </button>
        )}
        {sheet.onBrowse && (
          <button type="button" className="st-roadmap-sheet-link" onClick={() => act(sheet.onBrowse, { name: 'roadmap_sheet', props: { step: 'browse' } })}>
            <Compass size={20} strokeWidth={1.7} aria-hidden />
            <span>{ROADMAP_SHEET.plantedInPublic}</span>
            <ChevronRight size={20} strokeWidth={1.7} aria-hidden />
          </button>
        )}
      </div>
      {searchable && (
        <div className={`st-roadmap-sheet-search-bar${keyboard ? ' st-roadmap-sheet-search-bar--keyboard' : ''}`}>
          <div className="st-roadmap-sheet-search-field">
            <Search size={20} strokeWidth={1.7} aria-hidden />
            <input ref={searchField} type="search" value={query} aria-label={ROADMAP_SHEET.findRoadmap}
              placeholder={ROADMAP_SHEET.findRoadmap} onChange={(event) => {
                const value = event.target.value;
                setQuery(value);
                if (!value || searched.current) return;
                searched.current = true;
                track('roadmap_sheet', { step: 'search' });
              }} />
            {query && <button type="button" aria-label={LABELS.clearSearch} onClick={() => {
              setQuery('');
              searchField.current.focus();
            }}><X size={20} strokeWidth={1.7} aria-hidden /></button>}
          </div>
          {sheet.onNewRoadmap && <button type="button" className="st-roadmap-sheet-new" aria-label={ROADMAP_SHEET.newRoadmap}
            onClick={() => act(sheet.onNewRoadmap, { name: 'roadmap_sheet', props: { step: 'new', door: 'search' } })}>
            <Plus size={20} strokeWidth={1.7} aria-hidden />
          </button>}
        </div>
      )}
    </Sheet>
  );
}


export function ActivityIcon() {
  return <span className="st-roadmap-activity-icon" aria-hidden />;
}
