import { createContext, useContext, useEffect, useRef, useState } from 'react';

const FOCUSABLE = 'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex="0"]';

export const DetailFocusContext = createContext(null);

export function useComposerFocus(ref, active = true, { restore = true } = {}) {
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement);
  const detailFocus = useContext(DetailFocusContext);

  useEffect(() => () => {
    if (!restore) return;
    if (detailFocus) {
      detailFocus.restore(opener);
      return;
    }
    requestAnimationFrame(() => {
      if (opener.current?.isConnected && !opener.current.closest('[inert]')) {
        opener.current.focus({ preventScroll: true });
        return;
      }
      if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
      document.querySelector('.st-board [data-column] [tabindex="0"], .st-board .st-board-find-input, .st-board-state button')?.focus({ preventScroll: true });
    });
  }, [detailFocus, restore]);

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
