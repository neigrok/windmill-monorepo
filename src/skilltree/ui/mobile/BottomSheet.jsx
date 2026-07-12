// The phone node-detail sheet (X5 §S2). A bottom-edge sheet that opens at a 216px
// peek and lifts to at most 62vh — the canvas is never fully covered, and there is
// only ever one. The grabber is the whole gesture surface: a tap toggles
// peek↔expanded, a drag follows the finger, and a drag well past the peek dismisses.
// The parent tapping the canvas dismisses too (it flips `open`). `children` is the
// read-only StepPanel content the parent supplies — we own only the shell + gestures.

import React, { useEffect, useRef, useState } from 'react';

const PEEK_HEIGHT = 216;
const MAX_VH = 62;
const DISMISS_THRESHOLD = 90; // px dragged past the peek before we let go into a dismiss
const TAP_SLOP = 4;           // movement under this reads as a tap, not a drag

const sheetHeightPx = () => Math.round((window.innerHeight * MAX_VH) / 100);
const peekOffsetPx = () => Math.max(0, sheetHeightPx() - PEEK_HEIGHT);
const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function BottomSheet({ open, onDismiss, children }) {
  const [rendered, setRendered] = useState(false);
  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dragOffset, setDragOffset] = useState(null); // px while dragging, else null

  const wasOpen = useRef(false);
  const dragging = useRef(false);
  const startY = useRef(0);
  const baseOffset = useRef(0);
  const moved = useRef(false);

  const reduced = prefersReducedMotion();

  useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true;
      setExpanded(false);
      setRendered(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      setShown(false);
      const timer = setTimeout(() => {
        setRendered(false);
        setDragOffset(null);
      }, reduced ? 0 : 280);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open, reduced]);

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = true;
    moved.current = false;
    startY.current = e.clientY;
    baseOffset.current = expanded ? 0 : peekOffsetPx();
    setDragOffset(baseOffset.current);
  };

  const onPointerMove = (e) => {
    if (!dragging.current) return;
    const delta = e.clientY - startY.current;
    if (Math.abs(delta) > TAP_SLOP) moved.current = true;
    const next = Math.min(Math.max(baseOffset.current + delta, 0), sheetHeightPx());
    setDragOffset(next);
  };

  const onPointerUp = (e) => {
    if (!dragging.current) return;
    dragging.current = false;
    const settled = baseOffset.current + (e.clientY - startY.current);
    setDragOffset(null);
    if (!moved.current) {
      setExpanded((x) => !x);
      return;
    }
    const peek = peekOffsetPx();
    if (settled > peek + DISMISS_THRESHOLD) {
      onDismiss?.();
      return;
    }
    setExpanded(settled < peek / 2);
  };

  if (!rendered) return null;

  const resting = expanded ? 'translateY(0)' : 'translateY(calc(62vh - 216px))';
  let transform;
  if (dragOffset != null) transform = `translateY(${dragOffset}px)`;
  else if (shown) transform = resting;
  else transform = reduced ? resting : 'translateY(100%)';

  const transition =
    dragOffset != null
      ? 'none'
      : reduced
        ? 'opacity var(--duration-base) var(--ease-soft)'
        : 'transform var(--duration-base) var(--ease-soft), opacity var(--duration-base) var(--ease-soft)';

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: '62vh',
        maxHeight: '62vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-card)',
        borderTopLeftRadius: 'var(--radius-xl)',
        borderTopRightRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-lg)',
        zIndex: 40,
        transform,
        opacity: shown ? 1 : 0,
        transition,
        willChange: 'transform',
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 28,
          cursor: 'grab',
          touchAction: 'none',
        }}
      >
        <span
          style={{
            width: 40,
            height: 5,
            borderRadius: 'var(--radius-full)',
            background: 'var(--border-default)',
          }}
        />
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          padding: '0 var(--space-4) calc(env(safe-area-inset-bottom, 0px) + var(--space-4))',
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default BottomSheet;
