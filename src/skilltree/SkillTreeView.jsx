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
import { repositionNode } from './editing/edits.js';

const layoutEngine = new WorkerLayoutEngine();
const EMPTY_BOUNDS = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

export function SkillTreeView() {
  const canvasRef = useRef(null);
  const rootRef = useRef(null);
  const sceneRef = useRef(null);
  const progressRef = useRef({ completed: new Set(), inProgress: new Set() });
  const editorRef = useRef(null);
  const rawLayoutRef = useRef(new Map());
  const completedRef = useRef(new Set());

  const [datasetSize, setDatasetSize] = useState('demo');
  const [loading, setLoading] = useState(true);
  const [tree, setTree] = useState(null);
  const [renderModel, setRenderModel] = useState(null);
  const [completed, setCompleted] = useState(() => new Set());
  const [selectedId, setSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [bounds, setBounds] = useState(EMPTY_BOUNDS);
  const [scene, setScene] = useState(null);

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

  // Construct the scene once; React only ever drives it through the methods below.
  useEffect(() => {
    const nextScene = new SkillTreeScene(canvasRef.current, {
      onNodePick: (id) => setSelectedId(id),
      onNodeHover: (id) => setHoveredId(id),
      onNodeMoveEnd: handleNodeMoved,
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
  }, [handleNodeMoved]);

  // Keyboard history: ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Shift+Z redo.
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

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

      {loading && <div className="st-loading">Planting the tree…</div>}
    </div>
  );
}
