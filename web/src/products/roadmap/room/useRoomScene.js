import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PHONE_WORKING_ZOOM, WORKING_ZOOM } from '../theme.js';
import { GraphUnavailable, SkillTreeScene } from '../scene/SkillTreeScene.js';
import { track } from '../../../telemetry/beacon.js';

// The canvas's scene, constructed once per set of write handlers; only the desktop editor's scene takes gestures that write.
export function useRoomScene({ anchors, sceneRef, desktopEditorRef, breakpoint, editing, selection, reorderHint, onPickNothing, showToast }) {
  const { canvasRef, rootRef } = anchors;
  const unavailableRef = useRef(false);
  const [graphUnavailable, setGraphUnavailable] = useState(null);
  const [scene, setScene] = useState(null);
  const [panning, setPanning] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);
  const { handleCreateChild, handleConnect, deleteNodeAt, handleSetKind, handleDeleteEdge, handleReconnect, reorderContext, handleSetNodeOrder } = editing;
  const { setSelectedId, selectedIdsRef, selectedEdgesRef, onSelectionToggle, onMarqueeSelect, onEdgeToggle, onEdgePick } = selection;

  useLayoutEffect(() => {
    if (unavailableRef.current) return undefined;
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
    let nextScene;
    try {
      nextScene = new SkillTreeScene(canvasRef.current, {
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
    } catch (error) {
      if (!(error instanceof GraphUnavailable)) throw error;
      unavailableRef.current = true;
      setGraphUnavailable(true);
      track('webgl_init_fail', { band: breakpoint });
      return undefined;
    }
    setGraphUnavailable(false);
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

  return { scene, graphUnavailable, panning, hoveredId };
}
