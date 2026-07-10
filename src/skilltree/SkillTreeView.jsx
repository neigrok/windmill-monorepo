// Skill-tree view — runs the pipeline (repository → domain → layout → scene)
// and hosts the overlay UI around the GPU canvas: top controls, the node
// detail panel, and a minimap. No business logic lives here — every node
// state comes from UnlockRules.derive; this file only wires data through.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './skilltree.css';
import { ControlBar } from './ui/ControlBar.jsx';
import { DetailPanel } from './ui/DetailPanel.jsx';
import { Minimap } from './ui/Minimap.jsx';
import { SkillTree } from './model/SkillTree.js';
import { UnlockRules } from './model/UnlockRules.js';
import { WorkerLayoutEngine } from './layout/WorkerLayoutEngine.js';
import { applyNudges } from './layout/applyNudges.js';
import { MockTreeRepository } from './mock/MockTreeRepository.js';
import { SkillTreeScene } from './scene/SkillTreeScene.js';
import { TreeEditor } from './editing/TreeEditor.js';
import { repositionNode, addChildNode, renameNode, deleteNode, addEdge, removeEdge, setNodeColor } from './editing/edits.js';
import { NODE_SIZE } from './theme.js';

const layoutEngine = new WorkerLayoutEngine();
const EMPTY_BOUNDS = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
const CHILD_DROP = NODE_SIZE * 2.6; // world units a new child spawns below its parent
const SIBLING_GAP = NODE_SIZE * 1.8; // horizontal spread between successive new children
const NEW_NODE_ICON = 'sparkles';

