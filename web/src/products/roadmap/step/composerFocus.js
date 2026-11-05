import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { boardFocusTarget } from '../board/traversal.js';
import { wrapTab } from '../../../design-system/feedback/dialogFocus.js';

const coveredLayers = new WeakMap();

export function coverLayer(layer) {
  const coverage = coveredLayers.get(layer) ?? { owners: 0, inert: layer.inert };
  coverage.owners += 1;
  coveredLayers.set(layer, coverage);
  layer.inert = true;
  return () => {
    coverage.owners -= 1;
    if (coverage.owners > 0) return;
    layer.inert = coverage.inert;
    coveredLayers.delete(layer);
  };
}

export function useCoveredLayer(ref, covered) {
  useLayoutEffect(() => (covered && ref.current ? coverLayer(ref.current) : undefined), [ref, covered]);
}

export function coverBeneath(layer) {
  const root = layer.parentElement;
  const floor = Number(getComputedStyle(layer).zIndex);
  const covered = new Map();
  const cover = () => {
    for (const sibling of root.children) {
      if (sibling === layer || covered.has(sibling) || Number(getComputedStyle(sibling).zIndex) > floor) continue;
      covered.set(sibling, coverLayer(sibling));
    }
  };
  cover();
  const watcher = new MutationObserver(cover);
  watcher.observe(root, { childList: true });
  return () => {
    watcher.disconnect();
    for (const uncover of covered.values()) uncover();
  };
}

export const DetailFocusContext = createContext(null);

export function useComposerFocus(ref, active = true, { restore = true, preserveOutsideFocus = false } = {}) {
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement);
  const detailFocus = useContext(DetailFocusContext);

  useEffect(() => {
    const surface = ref.current;
    return () => {
      if (!restore) return;
      if (detailFocus) {
        detailFocus.restore(opener);
        return;
      }
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const outside = active !== document.body && active?.isConnected && !surface?.contains(active) && !active.closest('[inert]');
        if (preserveOutsideFocus && outside) return;
        if (opener.current?.isConnected && !opener.current.closest('[inert]')) {
          opener.current.focus({ preventScroll: true });
          return;
        }
        if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
        boardFocusTarget(document.querySelector('.st-board'))?.focus({ preventScroll: true });
      });
    };
  }, [detailFocus, restore, preserveOutsideFocus, ref]);

  useEffect(() => {
    if (!active || ref.current?.contains(document.activeElement)) return;
    ref.current?.focus({ preventScroll: true });
  }, [active]);

  return (event) => {
    if (!active) return;
    wrapTab(event, ref.current);
  };
}

export function useComposerViewport(phone) {
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    layoutHeight: typeof window === 'undefined' ? 0 : window.innerHeight,
    scale: typeof window === 'undefined' ? 1 : window.visualViewport?.scale ?? 1,
    visible: typeof window === 'undefined' || !window.visualViewport ? null : {
      top: window.visualViewport.offsetTop,
      left: window.visualViewport.offsetLeft,
      width: window.visualViewport.width,
      height: window.visualViewport.height,
    },
  }));
  useEffect(() => {
    const visible = window.visualViewport;
    const resize = () => setViewport({
      width: window.innerWidth,
      layoutHeight: window.innerHeight,
      scale: visible?.scale ?? 1,
      visible: visible ? {
        top: visible.offsetTop,
        left: visible.offsetLeft,
        width: visible.width,
        height: visible.height,
      } : null,
    });
    resize();
    window.addEventListener('resize', resize);
    visible?.addEventListener('resize', resize);
    visible?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      visible?.removeEventListener('resize', resize);
      visible?.removeEventListener('scroll', resize);
    };
  }, []);
  return {
    panelFits: viewport.width >= 1440,
    keyboardVisible: Boolean(phone && viewport.visible && viewport.scale === 1
      && viewport.visible.top + viewport.visible.height < viewport.layoutHeight),
    style: phone && viewport.visible ? { position: 'fixed', ...viewport.visible } : undefined,
  };
}
