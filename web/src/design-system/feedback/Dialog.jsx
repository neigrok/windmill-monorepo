import React, { useCallback, useEffect, useRef, useState } from 'react';

// The gate's one rule: the end of the body has been reached when what is left below the fold is
// within a couple of pixels — a fractional scrollTop never lands exactly on the last pixel.
export function scrolledToEnd({ scrollTop, scrollHeight, clientHeight }, slack = 2) {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

// `footer` is a node, or a function of `{ seen }` for a footer that must know whether the body has
// been read to its end. With `gate="scrolled"` `seen` starts false, turns true once the body is
// scrolled to its end or fits without scrolling, and drops back to false only if the body grows past
// the height that was seen — scrolling back up never re-locks it. Without the gate `seen` is true.
export function Dialog({ open, onClose, title, children, footer, width = 420, gate = null, padding = 'var(--space-8)' }) {
  const cardRef = useRef(null);
  const bodyRef = useRef(null);
  const contentRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const openerRef = useRef(null);
  const wasOpen = useRef(false);
  const [closeHover, setCloseHover] = useState(false);
  const gated = gate === 'scrolled';
  const [seen, setSeen] = useState(!gated);
  // The body height at which the end was last seen; null until it has been.
  const seenHeight = useRef(null);

  // Capture the opener during render, before React commits the dialog's autoFocus (commitMount
  // runs before any effect), so this sees the trigger and not a field inside the card.
  if (open && !wasOpen.current) openerRef.current = document.activeElement;
  wasOpen.current = open;

  const measure = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (scrolledToEnd(body)) {
      seenHeight.current = body.scrollHeight;
      setSeen(true);
      return;
    }
    if (seenHeight.current != null && body.scrollHeight > seenHeight.current + 2) setSeen(false);
  }, []);

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

  // The gate watches the body's box and its content: a body that fits is seen at once, one that
  // fills in later (a read answering) is measured again when it grows.
  useEffect(() => {
    if (!open || !gated) return undefined;
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (observer && bodyRef.current) observer.observe(bodyRef.current);
    if (observer && contentRef.current) observer.observe(contentRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      seenHeight.current = null;
      setSeen(false);
    };
  }, [open, gated, measure]);

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
          padding,
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
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-xl)', marginBottom: 12, paddingRight: 28 }}>
            {title}
          </div>
        )}
        {/* Scrolling makes this a clip box on BOTH axes (CSS computes the paired overflow-x up
            from `visible` to `auto`), and a field paints its focus ring outside its own box. The
            card's padding is borrowed back here so the clip edge lands on the card wall. */}
        <div
          ref={bodyRef}
          onScroll={gated ? measure : undefined}
          style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--text-base)', color: 'var(--text-secondary)', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', margin: `calc(-1 * var(--space-1)) calc(-1 * ${padding})`, padding: `var(--space-1) ${padding}` }}
        >
          <div ref={contentRef}>{children}</div>
        </div>
        {footer && (
          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            {typeof footer === 'function' ? footer({ seen }) : footer}
          </div>
        )}
      </div>
    </div>
  );
}
