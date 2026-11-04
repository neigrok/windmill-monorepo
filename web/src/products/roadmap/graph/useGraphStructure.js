import { useCallback, useRef, useState } from 'react';
import { layoutTree } from '../layout/index.js';
import { SkillTree } from '../model/SkillTree.js';
import { UnlockRules } from '../model/UnlockRules.js';
import { makeRenderable } from '../model/renderableGraph.js';
import { GRAPH_TOAST, cycleToast, keptStepsToast } from '../copy.js';

const NO_BOUNDS = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

// From a changed lattice to the picture: validate the DAG, lay it out, hand the scene its model and offer back masked work.
export function useGraphStructure({ room, progressActs, showToast, syncLegendFromTree }) {
  const { projectionRef, sceneRef, treeRef, sessionRef } = room;
  const [tree, setTree] = useState(null);
  const [renderModel, setRenderModel] = useState(null);
  const [bounds, setBounds] = useState(NO_BOUNDS);
  const layoutRef = useRef(null); // the requested engine, and the name of the engine that produced the current picture
  const layoutCacheRef = useRef({ signature: '', result: null });
  const invalidRef = useRef(false);
  const maskedShownRef = useRef('');

  // Everything a layout reads: the engine, the DAG and order (the trunk), color and createdAt (trunk election and
  // sibling ties) — and the label only for an engine that reserves each caption's box, so a rename never re-runs the
  // others.
  const layoutPositions = useCallback((nextTree) => {
    const { requestedName, engine } = layoutRef.current;
    const readsCaptions = engine.constructor.readsCaptions;
    const rows = nextTree.allNodes.map((node) => JSON.stringify([
      node.id, [...node.prerequisites].sort(), node.order ?? '', node.color ?? '', node.createdAt ?? null,
      readsCaptions ? node.label : '',
    ]));
    const signature = `${requestedName}|${rows.sort().join('|')}`;
    if (layoutCacheRef.current.signature !== signature) {
      layoutCacheRef.current = { signature, result: layoutTree(engine, nextTree) };
    }
    const result = layoutCacheRef.current.result;
    layoutRef.current.name = result.name;
    sceneRef.current?.setReorderHint(result.engine.constructor.reorder);
    return new Map(result.positions);
  }, []);

  // Every structural edit and undo/redo funnels through here; new SkillTree re-validates the DAG.
  const syncStructure = useCallback(() => {
    const projection = projectionRef.current;
    const sceneNow = sceneRef.current;
    if (!projection || !sceneNow) return;

    // A concurrent edit can leave a cycle: render without those edges and surface it.
    let nextTree;
    let cycles = null;
    try {
      nextTree = new SkillTree(projection);
    } catch {
      const renderable = makeRenderable(projection);
      nextTree = new SkillTree(renderable.tree);
      cycles = renderable.cycles;
    }

    // A tree no engine can lay out keeps the picture it has: the edit lives in the lattice and the next one retries.
    let positions;
    try {
      positions = layoutPositions(nextTree);
    } catch (error) {
      console.error('[layout] the edit could not be laid out; the picture is one step behind', error);
      showToast(GRAPH_TOAST.undrawnEdit, { act: 'notice' });
      return;
    }
    const nextStates = UnlockRules.derive(nextTree, progressActs.snapshot);
    const model = nextTree.toRenderModel(positions, nextStates);
    sceneNow.applyModel(model);
    treeRef.current = nextTree;
    setTree(nextTree);
    setRenderModel(model);
    setBounds(sceneNow.getBounds());

    const invalid = !!(cycles && cycles.length > 0);
    if (invalid && !invalidRef.current) {
      const labelOf = (id) => projection.nodes.find((n) => n.id === id)?.label || id;
      const ring = cycles[0];
      console.log('[loose] rendering invalid graph, cycles:', cycles);
      showToast(cycleToast({ ring: [...ring, ring[0]].map(labelOf) }), { act: 'notice' });
    }
    invalidRef.current = invalid;
  }, [layoutPositions, showToast]);

  const onTreeChanged = useCallback((treeData) => {
    if (!projectionRef.current) return;
    projectionRef.current = treeData;
    syncStructure();
    syncLegendFromTree(treeData);

    const masked = sessionRef.current?.maskedWork?.() ?? [];
    const key = masked.map((m) => m.id).sort().join(',');
    if (masked.length && key !== maskedShownRef.current) {
      maskedShownRef.current = key;
      const count = masked.reduce((sum, m) => sum + m.children.length, 0);
      showToast(keptStepsToast({ count }), {
        act: 'notice',
        action: { label: GRAPH_TOAST.restore, run: () => masked.forEach((m) => sessionRef.current?.dispatch({ kind: 'ResurrectNode', id: m.id })) },
      });
    } else if (!masked.length) {
      maskedShownRef.current = '';
    }
  }, [syncStructure, showToast, syncLegendFromTree]);

  const install = useCallback((nextTree, model, nextBounds) => {
    setTree(nextTree);
    setRenderModel(model);
    setBounds(nextBounds);
  }, []);

  const reorderHint = useCallback(() => layoutCacheRef.current.result?.engine.constructor.reorder ?? 'none', []);

  return { tree, renderModel, bounds, setBounds, layoutRef, layoutPositions, reorderHint, install, onTreeChanged };
}
