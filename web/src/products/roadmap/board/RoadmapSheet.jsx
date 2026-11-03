import React, { useEffect, useId, useState } from 'react';
import { Check, ChevronRight, Compass, Download, Plus, Share, Sparkles, Sun } from 'lucide-react';
import { track } from '../../../telemetry/beacon.js';
import { hueOf } from '../theme.js';
import { Sheet } from './BoardControls.jsx';
import { COMPACT_COUNT_THRESHOLD, ROADMAP_SHEET, ROADMAP_VERBS, exactProgress, progressFigure, progressLabel } from './copy.js';

export function RoadmapSheet({ sheet, view, band, onAskAI, onShare, onExport, onSettings, onClose }) {
  const { current, listTrees } = sheet;
  const [loaded, setLoaded] = useState(null);
  const roadmapsId = useId();

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
  const verbs = [
    { verb: 'askAI', label: ROADMAP_VERBS.askAI, Icon: Sparkles, callback: onAskAI },
    { verb: 'share', label: ROADMAP_VERBS.share, Icon: Share, callback: onShare },
    { verb: 'export', label: ROADMAP_VERBS.export, Icon: Download, callback: onExport },
    { verb: 'settings', label: ROADMAP_VERBS.settings, Icon: Sun, callback: onSettings },
  ].filter(({ callback }) => callback);

  return (
    <Sheet host={document.body} variant="roadmap" title={ROADMAP_SHEET.title} onClose={close}>
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
      <h4 id={roadmapsId} className="st-roadmap-sheet-label">{ROADMAP_SHEET.yourRoadmaps}</h4>
      <div className="st-roadmap-sheet-trees" role="group" aria-labelledby={roadmapsId}>
        {rows.map((tree) => {
          const selected = tree.id === current.id;
          const progress = { done: tree.done ?? 0, total: tree.total ?? 0 };
          const hue = hueOf(tree.dominantKind).base;
          return (
            <button
              key={tree.id}
              type="button"
              className="st-roadmap-sheet-tree"
              aria-current={selected || undefined}
              onClick={() => {
                if (selected) {
                  onClose('act');
                  return;
                }
                act(() => sheet.onPickTree(tree.id), { name: 'roadmap_sheet', props: { step: 'switch' } });
              }}
            >
              <span className="st-roadmap-sheet-dot" style={{ background: hue }} aria-hidden />
              <span className="st-roadmap-sheet-tree-name">{tree.title}</span>
              <span className="st-roadmap-sheet-count" aria-label={progressLabel(progress)}>{progressFigure({ ...progress, compact: true })}</span>
              <span className="st-roadmap-sheet-check" aria-hidden>{selected && <Check size={20} strokeWidth={1.7} />}</span>
            </button>
          );
        })}
      </div>
      {sheet.onNewRoadmap && (
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
    </Sheet>
  );
}
