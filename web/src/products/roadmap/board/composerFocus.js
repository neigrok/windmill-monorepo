import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex="0"]';

export function useComposerFocus(ref, active = true) {
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement);

  useEffect(() => () => {
    if (opener.current?.isConnected) {
      opener.current.focus({ preventScroll: true });
      return;
    }
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
      const target = document.querySelector('.st-board-step-status')
        ?? document.querySelector('.st-board-step-layer [role="dialog"]')
        ?? document.querySelector('.st-board [data-column] [tabindex="0"], .st-board .st-board-find-input, .st-board-state button');
      target?.focus({ preventScroll: true });
    });
  }, []);

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
