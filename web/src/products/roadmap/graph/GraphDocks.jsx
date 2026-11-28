// Graph seats retain creation's blank-name handoff, tablet tools, paste and Activity.

import React, { useMemo } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { ActivityFeed } from '../activity/ActivityFeed.jsx';
import { deletable } from '../board/acts.js';
import { readEffects } from '../model/domainReads.js';
import { emptyWorkspace } from '../model/NodeWorkspace.js';
import { GraphDock } from './GraphChrome.jsx';
import { StepPanel } from './StepPanel.jsx';
import { TabletPanel } from './tablet/TabletPanel.jsx';

function relatedStep(node, states) {
  const state = states.get(node.id) ?? 'locked';
  return { id: node.id, label: node.label, color: node.color, state, complete: state === 'complete' };
}

export function GraphDocks({
  namingStep = false, who, open, top, canvasView, tree, standingTree, states, selection, selectedNode, selectedState, progress, legend, editing, progressActs, tablet, bulkChoice,
  composer, activity, onCloseActivity, workspaceByNode, workspaceActions, onJump, sceneRef, hoveredId, onLegendPicker,
}) {
  const { desktopEditor, tabletEditor } = who;
  const { selectedId, selectedIds, setSelectedId, leaveMulti } = selection;
  const nodesById = tree?.nodesById ?? new Map();

  const prerequisites = useMemo(() => (selectedNode
    ? selectedNode.prerequisites.map((id) => relatedStep(nodesById.get(id) ?? { id, label: id }, states))
    : []), [selectedNode, nodesById, states]);
  const unlocks = useMemo(() => (selectedNode && tree
    ? readEffects(tree, [selectedNode.id]).follow.map((id) => relatedStep(tree.nodesById.get(id), states))
    : []), [selectedNode, tree, states]);

  const autoFocusName = selectedId !== null && selectedId === editing.autoFocusNameId;
  const stepDeletable = selectedNode !== null && deletable(standingTree, [selectedNode.id]);
  const stepFacts = {
    node: selectedNode,
    roadmap: tree?.title,
    state: selectedState,
    prerequisites,
    completedAt: progress.completedAt[selectedId],
    history: activity.selectedHistory,
    workspace: workspaceByNode[selectedId] ?? emptyWorkspace(),
    legend,
    onReveal: (id) => sceneRef.current?.revealNode(id),
    onClose: () => setSelectedId(null),
  };
  const markSelected = () => {
    if (!selectedId) return;
    if (progressActs.complete(selectedId) === false) return;
    track('roadmap_board_complete', { door: 'dock' });
  };

  return (
    <>
      {desktopEditor && (
        <GraphDock open={open} top={top} tenant={composer ? 'composer' : namingStep ? selectedNode.id : 'activity'}>
          {composer ?? (namingStep ? (
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
                if (progressActs.reset(id) === false) return;
                track('roadmap_board_step_action', { surface: 'dock', action: 'reset' });
              }}
              deletable={stepDeletable}
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

      {tabletEditor && (
        <TabletPanel
          tablet={tablet}
          open={canvasView && tablet.surface !== 'empty' && (tablet.surface !== 'editor' || namingStep)}
          top={top}
          selectedNode={selectedNode}
          selectedState={selectedState}
          nodesById={nodesById}
          prerequisites={prerequisites}
          unlocks={unlocks}
          completedAt={progress.completedAt[selectedId]}
          legend={legend}
          autoFocusName={autoFocusName}
          deletable={stepDeletable}
          onMarkDone={(id) => {
            if (progressActs.complete(id) === false) return;
            track('roadmap_board_complete', { door: 'panel' });
          }}
          onUnmarkDone={(id) => {
            if (progressActs.reset(id) === false) return;
            track('roadmap_board_step_action', { surface: 'panel', action: 'reset' });
          }}
          onDelete={editing.deleteNodeAt}
          onJump={onJump}
          selectedCount={selectedIds.size}
          bulkChoice={bulkChoice}
          onBulkRecolor={editing.bulkRecolor}
          onBulkDelete={readEffects(standingTree, [...selectedIds])?.takesEveryStart ? null : editing.bulkDelete}
          onBulkDone={leaveMulti}
        />
      )}
    </>
  );
}
