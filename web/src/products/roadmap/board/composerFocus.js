import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { boardFocusTarget } from './traversal.js';

const FOCUSABLE = 'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex="0"]';

const coveredLayers = new WeakMap();

export function coverBeneath(layer) {
  const root = layer.parentElement;
  const floor = Number(getComputedStyle(layer).zIndex);
  const covered = new Set();
  const cover = () => {
    for (const sibling of root.children) {
      if (sibling === layer || covered.has(sibling) || Number(getComputedStyle(sibling).zIndex) > floor) continue;
      const coverage = coveredLayers.get(sibling) ?? { owners: 0, inert: sibling.inert };
      coverage.owners += 1;
      coveredLayers.set(sibling, coverage);
      sibling.inert = true;
      covered.add(sibling);
    }
  };
  cover();
  const watcher = new MutationObserver(cover);
  watcher.observe(root, { childList: true });
  return () => {
    watcher.disconnect();
    for (const sibling of covered) {
      const coverage = coveredLayers.get(sibling);
      coverage.owners -= 1;
      if (coverage.owners > 0) continue;
      sibling.inert = coverage.inert;
      coveredLayers.delete(sibling);
    }
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
    if (!active || event.key !== 'Tab') return;
    event.stopPropagation();
    const stops = [...ref.current.querySelectorAll(FOCUSABLE)].filter((element) => (
      !element.closest('[inert]') && element.getClientRects().length > 0
    ));
    const first = stops[0];
    const last = stops.at(-1);
    if (!first) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && (document.activeElement === first || !stops.includes(document.activeElement))) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && (document.activeElement === last || !stops.includes(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };
}

export function useComposerViewport(phone) {
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
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
    style: phone && viewport.visible ? { position: 'fixed', ...viewport.visible } : undefined,
  };
}
