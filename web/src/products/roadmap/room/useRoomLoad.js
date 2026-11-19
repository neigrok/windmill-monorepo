import { useCallback, useEffect, useRef, useState } from 'react';
import { plantedToast, welcomeBackToast } from '../copy.js';
import { DEMO_TREE_ID } from '../demo/demoStage.js';
import { layoutNameFrom, loadLayoutEngine } from '../layout/index.js';
import { Opening, Openings } from '../model/Opening.js';
import { SkillTree } from '../model/SkillTree.js';
import { UnlockRules } from '../model/UnlockRules.js';
import { deviceOwner } from '../persistence/LocalTreeRegistry.js';
import { PlaceStore } from '../persistence/PlaceStore.js';
import { ReturnLedger } from '../persistence/ReturnLedger.js';
import { peekBorn, takePlantNote } from '../persistence/ViewPrefs.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { frontierTarget, opensOnFrontier, viewportInsets } from '../graph/viewport.js';
import { track } from '../../../telemetry/beacon.js';
import { LatticeReading } from './LatticeReading.js';
import { ReplicaReading } from './ReplicaReading.js';

// A saved camera the layout and its format still mean, and the step that place remembered if the tree still holds it.
function savedPlace(place, seed) {
  const returning = place?.treeId === seed.id ? place : null;
  const camera = returning?.camera && [returning.camera.x, returning.camera.y, returning.camera.zoom].every(Number.isFinite) ? returning.camera : null;
  const selection = returning?.selectedId && seed.nodes.some((node) => node.id === returning.selectedId) ? returning.selectedId : null;
  return { camera, selection };
}

