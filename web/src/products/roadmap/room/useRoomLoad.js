import { useCallback, useEffect, useRef, useState } from 'react';
import { plantedToast, welcomeBackToast } from '../copy.js';
import { DEMO_STAGED_COMPLETED, DEMO_TREE_ID } from '../demo/demoStage.js';
import { layoutNameFrom, loadLayoutEngine } from '../layout/index.js';
import { SkillTree } from '../model/SkillTree.js';
import { UnlockRules } from '../model/UnlockRules.js';
import { HttpTreeRepository } from '../persistence/HttpTreeRepository.js';
import { LocalTreeRegistry, resolveDeviceOwner, deviceOwner, deviceOwnerAnswered } from '../persistence/LocalTreeRegistry.js';
import { PlaceStore } from '../persistence/PlaceStore.js';
import { ReturnLedger } from '../persistence/ReturnLedger.js';
import { peekBorn, takePlantNote } from '../persistence/ViewPrefs.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { SyncSession } from '../sync/SyncSession.js';
import { refusalReporter } from '../sync/refusals.js';
import { loadDeviceTree } from '../sync/localTrees.js';
import { frontierTarget, opensOnFrontier, viewportInsets } from '../graph/viewport.js';
import { track } from '../../../telemetry/beacon.js';

const deviceTrees = new LocalTreeRegistry();

// A saved camera the layout and its format still mean, and the step that place remembered if the tree still holds it.
function savedPlace(place, seed) {
  const returning = place?.treeId === seed.id ? place : null;
  const camera = returning?.camera && [returning.camera.x, returning.camera.y, returning.camera.zoom].every(Number.isFinite) ? returning.camera : null;
  const selection = returning?.selectedId && seed.nodes.some((node) => node.id === returning.selectedId) ? returning.selectedId : null;
  return { camera, selection };
}

// What the server or this device holds for the confirmed owner. A tree neither has is an expected answer.
async function readRoadmap({ treeId, demo, signal }) {
  const repo = new HttpTreeRepository({ treeId });
  let seed = null;
  try { seed = await repo.loadTree({ signal }); } catch { /* fall through to the blob */ }
  if (signal.aborted) return null;
  if (!seed) seed = await loadDeviceTree(treeId, { ownerResolved: true });
  if (!seed) return { unknown: true };
  const overlay = demo
    ? { completed: new Set(DEMO_STAGED_COMPLETED), completedAt: {}, server: false }
    : await repo.loadProgress(seed, { signal });
  const serverActivity = await repo.loadActivity({ limit: 200, signal });
  return { seed, overlay, serverActivity };
}

// From the door to a live session: repository, domain, layout, the first view, then the socket; a retry runs it again.
export function useRoomLoad({ treeId, accountId, demo, shared, demotion, breakpoint, placeKept, room, scene, framing, structure, progressActs, activity, legend, workspace, selection, dismissToast, desktopEditorRef, onRemoteProgress }) {
  const { sceneRef, sessionRef, projectionRef, treeRef, seedRef, peersRef } = room;
  const [placeStore] = useState(() => new PlaceStore());
  const [returnLedger] = useState(() => new ReturnLedger());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [treeVisibility, setTreeVisibility] = useState(null); // 'private'|'unlisted'|'public'|null
  const [treeMine, setTreeMine] = useState(false);
  const [syncSession, setSyncSession] = useState(null);
  const accountAtLoad = useRef(null);
  const plantNoteRef = useRef(null); // null until read; survives StrictMode’s double effect
  const latest = useRef(null);
  latest.current = { structure, onRemoteProgress };
  const { layoutRef } = structure;
  const { selectedId, selectedIdRef, setSelectedId } = selection;

  useEffect(() => {
    let cancelled = false;
    const wanted = new AbortController();
    const { signal } = wanted;
    setLoading(true);
    setLoadError(false);
    setSelectedId(null);
    setTreeVisibility(null);
    setTreeMine(false);
    framing.firstFrameRef.current = null;
    if (plantNoteRef.current === null) plantNoteRef.current = takePlantNote();

    async function loadTree() {
      await resolveDeviceOwner();
      await deviceOwnerAnswered();
      if (cancelled) return;
      accountAtLoad.current = deviceOwner();
      const layoutName = layoutNameFrom(window.location);
      const engine = await loadLayoutEngine(layoutName);
      if (cancelled) return;
      layoutRef.current = { requestedName: layoutName, name: engine.constructor.layoutName, engine };
      const read = await readRoadmap({ treeId, demo, signal });
      if (cancelled || !read) return;
      if (read.unknown) {
        setLoadError(true);
        setLoading(false);
        return;
      }
      const { seed, overlay, serverActivity } = read;
      const nextTree = new SkillTree(seed);
      const states = UnlockRules.derive(nextTree, overlay);
      const model = nextTree.toRenderModel(structure.layoutPositions(nextTree), states);

      const mountedScene = sceneRef.current;
      const remembers = !demo && desktopEditorRef.current;
      const sinceIds = ReturnLedger.since(overlay.completed, remembers ? returnLedger.load(seed.id) : null, states);
      if (sinceIds.length) mountedScene?.armReturnRecap(sinceIds, welcomeBackToast({ count: sinceIds.length }));

      const owner = seed.mine === true && !shared && !demo;
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
      activity.seedActivity({ tree: nextTree, states, completedAt: overlay.completedAt, serverActivity });
      structure.install(nextTree, model, mountedScene?.getBounds() ?? null);
      setTreeVisibility(seed.visibility ?? null);
      setTreeMine(seed.mine ?? false);
      workspace.hydrateWorkspaces(seed.id);
      legend.hydrateLegend(seed.id, nextTree.nodes, seed.kinds ?? null);
      workspace.pushArcs();
      if (place.selection) setSelectedId(place.selection);
      if (placeKept && mountedScene) placeStore.save({ treeId: seed.id, layout: layoutRef.current.name, camera: mountedScene.getViewpoint(), selectedId: place.selection });
      if (remembers) returnLedger.save(seed.id, { completed: [...overlay.completed], at: Date.now() });
      setLoading(false);
      if (shared && seed.id === DEMO_TREE_ID) track('demo_open', { treeId: seed.id });

      // Only owned trees enter the device index, so a visited share cannot be claimed.
      sessionRef.current?.close();
      peersRef.current.clear();
      const session = new SyncSession({ treeId: seed.id, title: seed.title, guide: seed.guide ?? '', registry: seed.mine && !shared && !demo && !demotion ? deviceTrees : null })
        .onTreeChanged((data) => latest.current.structure.onTreeChanged(data))
        .onPresence((frame) => peersRef.current.set(frame.actor, {
          name: frame.profile?.name, color: frame.profile?.color,
          cursor: frame.cursor ?? null, selection: frame.selection ?? null,
        }))
        .onPeer((frame) => {
          if (frame.event === 'leave') { peersRef.current.delete(frame.actor); return; }
          if (!peersRef.current.has(frame.actor)) {
            peersRef.current.set(frame.actor, { name: frame.profile?.name, color: frame.profile?.color, cursor: null, selection: null });
          }
        })
        .onProgress((remote) => latest.current.onRemoteProgress(remote));
      sessionRef.current = session;
      session.subscribeRefusals(refusalReporter());
      setSyncSession(session);
      session.start();
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

  return {
    loading, loadError, reloadKey, syncSession, treeVisibility, setTreeVisibility, treeMine, takeForkNote,
    retryLoad: useCallback(() => setReloadKey((key) => key + 1), []),
  };
}