export function SkillTreeView() {
  const canvasRef = useRef(null);
  const rootRef = useRef(null);
  const sceneRef = useRef(null);
  const progressRef = useRef({ completed: new Set(), inProgress: new Set() });
  const editorRef = useRef(null);
  const rawLayoutRef = useRef(new Map());
  const completedRef = useRef(new Set());
  const namingIdRef = useRef(null); // id of the node whose name field is open
  const namingModeRef = useRef('create'); // 'create' (amend) | 'rename' (commit)
  const nameValueRef = useRef('');
  const selectedIdRef = useRef(null);

  const [datasetSize, setDatasetSize] = useState('demo');
  const [loading, setLoading] = useState(true);
  const [tree, setTree] = useState(null);
  const [renderModel, setRenderModel] = useState(null);
  const [completed, setCompleted] = useState(() => new Set());
  const [selectedId, setSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [bounds, setBounds] = useState(EMPTY_BOUNDS);
  const [scene, setScene] = useState(null);
  const [naming, setNaming] = useState(null); // { x, y } screen position of the name field
  const [nameValue, setNameValue] = useState('');
  const [toast, setToast] = useState(null); // { message } shown briefly after a destructive edit

  // Re-derive the whole render model from the editor's current TreeData and apply
  // it to the scene preserving the view. The seam every structural edit + undo/redo
  // funnels through; constructing a SkillTree here also re-validates the DAG.
  const syncStructure = useCallback(() => {
    const editor = editorRef.current;
    const sceneNow = sceneRef.current;
    if (!editor || !sceneNow) return;
    const nextTree = new SkillTree(editor.treeData);
    const positions = applyNudges(rawLayoutRef.current, nextTree);
    const nextStates = UnlockRules.derive(nextTree, { completed: completedRef.current, inProgress: progressRef.current.inProgress });
    const model = nextTree.toRenderModel(positions, nextStates);
    sceneNow.applyModel(model);
    setTree(nextTree);
    setRenderModel(model);
    setBounds(sceneNow.getBounds());
  }, []);

  // A node was dragged to a new spot: record it as one edit. The scene is already
  // showing the new position, so only history + the minimap need updating.
  const handleNodeMoved = useCallback((id, x, y) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.commit(repositionNode(editor.treeData, id, x, y));
    setRenderModel((model) => (model ? { ...model } : model));
  }, []);

  const undo = useCallback(() => { if (editorRef.current?.undo()) syncStructure(); }, [syncStructure]);
  const redo = useCallback(() => { if (editorRef.current?.redo()) syncStructure(); }, [syncStructure]);

  // Apply the open name field to its node. Create: amend the just-committed node
  // (blank stays blank — one undo step with the create). Rename: commit a new step
  // if the label actually changed.
  const applyPendingName = useCallback(() => {
    const editor = editorRef.current;
    const id = namingIdRef.current;
    namingIdRef.current = null;
    if (!editor || !id) return false;
    const label = nameValueRef.current.trim();
    if (namingModeRef.current === 'rename') {
      const node = editor.treeData.nodes.find((n) => n.id === id);
      if (!node || node.label === label) return false;
      editor.commit(renameNode(editor.treeData, id, label));
      return true;
    }
    if (!label) return false;
    editor.amend(renameNode(editor.treeData, id, label));
    return true;
  }, []);

  // Double-click a node → open the inline field pre-filled with its label.
  const handleBeginRename = useCallback((id, label, x, y) => {
    applyPendingName();
    namingIdRef.current = id;
    namingModeRef.current = 'rename';
    nameValueRef.current = label ?? '';
    setNameValue(label ?? '');
    setNaming({ x, y });
  }, [applyPendingName]);

  // Plus clicked: create + commit a child immediately (saved even unnamed), then
  // open an inline field to name it. Clicking + again just saves the last one and
  // adds another.
  const handleCreateChild = useCallback((parentId) => {
    const scene = sceneRef.current;
    const editor = editorRef.current;
    const parent = scene?.nodesById.get(parentId);
    if (!parent || !editor) return;

    applyPendingName();
    // spread successive new children beside each other rather than stacking
    const placed = editor.treeData.nodes.filter((n) => n.position && n.prerequisites.includes(parentId)).length;
    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    const params = { id, icon: NEW_NODE_ICON, color: parent.color, parentId, x: parent.x + placed * SIBLING_GAP, y: parent.y + CHILD_DROP };
    editor.commit(addChildNode(editor.treeData, { ...params, label: '' }));
    namingIdRef.current = id;
    namingModeRef.current = 'create';
    nameValueRef.current = '';
    setNameValue('');
    syncStructure();

    const cam = scene.camera;
    setNaming({
      x: (params.x - cam.x) * cam.zoom + cam.viewportWidth / 2,
      y: (params.y - cam.y) * cam.zoom + cam.viewportHeight / 2,
    });
  }, [syncStructure, applyPendingName]);

  const confirmName = useCallback(() => {
    if (applyPendingName()) syncStructure();
    setNaming(null);
  }, [applyPendingName, syncStructure]);

  const cancelName = useCallback(() => {
    namingIdRef.current = null; // keep the (already saved) node, drop the typed name
    setNaming(null);
  }, []);

  // Drag from a port to a node → add a dependency (one history step). The gesture
  // already blocked cycles before the drop.
  const handleConnect = useCallback((sourceId, targetId) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.commit(addEdge(editor.treeData, sourceId, targetId))) syncStructure();
  }, [syncStructure]);

  // Midpoint × on a branch → drop the edge (silent, one step; ⌘Z restores).
  const handleDeleteEdge = useCallback((sourceId, targetId) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.commit(removeEdge(editor.treeData, sourceId, targetId))) syncStructure();
  }, [syncStructure]);

  // Delete a node; its children splice up to the deleted node's parents (one
  // history step). The one destructive edit that earns a toast.
  const deleteNodeAt = useCallback((id) => {
    const editor = editorRef.current;
    if (!editor || !id) return;
    editor.commit(deleteNode(editor.treeData, id));
    if (selectedIdRef.current === id) setSelectedId(null);
    syncStructure();
    setToast({ message: 'Step deleted' });
  }, [syncStructure]);
  const deleteSelected = useCallback(() => deleteNodeAt(selectedIdRef.current), [deleteNodeAt]);

  const handleSetKind = useCallback((id, kind) => {
    const editor = editorRef.current;
    if (!editor || !id) return;
    if (editor.commit(setNodeColor(editor.treeData, id, kind))) syncStructure();
  }, [syncStructure]);

  // Construct the scene once; React only ever drives it through the methods below.
  useEffect(() => {
    const nextScene = new SkillTreeScene(canvasRef.current, {
      onNodePick: (id) => setSelectedId(id),
      onNodeHover: (id) => setHoveredId(id),
      onNodeMoveEnd: handleNodeMoved,
      onCreateChild: handleCreateChild,
      onRenameNode: handleBeginRename,
      onConnectNodes: handleConnect,
      onDeleteNode: deleteNodeAt,
      onSetKind: handleSetKind,
      onDeleteEdge: handleDeleteEdge,
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
  }, [handleNodeMoved, handleCreateChild, handleBeginRename, handleConnect, deleteNodeAt, handleSetKind, handleDeleteEdge]);

  // Keyboard: ⌘Z / ⇧⌘Z history, ⌫ / Delete removes the selection.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        if (!selectedIdRef.current) return;
        event.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, deleteSelected]);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  // The pipeline itself: repository loads → domain computes → scene renders.
  // Re-runs whenever the dataset toggle swaps demo ↔ huge.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelectedId(null);

    async function loadTree() {
      const repo = new MockTreeRepository({ size: datasetSize });
      const treeData = await repo.loadTree();
      const nextTree = new SkillTree(treeData);
      const progress = await repo.loadProgress(nextTree.id);
      const states = UnlockRules.derive(nextTree, progress);
      const rawLayout = await layoutEngine.layout(nextTree);
      const positions = applyNudges(rawLayout, nextTree);
      const model = nextTree.toRenderModel(positions, states);
      if (cancelled) return;

      const scene = sceneRef.current;
      scene.setModel(model);
      scene.fitToView();

      editorRef.current = new TreeEditor(treeData);
      rawLayoutRef.current = rawLayout;
      progressRef.current = progress;
      completedRef.current = new Set(progress.completed);
      setTree(nextTree);
      setRenderModel(model);
      setCompleted(new Set(progress.completed));
      setBounds(scene.getBounds());
      setLoading(false);
    }

    loadTree();
    return () => { cancelled = true; };
  }, [datasetSize]);

  // Single source of truth for node state — every completion ripples through here.
  const states = useMemo(() => {
    if (!tree) return new Map();
    return UnlockRules.derive(tree, { completed, inProgress: progressRef.current.inProgress });
  }, [tree, completed]);

  // Push re-derived states to the scene whenever completion changes; the
  // scene owns the growth animation for newly-unlocked branches.
  useEffect(() => {
    sceneRef.current?.applyStates(states);
  }, [states]);

  useEffect(() => { completedRef.current = completed; }, [completed]);

  const nodesById = useMemo(() => {
    if (!tree) return new Map();
    return new Map(tree.nodes.map((node) => [node.id, node]));
  }, [tree]);

  const selectedNode = selectedId ? nodesById.get(selectedId) ?? null : null;
  const selectedState = selectedId ? states.get(selectedId) ?? 'locked' : null;

  const prerequisites = useMemo(() => {
    if (!selectedNode) return [];
    return selectedNode.prerequisites.map((id) => ({
      id,
      label: nodesById.get(id)?.label ?? id,
      complete: states.get(id) === 'complete',
    }));
  }, [selectedNode, nodesById, states]);

  function handleMarkComplete() {
    if (!selectedId) return;
    setCompleted((prev) => new Set(prev).add(selectedId));
  }

  function handleZoomIn() {
    sceneRef.current?.zoomBy(1.2);
  }

  function handleZoomOut() {
    sceneRef.current?.zoomBy(1 / 1.2);
  }

  function handleFitToView() {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.fitToView();
    setBounds(scene.getBounds());
  }

  function handlePanTo(x, y) {
    sceneRef.current?.panTo(x, y);
  }

  return (
    <div className="st-root" ref={rootRef}>
      <canvas ref={canvasRef} className={`st-canvas ${hoveredId ? 'st-canvas--hover' : ''}`} />

      <ControlBar
        title={tree?.title}
        datasetSize={datasetSize}
        onDatasetSizeChange={setDatasetSize}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onFitToView={handleFitToView}
      />

      <Minimap
        nodes={renderModel?.nodes ?? []}
        states={states}
        bounds={bounds}
        subscribeViewport={scene?.subscribeViewport ?? null}
        onPanTo={handlePanTo}
      />

      <aside className={`st-detail-panel ${selectedNode ? 'st-detail-panel--open' : ''}`}>
        <DetailPanel
          node={selectedNode}
          state={selectedState}
          prerequisites={prerequisites}
          canComplete={selectedState === 'available' || selectedState === 'active'}
          onMarkComplete={handleMarkComplete}
          onClose={() => setSelectedId(null)}
        />
      </aside>

      {naming && (
        <input
          className="st-name-input"
          style={{ left: naming.x, top: naming.y }}
          value={nameValue}
          placeholder="Name this step"
          autoFocus
          onChange={(event) => { nameValueRef.current = event.target.value; setNameValue(event.target.value); }}
          onBlur={confirmName}
          onKeyDown={(event) => {
            event.stopPropagation(); // typing never reaches the ⌘Z history handler
            if (event.key === 'Enter') { event.preventDefault(); confirmName(); }
            else if (event.key === 'Escape') { event.preventDefault(); cancelName(); }
          }}
        />
      )}

      {toast && (
        <div className="st-toast" role="status">
          <span>{toast.message}</span>
          <button className="st-toast-undo" onClick={() => { undo(); setToast(null); }}>Undo</button>
        </div>
      )}

      {loading && <div className="st-loading">Planting the tree…</div>}
    </div>
  );
}