// From the door to a live room: the reading, then domain, layout and the first view, then the reading follows each
// change; a retry runs it again. With `replica` the room reads the device's copy through the sync engine
// (`ReplicaReading`); without it, and for the demo, it reads as it does today (`LatticeReading`).
export function useRoomLoad({ treeId, accountId, demo, shared, demotion, replica = false, breakpoint, placeKept, room, scene, framing, structure, progressActs, activity, legend, workspace, selection, showToast, dismissToast, desktopEditorRef, onRemoteProgress }) {
  const { sceneRef, sessionRef, replicaRef, projectionRef, treeRef, seedRef } = room;
  const [placeStore] = useState(() => new PlaceStore());
  const [returnLedger] = useState(() => new ReturnLedger());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [treeVisibility, setTreeVisibility] = useState(null); // 'private'|'unlisted'|'public'|null
  const [treeMine, setTreeMine] = useState(false);
  const [treePlace, setTreePlace] = useState(null); // where the tree sits among the trees as its reading says; null where it says nothing
  const [syncSession, setSyncSession] = useState(null);
  const [guides, setGuides] = useState(null); // the guides above the tree as the replica holds them; null where the server is asked
  const accountAtLoad = useRef(null);
  const plantNoteRef = useRef(null); // null until read; survives StrictMode’s double effect
  const knownRef = useRef(new Map()); // `<step>><tree>` → what the picker knew of a tree chosen here, until the server's read
  const readingRef = useRef(null);
  const latest = useRef(null);
  latest.current = { structure, onRemoteProgress };
  const { layoutRef } = structure;
  const { selectedId, selectedIdRef, setSelectedId } = selection;
  const readsReplica = replica && !demo;

  useEffect(() => {
    let cancelled = false;
    const wanted = new AbortController();
    const { signal } = wanted;
    setLoading(true);
    setLoadError(false);
    setSelectedId(null);
    setTreeVisibility(null);
    setTreeMine(false);
    setTreePlace(null);
    setGuides(null);
    knownRef.current = new Map();
    framing.firstFrameRef.current = null;
    if (plantNoteRef.current === null) plantNoteRef.current = takePlantNote();
    const reading = readsReplica ? new ReplicaReading({ treeId, room, say: showToast }) : new LatticeReading({ treeId, demo, shared, demotion, known: knownRef, room });
    readingRef.current = reading;
    replicaRef.current = readsReplica ? reading : null;

    async function loadTree() {
      await reading.settleHolder();
      if (cancelled) return;
      accountAtLoad.current = deviceOwner();
      const layoutName = layoutNameFrom(window.location);
      const layout = await loadLayoutEngine(layoutName);
      if (cancelled) return;
      layoutRef.current = { requestedName: layoutName, name: layout.constructor.layoutName, engine: layout };
      const read = await reading.read({ signal });
      if (cancelled) return;
      if (!read) {
        setLoadError(true);
        setLoading(false);
        return;
      }
      const { seed, overlay } = read;
      const owner = seed.mine === true && !shared && !demo;
      const sits = seed.place ?? null;
      const nextTree = new SkillTree(seed);
      const states = UnlockRules.derive(nextTree, overlay);
      const model = nextTree.toRenderModel(structure.layoutPositions(nextTree), states);

      const mountedScene = sceneRef.current;
      const remembers = !demo && desktopEditorRef.current;
      const completed = UnlockRules.completed(nextTree, overlay);
      const sinceIds = ReturnLedger.since(completed, remembers ? returnLedger.load(seed.id) : null, states);
      if (sinceIds.length) mountedScene?.armReturnRecap(sinceIds, welcomeBackToast({ count: sinceIds.length }));

      const born = owner && peekBorn(seed.id);
      const place = savedPlace(placeKept ? placeStore.load(layoutRef.current.name) : null, seed);
      const onFrontier = opensOnFrontier({ savedCamera: place.camera, owner, born, stepCount: seed.nodes.length });
      if (onFrontier) mountedScene?.suppressArrival();
      if (born) {
        const done = [...states.values()].filter((state) => state === 'complete').length;
        mountedScene?.setArrivalSummary(plantedToast({ quest: plantNoteRef.current.quest, count: seed.nodes.length, done }));
      }
      mountedScene?.setModel(model);
      if (place.camera) mountedScene?.restoreViewpoint(place.camera);
      if (onFrontier && mountedScene) {
        const target = frontierTarget(nextTree, overlay, { selectedId: place.selection });
        mountedScene.setViewportInsets(framing.insetsRef.current ?? viewportInsets({ breakpoint, dockOpen: !!place.selection && placeKept }));
        mountedScene.focusWorking(target, { instant: true });
        framing.firstFrameRef.current = { id: target, at: Date.now(), camera: mountedScene.getViewpoint() };
      }

      projectionRef.current = seed;
      treeRef.current = nextTree;
      seedRef.current = seed;
      progressActs.adoptLoaded(overlay);
      activity.seedActivity({ tree: nextTree, states, completedAt: overlay.completedAt, serverActivity: read.serverActivity ?? [] });
      structure.install(nextTree, model, mountedScene?.getBounds() ?? null);
      setTreeVisibility(seed.visibility ?? null);
      setTreeMine(seed.mine ?? false);
      setTreePlace(sits);
      setGuides(read.guides ?? null);
      if (read.workspace) workspace.adoptWorkspaces(read.workspace);
      else workspace.hydrateWorkspaces(seed.id);
      legend.hydrateLegend(seed.id, nextTree.nodes, seed.kinds ?? null);
      workspace.pushArcs();
      if (place.selection) setSelectedId(place.selection);
      if (placeKept && mountedScene) placeStore.save({ treeId: seed.id, layout: layoutRef.current.name, camera: mountedScene.getViewpoint(), selectedId: place.selection });
      // A load that could not read a tree one of its steps opens does not know what stands complete, so it leaves the ledger as it was.
      if (remembers && Openings.known(nextTree.nodes) !== 'unread') returnLedger.save(seed.id, { completed: [...completed], at: Date.now() });
      setLoading(false);
      if (shared && seed.id === DEMO_TREE_ID) track('demo_open', { treeId: seed.id });

      reading.follow({
        onTree: (shown) => {
          latest.current.structure.onTreeChanged(shown);
          workspace.pushArcs();
        },
        onProgress: (remote) => latest.current.onRemoteProgress(remote),
        onWorkspace: (byNode) => {
          workspace.adoptWorkspaces(byNode);
          workspace.pushArcs();
        },
        onGuides: setGuides,
        onActivity: activity.addServerActivity,
      });
      setSyncSession(reading.status);
    }

    // The repository reports its own transport failures; anything else that stops the load reports `roadmap-load`.
    loadTree().catch((error) => {
      if (cancelled) return;
      console.warn('[tree] load failed', treeId, error);
      reportRoadmapFailure('roadmap-load', error);
      setLoadError(true);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      wanted.abort();
      dismissToast('left');
      reading.close();
      readingRef.current = null;
      replicaRef.current = null;
      sessionRef.current?.close();
      sessionRef.current = null;
      setSyncSession(null);
    };
  }, [reloadKey, treeId, demo, dismissToast]);

  useEffect(() => {
    if (!accountId) accountAtLoad.current = null;
  }, [accountId]);

  // A sign-in can arrive before or after the first unavailable read settles.
  useEffect(() => {
    if (loadError && accountId && accountAtLoad.current !== accountId) setReloadKey((key) => key + 1);
  }, [accountId, loadError]);

  useEffect(() => {
    if (!scene || !placeKept) return undefined;
    let timer = null;
    const unsubscribe = scene.subscribeViewport(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!seedRef.current) return;
        placeStore.save({ treeId, layout: layoutRef.current.name, camera: scene.getViewpoint(), selectedId: selectedIdRef.current });
      }, 400);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [scene, treeId, placeKept]);

  useEffect(() => {
    if (!sceneRef.current || !placeKept || loading || !seedRef.current) return;
    placeStore.save({ treeId, layout: layoutRef.current.name, camera: sceneRef.current?.getViewpoint?.() ?? null, selectedId });
  }, [selectedId, loading, treeId, placeKept]);

  // What the planting door left for a fresh fork, read once; the room says it when its view is decided.
  const takeForkNote = useCallback(() => {
    if (!plantNoteRef.current?.forked) return false;
    plantNoteRef.current = { ...plantNoteRef.current, forked: false };
    return true;
  }, []);

  // What the picker knew of a tree chosen here, so its row stands at once; the server's read replaces it.
  const knowTree = useCallback((stepId, tree) => { knownRef.current.set(`${stepId}>${tree.id}`, Opening.chosen(tree)); }, []);

  // The switcher's list where the room reads the replica: the account's roadmaps as the replica keeps them.
  const listTrees = useCallback(async () => readingRef.current?.list() ?? [], []);

  return {
    loading, loadError, reloadKey, syncSession, treeVisibility, setTreeVisibility, treeMine, treePlace, takeForkNote, knowTree, guides,
    readsReplica, listTrees: readsReplica ? listTrees : null,
    retryLoad: useCallback(() => setReloadKey((key) => key + 1), []),
  };
}
