import { useEffect, useState } from 'react';
import { PHONE_WORKING_ZOOM, WORKING_ZOOM } from '../theme.js';
import { SkillTreeScene } from '../scene/SkillTreeScene.js';

// The canvas's scene, constructed once per set of write handlers; only the desktop editor's scene takes gestures that write.
export function useRoomScene({ anchors, sceneRef, desktopEditorRef, breakpoint, editing, selection, reorderHint, onPickNothing, showToast }) {
  const { canvasRef, rootRef } = anchors;
  const [scene, setScene] = useState(null);
  const [panning, setPanning] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);
  const { handleCreateChild, handleConnect, deleteNodeAt, handleSetKind, handleDeleteEdge, handleReconnect, reorderContext, handleSetNodeOrder } = editing;
  const { setSelectedId, selectedIdsRef, selectedEdgesRef, onSelectionToggle, onMarqueeSelect, onEdgeToggle, onEdgePick } = selection;

  useEffect(() => {
    const writes = !desktopEditorRef.current ? {} : {
      onCreateChild: handleCreateChild,
      onConnectNodes: handleConnect,
      onDeleteNode: deleteNodeAt,
      onSetKind: handleSetKind,
      onDeleteEdge: handleDeleteEdge,
      onReconnectEdge: handleReconnect,
      onSelectionToggle,
      onMarqueeSelect,
      onEdgeToggle,
      onEdgePick,
      reorderContext,
      onSetNodeOrder: handleSetNodeOrder,
    };
    const nextScene = new SkillTreeScene(canvasRef.current, {
      readOnly: !desktopEditorRef.current,
      reorderHint: reorderHint(),
      onPanStateChange: setPanning,
      onNodePick: (id) => {
        if (id) { setSelectedId(id); return; }
        if (selectedIdsRef.current.size > 0 || selectedEdgesRef.current.size > 0) setSelectedId(null);
        else onPickNothing();
      },
      onNodeHover: setHoveredId,
      onCeremonyToast: (message, options) => showToast(message, { ...options, surface: 'graph' }),
      ...writes,
    });
    sceneRef.current = nextScene;
    setScene(nextScene);
    nextScene.start();

    const observer = new ResizeObserver(() => nextScene.resize());
    observer.observe(rootRef.current);

    return () => {
      observer.disconnect();
      nextScene.dispose();
      sceneRef.current = null;
      setScene(null);
    };
  }, [handleCreateChild, handleConnect, deleteNodeAt, handleSetKind, handleDeleteEdge, handleReconnect, showToast, onSelectionToggle, onMarqueeSelect, onEdgeToggle, onEdgePick]);

  useEffect(() => {
    scene?.setWorkingZoom(breakpoint === 'phone' ? PHONE_WORKING_ZOOM : WORKING_ZOOM);
  }, [scene, breakpoint]);

  return { scene, panning, hoveredId };
}
