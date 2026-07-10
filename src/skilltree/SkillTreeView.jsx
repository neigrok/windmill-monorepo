// Skill-tree view — runs the pipeline (repository → domain → layout → scene)
// and hosts the overlay UI around the GPU canvas: top controls, the docked
// step panel, and a minimap. No business logic lives here — every node
// state comes from UnlockRules.derive; this file only wires data through.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './skilltree.css';
import { ControlBar } from './ui/ControlBar.jsx';
import { StepPanel } from './ui/StepPanel.jsx';
import { Minimap } from './ui/Minimap.jsx';
import { SkillTree } from './model/SkillTree.js';
import { UnlockRules } from './model/UnlockRules.js';
import { WorkerLayoutEngine } from './layout/WorkerLayoutEngine.js';
import { applyNudges } from './layout/applyNudges.js';
import { MockTreeRepository } from './mock/MockTreeRepository.js';
import { TreeStore } from './persistence/TreeStore.js';
import { SkillTreeScene } from './scene/SkillTreeScene.js';
import { TreeEditor } from './editing/TreeEditor.js';
import { repositionNode, addChildNode, renameNode, deleteNode, addEdge, removeEdge, reconnectEdge, setNodeColor } from './editing/edits.js';
import { NODE_SIZE } from './theme.js';

const layoutEngine = new WorkerLayoutEngine();
const treeStore = new TreeStore();
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
  const seedRef = useRef(null); // authored tree for the current dataset (persistence baseline)
  const datasetSizeRef = useRef('demo');
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
  const [autoFocusNameId, setAutoFocusNameId] = useState(null); // freshly created bud → StepPanel focuses its name field
  const [toast, setToast] = useState(null); // { message } shown briefly after a destructive edit
  const [hasLocalEdits, setHasLocalEdits] = useState(false); // local edits overlaid on the authored seed
  const [reloadKey, setReloadKey] = useState(0); // bump to re-run the load pipeline (e.g. after reset)

  // Save the edited tree over its seed. Only the dogfood roadmap persists — the
  // huge perf tree is a throwaway. Every structural edit, undo/redo, and move
  // funnels here, so the browser always reloads the latest edit.
  const persistEdits = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !seedRef.current || datasetSizeRef.current !== 'demo') return;
    treeStore.save(seedRef.current, editor.treeData);
    setHasLocalEdits(true);
  }, []);

  // Discard local edits and reload the authored seed fresh (clears history too).
  const handleResetEdits = useCallback(() => {
    if (seedRef.current) treeStore.clear(seedRef.current.id);
    setReloadKey((key) => key + 1);
  }, []);

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
    persistEdits();
  }, [persistEdits]);

  // A node was dragged to a new spot: record it as one edit. The scene is already
  // showing the new position, so only history + the minimap need updating.
  const handleNodeMoved = useCallback((id, x, y) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.commit(repositionNode(editor.treeData, id, x, y));
    setRenderModel((model) => (model ? { ...model } : model));
    persistEdits();
  }, [persistEdits]);

  const undo = useCallback(() => { if (editorRef.current?.undo()) syncStructure(); }, [syncStructure]);
  const redo = useCallback(() => { if (editorRef.current?.redo()) syncStructure(); }, [syncStructure]);

  // The panel's name field committed (Enter/blur): one history step, and only
  // if the label actually changed.
  const handleRename = useCallback((id, label) => {
    const editor = editorRef.current;
    if (!editor) return;
    const node = editor.treeData.nodes.find((n) => n.id === id);
    if (!node || node.label === label) return;
    editor.commit(renameNode(editor.treeData, id, label));
    syncStructure();
  }, [syncStructure]);

  // Plus clicked: create + commit an unnamed bud (saved even unnamed), select it,
  // and flag the step panel to focus its name field so typing flows straight in.
  const handleCreateChild = useCallback((parentId) => {
    const scene = sceneRef.current;
    const editor = editorRef.current;
    const parent = scene?.nodesById.get(parentId);
    if (!parent || !editor) return;

    // spread successive new children beside each other rather than stacking
    const placed = editor.treeData.nodes.filter((n) => n.position && n.prerequisites.includes(parentId)).length;
    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    const params = { id, label: '', icon: NEW_NODE_ICON, color: parent.color, parentId, x: parent.x + placed * SIBLING_GAP, y: parent.y + CHILD_DROP };
    editor.commit(addChildNode(editor.treeData, params));
    syncStructure();
    scene.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
  }, [syncStructure]);

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

  // Drag an edge endpoint to a new node → re-aim it in one undoable step. The
  // gesture already blocked cycles and dropping back on the original end.
  const handleReconnect = useCallback((oldFrom, oldTo, newFrom, newTo) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.commit(reconnectEdge(editor.treeData, oldFrom, oldTo, newFrom, newTo))) syncStructure();
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
      onConnectNodes: handleConnect,
      onDeleteNode: deleteNodeAt,
      onSetKind: handleSetKind,
      onDeleteEdge: handleDeleteEdge,
      onReconnectEdge: handleReconnect,
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
  }, [handleNodeMoved, handleCreateChild, handleConnect, deleteNodeAt, handleSetKind, handleDeleteEdge, handleReconnect]);

  // Keyboard: ⌘Z / ⇧⌘Z history, ⌫ / Delete removes the selection, Esc deselects.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.key === 'Escape') {
        if (!selectedIdRef.current) return;
        setSelectedId(null);
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

  // The autofocus flag is for the bud's first appearance only — once the
  // selection moves elsewhere, re-selecting it later must not steal focus.
  useEffect(() => {
    if (autoFocusNameId && selectedId !== autoFocusNameId) setAutoFocusNameId(null);
  }, [selectedId, autoFocusNameId]);

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
      const seed = await repo.loadTree();
      // Overlay any locally-saved edits on the seed (dogfood roadmap only); a
      // changed seed invalidates them inside the store, so code wins over state.
      const persisted = datasetSize === 'demo' ? treeStore.load(seed) : null;
      const treeData = persisted ?? seed;
      if (!cancelled) setHasLocalEdits(!!persisted);
      const nextTree = new SkillTree(treeData);
      const progress = await repo.loadProgress(treeData);
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
      seedRef.current = seed;
      datasetSizeRef.current = datasetSize;
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
  }, [datasetSize, reloadKey]);

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
        canReset={hasLocalEdits}
        onResetEdits={handleResetEdits}
      />

      <Minimap
        nodes={renderModel?.nodes ?? []}
        states={states}
        bounds={bounds}
        subscribeViewport={scene?.subscribeViewport ?? null}
        onPanTo={handlePanTo}
      />

      <aside className={`st-detail-panel ${selectedNode ? 'st-detail-panel--open' : ''}`}>
        <StepPanel
          key={selectedNode?.id}
          node={selectedNode}
          state={selectedState}
          prerequisites={prerequisites}
          canComplete={selectedState === 'available' || selectedState === 'active'}
          autoFocusName={selectedId !== null && selectedId === autoFocusNameId}
          onRename={handleRename}
          onPreviewKind={(id, kind) => sceneRef.current?.previewKind(id, kind)}
          onRestoreKind={(id) => sceneRef.current?.restoreKind(id)}
          onSetKind={handleSetKind}
          onMarkComplete={handleMarkComplete}
          onDelete={deleteNodeAt}
          onPreviewDeleteCost={(id) => sceneRef.current?.previewDeleteCost(id)}
          onClearDeleteCost={() => sceneRef.current?.clearDeleteCost()}
          onClose={() => setSelectedId(null)}
        />
      </aside>

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
