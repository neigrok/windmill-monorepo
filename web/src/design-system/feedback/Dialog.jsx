import React, { useEffect, useRef, useState } from 'react';

export function Dialog({ open, onClose, title, children, footer, width = 420 }) {
  const cardRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const openerRef = useRef(null);
  const wasOpen = useRef(false);
  const [closeHover, setCloseHover] = useState(false);

  // Capture the opener during render, before React commits the dialog's autoFocus (commitMount
  // runs before any effect), so this sees the trigger and not a field inside the card.
  if (open && !wasOpen.current) openerRef.current = document.activeElement;
  wasOpen.current = open;

  // While open: move focus into the dialog unless a field inside already claimed it, and restore
  // it to the opener on close. Escape closes, and the event is stopped so a host's own global Esc
  // handler does not fire behind it.
  useEffect(() => {
    if (!open) return undefined;
    const card = cardRef.current;
    const focusInside = card && card.contains(document.activeElement);
    if (card && !focusInside) card.focus();
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCloseRef.current?.();
    };
    // Capture phase: a host's global Esc handler is a bubble listener on window, so only stopping
    // the event before the bubble phase keeps it from firing too.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      openerRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--surface-overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        animation: 'wm-fade-in-up var(--duration-fast) var(--ease-soft)',
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: width,
          maxWidth: '90vw',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',     // the body scrolls, header/close/footer stay pinned
          background: 'var(--surface-card)',
          borderRadius: 'var(--radius-2xl)',
          boxShadow: 'var(--shadow-lg)',
          padding: 'var(--space-8)',
          outline: 'none',
          animation: 'wm-pop-in var(--duration-base) var(--ease-soft)',
        }}
      >
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            onMouseEnter={() => setCloseHover(true)}
            onMouseLeave={() => setCloseHover(false)}
            style={{
              position: 'absolute',
              top: 'var(--space-4)',
              right: 'var(--space-4)',
              width: 28,
              height: 28,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              borderRadius: 'var(--radius-full)',
              cursor: 'pointer',
              background: closeHover ? 'var(--surface-hover)' : 'transparent',
              color: closeHover ? 'var(--text-primary)' : 'var(--text-tertiary)',
              transition: 'background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        )}
        {title && (
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-xl)', marginBottom: 12 }}>
            {title}
          </div>
        )}
        {/* Scrolling makes this a clip box on BOTH axes (CSS computes the paired overflow-x up
            from `visible` to `auto`), and a field paints its focus ring outside its own box. The
            card's padding is borrowed back here so the clip edge lands on the card wall. */}
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--text-base)', color: 'var(--text-secondary)', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', margin: 'calc(-1 * var(--space-1)) calc(-1 * var(--space-8))', padding: 'var(--space-1) var(--space-8)' }}>
          {children}
        </div>
        {footer && <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>{footer}</div>}
      </div>
    </div>
  );
}
