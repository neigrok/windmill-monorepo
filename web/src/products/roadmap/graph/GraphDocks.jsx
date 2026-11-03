// The Graph's right-hand seats by band and role: the desktop editor's dock, the tablet owner's panel, and a reader's dock.

import React, { useMemo } from 'react';
import { Icon, IconButton } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { ActivityFeed } from '../activity/ActivityFeed.jsx';
import { ActivityRows } from '../activity/ActivityRows.jsx';
import { deletable } from '../board/acts.js';
import { LABELS, ROADMAP_VERBS } from '../copy.js';
import { emptyWorkspace } from '../model/NodeWorkspace.js';
import { GraphDock } from './GraphChrome.jsx';
import { StepPanel } from './StepPanel.jsx';
import { TabletPanel } from './tablet/TabletPanel.jsx';

function relatedStep(node, states) {
  const state = states.get(node.id) ?? 'locked';
  return { id: node.id, label: node.label, color: node.color, state, complete: state === 'complete' };
}

export function GraphDocks({
  who, open, top, canvasView, tree, states, selection, selectedNode, selectedState, progress, legend, editing, progressActs, tablet, bulkChoice,
  composer, activity, activityOpen, onCloseActivity, onOpenActivityStep, workspaceByNode, workspaceActions, onJump, sceneRef, hoveredId, onLegendPicker,
}) {
  const { desktopEditor, tabletEditor, phone, demo, breakpoint } = who;
  const { selectedId, selectedIds, setSelectedId, leaveMulti } = selection;
  const nodesById = tree?.nodesById ?? new Map();

  const prerequisites = useMemo(() => (selectedNode
    ? selectedNode.prerequisites.map((id) => relatedStep(nodesById.get(id) ?? { id, label: id }, states))
    : []), [selectedNode, nodesById, states]);
  const unlocks = useMemo(() => (selectedNode && tree
    ? tree.nodes.filter((node) => node.prerequisites.includes(selectedNode.id)).map((node) => relatedStep(node, states))
    : []), [selectedNode, tree, states]);

  const autoFocusName = selectedId !== null && selectedId === editing.autoFocusNameId;
  const stepFacts = {
    node: selectedNode,
    state: selectedState,
    prerequisites,
    completedAt: progress.completedAt[selectedId],
    history: activity.selectedHistory,
    workspace: workspaceByNode[selectedId] ?? emptyWorkspace(),
    kinds: legend,
    onReveal: (id) => sceneRef.current?.revealNode(id),
    onClose: () => setSelectedId(null),
  };
  const markSelected = () => {
    if (!selectedId) return;
    track('roadmap_board_complete', { door: 'dock' });
    progressActs.complete(selectedId);
  };

  return (
    <>
      {desktopEditor && (
        <GraphDock open={open} top={top} tenant={composer ? 'composer' : selectedNode ? selectedNode.id : 'activity'}>
          {composer ?? (selectedNode ? (
            <StepPanel
              {...stepFacts}
              {...workspaceActions}
              autoFocusName={autoFocusName}
              onRename={editing.handleRename}
              onPreviewKind={(id, kind) => sceneRef.current?.previewKind(id, kind)}
              onRestoreKind={(id) => sceneRef.current?.restoreKind(id)}
              onSetKind={editing.handleSetKind}
              onOpenLegend={onLegendPicker}
              onMarkComplete={markSelected}
              onReset={(id) => {
                track('roadmap_board_step_action', { surface: 'dock', action: 'reset' });
                progressActs.reset(id);
              }}
              onDelete={editing.deleteNodeAt}
              onPreviewDeleteCost={(id) => sceneRef.current?.previewDeleteCost(id)}
              onClearDeleteCost={() => sceneRef.current?.clearDeleteCost()}
            />
          ) : activity.feedVisible ? (
            <ActivityFeed
              groups={activity.activityGroups}
              count={activity.eventCount}
              nodesById={nodesById}
              now={Date.now()}
              hoveredId={hoveredId}
              newIds={activity.newEventIds}
              onClose={onCloseActivity}
              onHoverNode={(id) => sceneRef.current?.spotlightNode(id)}
              onLeaveNode={() => sceneRef.current?.spotlightNode(null)}
              onRevealNode={(id) => {
                track('roadmap_verb', { verb: 'activity', door: 'feed', view: 'graph', band: 'desktop' });
                sceneRef.current?.revealNode(id);
              }}
            />
          ) : null)}
        </GraphDock>
      )}

      {activityOpen && breakpoint === 'tablet' && (
        <aside className="st-roadmap-activity-panel" aria-label={ROADMAP_VERBS.activity}>
          <div className="st-roadmap-activity-header">
            <h2>{ROADMAP_VERBS.activity}</h2>
            <IconButton icon={<Icon name="x" size={20} />} label={LABELS.close} onClick={onCloseActivity} />
          </div>
          <ActivityRows groups={activity.activityGroups} nodesById={nodesById} onOpenStep={onOpenActivityStep} />
        </aside>
      )}

      {tabletEditor && (
        <TabletPanel
          tablet={tablet}
          open={tablet.surface !== 'empty' && canvasView}
          top={top}
          selectedNode={selectedNode}
          selectedState={selectedState}
          nodesById={nodesById}
          prerequisites={prerequisites}
          unlocks={unlocks}
          completedAt={progress.completedAt[selectedId]}
          kinds={legend}
          autoFocusName={autoFocusName}
          isRoot={selectedNode !== null && !deletable(tree, [selectedNode.id])}
          onMarkDone={(id) => {
            track('roadmap_board_complete', { door: 'panel' });
            progressActs.complete(id);
          }}
          onUnmarkDone={(id) => {
            track('roadmap_board_step_action', { surface: 'panel', action: 'reset' });
            progressActs.reset(id);
          }}
          onDelete={editing.deleteNodeAt}
          onJump={onJump}
          selectedCount={selectedIds.size}
          bulkChoice={bulkChoice}
          onBulkRecolor={editing.bulkRecolor}
          onBulkDelete={editing.bulkDelete}
          onBulkDone={leaveMulti}
        />
      )}

      {!desktopEditor && !phone && !tabletEditor && (
        <GraphDock open={open} top={top} tablet={breakpoint === 'tablet'} tenant={selectedNode ? selectedNode.id : 'empty'}>
          {selectedNode && (
            <StepPanel
              {...stepFacts}
              readOnly
              unlocks={unlocks}
              onJump={onJump}
              onMarkComplete={demo ? markSelected : undefined}
            />
          )}
        </GraphDock>
      )}
    </>
  );
}
