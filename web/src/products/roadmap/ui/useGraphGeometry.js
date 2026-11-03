import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GRAPH_CAMERA_SIZE } from './GraphChrome.jsx';
import { graphToastPlacement, viewportInsets } from './viewport.js';

// The space between a measured chrome row and what sits beneath it.
const CHROME_GAP = 8;
// The chrome measures itself within a frame of the first paint; past this the first view is the reader's to move.
const FIRST_FRAME_REFRAME_MS = 1200;
// The tablet Activity panel's drawn seat from the page top, and its gap beneath whatever reaches lower.
const ACTIVITY_PANEL_TOP = 172;
const ACTIVITY_PANEL_GAP = 12;

// Where everything over the canvas sits: what each piece of chrome measures of itself becomes the camera's insets, the
// dock's seat, the refusal card's seat, the toast's clearance and the tablet Activity panel's seat.
export function useGraphGeometry({
  breakpoint, phone, canvasView, boardActive, dockOpen, refusal, topbarBottom, graphChromeBottom, phoneGraphBottom,
  scene, selectedId, renderModel, toastKey, tendOpen, activityOpen, legendVisible,
  rootRef, identityRef, boardLayerRef, legendDockRef, insetsRef, firstFrameRef, graphRevealRef,
}) {
  const graphRefusalRef = useRef(null);
  const [graphRefusalHeight, setGraphRefusalHeight] = useState(0);
  const [legendBox, setLegendBox] = useState(null); // the legend dock's measured { width, height }, or null while it is down

  const graphRefusalShown = Boolean(canvasView && refusal);
  const refusalClearance = graphRefusalShown ? graphRefusalHeight + CHROME_GAP : 0;
  const dockTop = phone ? undefined : topbarBottom + CHROME_GAP + refusalClearance;
  const graphRefusalStyle = phone
    ? { bottom: phoneGraphBottom + 16 }
    : { top: topbarBottom + CHROME_GAP };
  const attachGraphRefusal = useCallback((element) => {
    if (!element && graphRefusalRef.current?.contains(document.activeElement)) {
      identityRef.current?.querySelector('.st-board-switch-option[aria-pressed="true"]')?.focus({ preventScroll: true });
    }
    graphRefusalRef.current = element;
  }, []);
  useLayoutEffect(() => {
    if (!graphRefusalShown) return undefined;
    const element = graphRefusalRef.current;
    const measure = () => setGraphRefusalHeight(element?.offsetHeight ?? 0);
    measure();
    const observer = new ResizeObserver(measure);
    if (element) observer.observe(element, { box: 'border-box' });
    return () => observer.disconnect();
  }, [graphRefusalShown]);
  const refusalTopInset = graphRefusalShown && !phone ? graphRefusalHeight + CHROME_GAP : 0;
  const refusalBottomInset = graphRefusalShown && phone ? graphRefusalHeight + phoneGraphBottom + 24 : 0;
  const graphTop = canvasView ? Math.max(topbarBottom + refusalTopInset, graphChromeBottom) : topbarBottom;
  const insets = useMemo(
    () => {
      const base = viewportInsets({
        breakpoint, dockOpen, legendBox,
        rowBottom: graphTop,
        barBottom: phoneGraphBottom,
        cameraBlock: canvasView && !phone ? GRAPH_CAMERA_SIZE : null,
      });
      if (!refusalBottomInset) return base;
      return { ...base, bottom: Math.max(base.bottom, refusalBottomInset) };
    },
    [breakpoint, dockOpen, legendBox, graphTop, canvasView, phone, phoneGraphBottom, refusalBottomInset],
  );
  // The row and the legend publish their measured boxes after the first paint, so the first view — framed a moment
  // earlier against insets that were still guesses — is framed once more as soon as the real ones arrive.
  useEffect(() => {
    insetsRef.current = insets;
    if (!scene) return;
    scene.setViewportInsets(insets);
    const reveal = graphRevealRef.current;
    if (reveal && scene.nodesById.has(reveal)) {
      graphRevealRef.current = null;
      firstFrameRef.current = null;
      scene.revealNode(reveal);
      return;
    }
    // Each piece of chrome measures itself a beat after the first paint, so the first view is framed again on every
    // inset it publishes — until the window closes, or the reader moves the camera and the view becomes theirs.
    const first = firstFrameRef.current;
    if (!first) return;
    const now = scene.getViewpoint();
    if (Date.now() - first.at >= FIRST_FRAME_REFRAME_MS || now.x !== first.camera.x || now.y !== first.camera.y || now.zoom !== first.camera.zoom) {
      firstFrameRef.current = null;
      return;
    }
    scene.focusWorking(first.id, { instant: true });
    firstFrameRef.current = { ...first, camera: scene.getViewpoint() };
  }, [scene, insets, selectedId, renderModel]);

  // The legend dock's height is its rows', so it publishes its measured box: the corner it holds is a block no caption
  // may sit under.
  useEffect(() => {
    const dock = legendDockRef.current;
    if (!dock) {
      setLegendBox(null);
      return undefined;
    }
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setLegendBox((box) => (box && box.width === width && box.height === height ? box : { width, height }));
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, [legendVisible]);

  const [graphToastPosition, setGraphToastPosition] = useState({ center: null, bottom: 24 });
  useLayoutEffect(() => {
    if (!canvasView || toastKey === null || phone) return undefined;
    const root = rootRef.current;
    const obstacleSelector = '.st-graph-camera, .st-minimap, .st-legend-dock, .st-detail-panel--open';
    const measure = () => {
      const shownToast = root.querySelector('.st-graph-toast .st-board-toast, .st-toast');
      if (!shownToast) return;
      const rootBox = root.getBoundingClientRect();
      const obstacles = [...root.querySelectorAll(obstacleSelector)]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left - rootBox.left, right: box.right - rootBox.left, top: box.top - rootBox.top, bottom: box.bottom - rootBox.top };
        });
      const position = graphToastPlacement({
        width: rootBox.width, height: rootBox.height,
        toastWidth: shownToast.offsetWidth, toastHeight: shownToast.offsetHeight,
        leftInset: insets.left, rightInset: insets.right, obstacles, gap: CHROME_GAP,
      });
      setGraphToastPosition((current) => current.center === position.center && current.bottom === position.bottom ? current : position);
    };
    const resized = new ResizeObserver(measure);
    resized.observe(root);
    const watchToast = () => {
      const shownToast = root.querySelector('.st-graph-toast .st-board-toast, .st-toast');
      if (shownToast) resized.observe(shownToast);
      for (const obstacle of root.querySelectorAll(obstacleSelector)) resized.observe(obstacle);
      measure();
    };
    const mounted = new MutationObserver(watchToast);
    mounted.observe(root, { childList: true, subtree: true });
    watchToast();
    root.addEventListener('transitionend', measure);
    return () => {
      root.removeEventListener('transitionend', measure);
      resized.disconnect();
      mounted.disconnect();
    };
  }, [canvasView, toastKey, phone, insets]);
  const phoneToastClearance = phoneGraphBottom + 12 + (graphRefusalShown ? graphRefusalHeight + 8 : 0);
  const graphToastBottom = phone ? Math.max(24, phoneToastClearance) : graphToastPosition.bottom;
  const graphToastStyle = canvasView ? {
    '--graph-toast-center': graphToastPosition.center === null ? '50%' : `${graphToastPosition.center}px`,
    '--graph-toast-bottom': `${graphToastBottom}px`,
  } : undefined;

  const [rowChrome, setRowChrome] = useState({ bottom: 0, roomTop: 0 });
  useLayoutEffect(() => {
    if (phone || !(tendOpen || activityOpen)) return undefined;
    const row = identityRef.current?.querySelector('.st-roadmap-identity');
    const filters = boardActive ? boardLayerRef.current?.querySelector('.st-board-strip') : null;
    const measure = () => {
      const rowBottom = row?.getBoundingClientRect().bottom ?? 0;
      const filterBottom = filters?.getBoundingClientRect().bottom ?? 0;
      setRowChrome({ bottom: Math.max(rowBottom, filterBottom), roomTop: rootRef.current?.getBoundingClientRect().top ?? 0 });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (row) observer.observe(row);
    if (filters) observer.observe(filters);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [phone, tendOpen, activityOpen, boardActive, topbarBottom, Boolean(refusal)]);
  const tendTopInset = rowChrome.bottom + 16;
  const activityPanelTop = Math.max(ACTIVITY_PANEL_TOP, rowChrome.bottom + ACTIVITY_PANEL_GAP + refusalClearance) - rowChrome.roomTop;

  return { insets, dockTop, graphRefusalShown, graphRefusalStyle, attachGraphRefusal, graphToastStyle, tendTopInset, activityPanelTop };
}
