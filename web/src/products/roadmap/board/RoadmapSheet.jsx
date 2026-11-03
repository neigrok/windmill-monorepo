import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Activity, Check, ChevronLeft, ChevronRight, Compass, Download, Plus, Search, Share, Sparkles, Sun, X } from 'lucide-react';
import { flushSync } from 'react-dom';
import { track } from '../../../telemetry/beacon.js';
import { hueOf } from '../theme.js';
import { ActivityRows } from '../activity/ActivityRows.jsx';
import { roadmapMatch, SEARCH_THRESHOLD } from './roadmapSearch.js';
import { Sheet } from './BoardControls.jsx';
import { useComposerViewport } from './composerFocus.js';
import { ACTIVITY, COMPACT_COUNT_THRESHOLD, LABELS, ROADMAP_SHEET, ROADMAP_VERBS, STEP_DETAIL, exactProgress, progressFigure, progressLabel, roadmapMatches, roadmapsHeading } from './copy.js';
import './identity.css';

export function RoadmapSheet({ sheet, view, band, onAskAI, onShare, onExport, onSettings, onClose }) {
  const { current, listTrees } = sheet;
  const [loaded, setLoaded] = useState(null);
  const roadmapsId = useId();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(null);
  const activityButton = useRef(null);
  const backButton = useRef(null);
  const content = useRef(null);
  const previousActivity = useRef(false);
  const edgeSwipe = useRef(null);
  const consumedSwipe = useRef(false);
  const activity = band === 'phone' ? sheet.activity : null;
  const activityPage = page === 'activity' && Boolean(activity);
  const searched = useRef(false);
  const searchField = useRef(null);
  const viewport = useComposerViewport(band === 'phone');

  useEffect(() => {
    let active = true;
    Promise.resolve().then(listTrees).then((rows) => {
      if (active) setLoaded({ id: current.id, rows });
    }, () => {
      if (active) setLoaded({ id: current.id, rows: [] });
    });
    return () => { active = false; };
  }, [listTrees, current.id]);

  useLayoutEffect(() => {
    if (activityPage) backButton.current?.focus();
    if (!activityPage && previousActivity.current) {
      const target = activityButton.current ?? content.current?.closest('[role="dialog"]')?.querySelector('.st-board-sheet-close');
      target?.focus();
      setPage(null);
    }
    previousActivity.current = activityPage;
  }, [activityPage]);

  const back = useCallback(() => {
    edgeSwipe.current = null;
    flushSync(() => setPage(null));
  }, []);

  const openActivityStep = useCallback((id) => {
    if (!activity) return;
    onClose('act');
    activity.onOpenStep(id);
  }, [activity, onClose]);

  const close = (via) => {
    if (via === 'escape' && activityPage) {
      back();
      return;
    }
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
  const matching = searchable && query.trim().length > 0;
  const matches = rows.map((tree) => ({ tree, match: roadmapMatch(tree.title, matching ? query : '') }))
    .filter(({ match }) => match !== null);
  const heading = matching
    ? roadmapMatches({ shown: matches.length, total: rows.length })
    : roadmapsHeading({ count: rows.length });
  const listHeading = searchable ? heading : ROADMAP_SHEET.yourRoadmaps;
  const searchClass = searchable ? 'st-roadmap-sheet--search' : '';
  const sheetClass = activityPage ? 'st-roadmap-sheet--activity' : searchClass;
  const verbs = [
    { verb: 'askAI', label: ROADMAP_VERBS.askAI, Icon: Sparkles, callback: onAskAI },
    { verb: 'share', label: ROADMAP_VERBS.share, Icon: Share, callback: onShare },
    { verb: 'export', label: ROADMAP_VERBS.export, Icon: Download, callback: onExport },
    { verb: 'settings', label: ROADMAP_VERBS.settings, Icon: Sun, callback: onSettings },
  ].filter(({ callback }) => callback);

  return (
    <Sheet host={document.body} variant="roadmap" className={sheetClass}
      style={searchable && !activityPage ? viewport.style : undefined}
      title={activityPage ? ACTIVITY.heading : ROADMAP_SHEET.title} onClose={close}
      onPointerDownCapture={() => { consumedSwipe.current = false; }}
      onClickCapture={(event) => {
        if (!consumedSwipe.current || event.detail === 0) return;
        consumedSwipe.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      headingStart={activityPage && <button ref={backButton} type="button" className="st-roadmap-sheet-back"
        aria-label={STEP_DETAIL.back} onClick={back}><ChevronLeft size={20} strokeWidth={1.7} aria-hidden /></button>}>
      {activityPage ? (
        <div ref={content} className="st-roadmap-sheet-activity" tabIndex={-1}
          onPointerDown={(event) => {
            if (event.pointerType !== 'touch' || !event.isPrimary) {
              edgeSwipe.current = null;
              return;
            }
            const left = event.currentTarget.closest('[role="dialog"]').getBoundingClientRect().left;
            if (event.clientX > left + 24) return;
            edgeSwipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          }}
          onPointerCancel={() => { edgeSwipe.current = null; }}
          onPointerUp={(event) => {
            const start = edgeSwipe.current;
            edgeSwipe.current = null;
            if (!start || start.id !== event.pointerId) return;
            if (event.clientX - start.x < 80 || Math.abs(event.clientY - start.y) > 40) return;
            consumedSwipe.current = true;
            event.preventDefault();
            back();
          }}>
          <ActivityRows groups={activity.groups} nodesById={activity.nodesById} onOpenStep={openActivityStep} />
        </div>
      ) : <>
        <div ref={content} className="st-roadmap-sheet-content" tabIndex={-1}>
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
            {activity && (
              <button ref={activityButton} type="button" className="st-roadmap-sheet-link" onClick={() => {
                flushSync(() => setPage('activity'));
                track('roadmap_verb', { verb: 'activity', door: 'sheet', view: view === 'tree' ? 'graph' : 'board', band });
              }}>
                <Activity size={20} strokeWidth={1.7} aria-hidden />
                <span>{ROADMAP_VERBS.activity}</span>
                <ChevronRight size={20} strokeWidth={1.7} aria-hidden />
              </button>
            )}
          </>}
          <h4 id={roadmapsId} className="st-roadmap-sheet-label">{listHeading}</h4>
          <div className="st-roadmap-sheet-trees" role="group" aria-labelledby={roadmapsId}>
            {matches.map(({ tree, match }) => {
              const selected = tree.id === current.id;
              const beforeMatch = tree.title.slice(0, match.start);
              const matchedText = tree.title.slice(match.start, match.end);
              const afterMatch = tree.title.slice(match.end);
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
                  <span className="st-roadmap-sheet-tree-name">{matching ? <>
                    {beforeMatch}
                    <mark>{matchedText}</mark>
                    {afterMatch}
                  </> : tree.title}</span>
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
          <div className={`st-roadmap-sheet-search-bar${viewport.keyboardVisible ? ' st-roadmap-sheet-search-bar--keyboard' : ''}`}>
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
      </>}
    </Sheet>
  );
}
