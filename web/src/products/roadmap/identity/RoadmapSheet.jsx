import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Activity, Check, ChevronLeft, ChevronRight, Compass, Download, Plus, Search, Share, Sparkles, Sun, X } from 'lucide-react';
import { flushSync } from 'react-dom';
import { track } from '../../../telemetry/beacon.js';
import { hueOf } from '../theme.js';
import { ActivityRows } from '../activity/ActivityRows.jsx';
import { roadmapMatch, SEARCH_THRESHOLD } from './roadmapSearch.js';
import { Sheet } from '../board/BoardControls.jsx';
import { useComposerViewport } from '../step/composerFocus.js';
import { ACTIVITY, COMPACT_COUNT_THRESHOLD, GUIDE, LABELS, ROADMAP_SHEET, ROADMAP_VERBS, STEP_DETAIL, exactProgress, progressFigure, progressLabel, roadmapMatches, roadmapsHeading } from '../copy.js';
import { GuidePage, GuideRow } from '../guide/GuidePhone.jsx';
import { hasGuide } from '../guide/GuideDraft.js';
import './identity.css';

// `guide` is the owner's guide: its row under the roadmap's name, and its page beside Activity's.
export function RoadmapSheet({ sheet, guide = null, view, band, onAskAI, onShare, onExport, onSettings, onClose }) {
  const { current, listTrees } = sheet;
  const [loaded, setLoaded] = useState(null);
  const roadmapsId = useId();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(null);
  const activityButton = useRef(null);
  const guideButton = useRef(null);
  const backButton = useRef(null);
  const content = useRef(null);
  const previousPage = useRef(null);
  const edgeSwipe = useRef(null);
  const consumedSwipe = useRef(false);
  const activity = band === 'phone' ? sheet.activity : null;
  const activityPage = page === 'activity' && Boolean(activity);
  const guidePage = page === 'guide' && hasGuide(guide?.text);
  const shownPage = activityPage ? 'activity' : guidePage ? 'guide' : null;
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

  // A page takes focus to its back chevron; leaving one hands it to the row that opened it, or to the sheet's close.
  useLayoutEffect(() => {
    const left = previousPage.current;
    previousPage.current = shownPage;
    if (shownPage) {
      backButton.current?.focus();
      return;
    }
    if (!left) return;
    const entry = { activity: activityButton, guide: guideButton }[left].current;
    (entry ?? content.current?.closest('[role="dialog"]')?.querySelector('.st-board-sheet-close'))?.focus();
    setPage(null);
  }, [shownPage]);

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
    if (via === 'escape' && shownPage) {
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
  const entryClass = activity && !searchable ? 'st-roadmap-sheet--page-entry' : searchClass;
  const guideClass = guide ? `st-roadmap-sheet--guide-${hasGuide(guide.text) ? 'written' : 'empty'}` : '';
  const sheetClass = [shownPage ? 'st-roadmap-sheet--page' : entryClass, guideClass].filter(Boolean).join(' ');
  const pageTitles = { activity: ACTIVITY.heading, guide: GUIDE.title };
  const pageBody = {
    ref: content,
    tabIndex: -1,
    onPointerDown: (event) => {
      if (event.pointerType !== 'touch' || !event.isPrimary) {
        edgeSwipe.current = null;
        return;
      }
      const left = event.currentTarget.closest('[role="dialog"]').getBoundingClientRect().left;
      if (event.clientX > left + 24) return;
      edgeSwipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerCancel: () => { edgeSwipe.current = null; },
    onPointerUp: (event) => {
      const start = edgeSwipe.current;
      edgeSwipe.current = null;
      if (!start || start.id !== event.pointerId) return;
      if (event.clientX - start.x < 80 || Math.abs(event.clientY - start.y) > 40) return;
      consumedSwipe.current = true;
      event.preventDefault();
      back();
    },
  };
  const verbs = [
    { verb: 'askAI', label: ROADMAP_VERBS.askAI, Icon: Sparkles, callback: onAskAI },
    { verb: 'share', label: ROADMAP_VERBS.share, Icon: Share, callback: onShare },
    { verb: 'export', label: ROADMAP_VERBS.export, Icon: Download, callback: onExport },
    { verb: 'settings', label: ROADMAP_VERBS.settings, Icon: Sun, callback: onSettings },
  ].filter(({ callback }) => callback);

  return (
    <Sheet host={document.body} variant="roadmap" className={sheetClass}
      style={searchable && !shownPage ? viewport.style : undefined}
      title={shownPage ? pageTitles[shownPage] : ROADMAP_SHEET.title} onClose={close}
      onPointerDownCapture={() => { consumedSwipe.current = false; }}
      onClickCapture={(event) => {
        if (!consumedSwipe.current || event.detail === 0) return;
        consumedSwipe.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      headingStart={shownPage && <button ref={backButton} type="button" className="st-roadmap-sheet-back"
        aria-label={STEP_DETAIL.back} onClick={back}><ChevronLeft size={20} strokeWidth={1.7} aria-hidden /></button>}>
      {activityPage && (
        <div className="st-roadmap-sheet-activity" {...pageBody}>
          <ActivityRows groups={activity.groups} nodesById={activity.nodesById} onOpenStep={openActivityStep} />
        </div>
      )}
      {guidePage && <div className="st-guide-page" {...pageBody}><GuidePage guide={guide} /></div>}
      {!shownPage && <>
        <div ref={content} className="st-roadmap-sheet-content" tabIndex={-1}>
          {!matching && <>
            <h3 className="st-roadmap-sheet-name">{current.title}</h3>
            {current.total >= COMPACT_COUNT_THRESHOLD && <p className="st-roadmap-sheet-progress">{currentProgress}</p>}
            {guide && <GuideRow guide={guide} rowRef={guideButton} onOpen={() => flushSync(() => setPage('guide'))} />}
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
