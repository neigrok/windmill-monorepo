// The coach chip (F4 §02) — the one element the demo adds to the read-only chrome,
// and a temporary one. It mounts ONCE EVER per human: after the arrival settles, a
// beat of idle, and a quiet pointer, it points an arrow tab at the single ready step
// while that node pulses ×2 in its own kind colour (the tree stays fully lit and
// interactive — never a scrim with a hole). One sentence, one button, one quiet ✕.
// It retires on ✕/Esc/any completion/fork and never returns (wm-coach-done). Under
// reduced motion the GPU pulse is invisible, so the card draws its own static
// kind-glow ring; the mount is a fade with no rise.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { COACH_DONE_KEY, DEMO_COPY } from './demoStage.js';
import { NODE_COLORS, DEFAULT_NODE_COLOR, NODE_SIZE } from '../theme.js';

const ARRIVAL_SETTLE_MS = 1200; // the bloom cascade + a beat — "arrival settles" before we consider mounting
const IDLE_MS = 800;            // pointer-quiet the coach waits out — one that interrupts exploring has failed
const SETTLE_AT = 0.9;          // the camera pre-ease is 90% done before the chip mounts (§02)
const POLL_MS = 100;
const CARD_WIDTH = 264;
const ANCHOR_GAP = 18;          // px between the node's edge and the card

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function CoachChip({ scene, nodeId, onMarkDone, completionCount = 0 }) {
  const [shown, setShown] = useState(false);
  const [retired, setRetired] = useState(false);
  const containerRef = useRef(null);
  const ringRef = useRef(null);
  const retiredRef = useRef(false);
  const pulsedRef = useRef(false);
  const baselineRef = useRef(null); // completions already done when the coach first rendered
  if (baselineRef.current === null) baselineRef.current = completionCount;

  const reduced = prefersReducedMotion();
  const node = scene?.nodesById?.get(nodeId) ?? null; // live world position + kind, straight from the scene
  const hue = NODE_COLORS[node?.color] ?? NODE_COLORS[DEFAULT_NODE_COLOR];

  // Retire is the one exit: set the once-ever note (never returns — not on reload, not
  // on revisit) and stop rendering. Idempotent, so every retire path can call it freely.
  const retire = useCallback(() => {
    if (retiredRef.current) return;
    retiredRef.current = true;
    try { localStorage.setItem(COACH_DONE_KEY, '1'); } catch { /* private mode — the ref still holds this session */ }
    setRetired(true);
  }, []);

  // Doing beats being told (§03): a completion — the guided beat itself, an unlock, or the
  // visitor completing anything first — retires the coach. A completion already banked when
  // the coach first rendered means it never mounts at all.
  useEffect(() => {
    if (completionCount !== baselineRef.current) retire();
  }, [completionCount, retire]);

  // The mount sequence: arrival-settle → idle → pointer-quiet → camera pre-ease → 90%
  // settle. Only then does the chip appear and the pulse start together.
  useEffect(() => {
    if (!scene || !nodeId || retiredRef.current) return undefined;
    if (baselineRef.current > 0) { retire(); return undefined; } // completed before we could mount
    try { if (localStorage.getItem(COACH_DONE_KEY)) { retire(); return undefined; } } catch { /* ignore */ }

    let lastPointerAt = performance.now();
    const notePointer = () => { lastPointerAt = performance.now(); };
    window.addEventListener('pointermove', notePointer, { passive: true });
    window.addEventListener('pointerdown', notePointer, { passive: true });
    window.addEventListener('wheel', notePointer, { passive: true });

    const armedAt = performance.now();
    let revealed = false;
    const poll = setInterval(() => {
      if (retiredRef.current) { clearInterval(poll); return; }
      const now = performance.now();
      if (now - armedAt < ARRIVAL_SETTLE_MS) return;
      if (now - lastPointerAt < IDLE_MS) return;
      if (!revealed) {
        revealed = true;
        // Ease the camera only if the node sits OUTSIDE the central 80% frame (§02) — a
        // node already comfortably in view is never chased.
        const here = scene.nodesById?.get(nodeId);
        const p = here && scene.projectToScreen?.(here.x, here.y);
        const framed = p && p.x > window.innerWidth * 0.1 && p.x < window.innerWidth * 0.9
                         && p.y > window.innerHeight * 0.1 && p.y < window.innerHeight * 0.9;
        if (!framed) { scene.revealNode?.(nodeId); return; } // ease first, judge settle next tick
        // already framed — fall through and mount now (settleProgress reads idle → 1)
      }
      if ((scene.settleProgress?.() ?? 1) < SETTLE_AT) return;
      clearInterval(poll);
      // Shown counts as used: burn the once-ever note now, so a passive ignore + reload
      // never re-arms it (§03 "one chip, ever, per human").
      try { localStorage.setItem(COACH_DONE_KEY, '1'); } catch { /* private mode — the session ref still holds */ }
      if (!pulsedRef.current && !reduced) { pulsedRef.current = true; scene.pulseNode?.(nodeId); }
      setShown(true);
    }, POLL_MS);

    return () => {
      clearInterval(poll);
      window.removeEventListener('pointermove', notePointer);
      window.removeEventListener('pointerdown', notePointer);
      window.removeEventListener('wheel', notePointer);
    };
  }, [scene, nodeId, reduced, retire]);

  // Anchor the card + arrow tab to the node every frame the camera moves (subscribeViewport
  // fires per moved frame, off React — the NodeOverlay pattern). The card sits beside the
  // node and flips to the other side rather than run off-screen; a far-off node hides it.
  useEffect(() => {
    if (!scene || !nodeId || !shown) return undefined;
    const place = () => {
      const container = containerRef.current;
      if (!container) return;
      const n = scene.nodesById?.get(nodeId);
      if (!n) return;
      const origin = scene.projectToScreen?.(n.x, n.y);
      if (!origin) return;
      const edge = scene.projectToScreen(n.x + NODE_SIZE, n.y);
      const radius = Math.abs(edge.x - origin.x) / 2;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (origin.x < -radius || origin.x > vw + radius || origin.y < -radius || origin.y > vh + radius) {
        container.style.display = 'none';
        return;
      }
      container.style.display = 'block';

      const rightStart = origin.x + radius + ANCHOR_GAP;
      const placeRight = rightStart + CARD_WIDTH <= vw - 12;
      const left = placeRight ? rightStart : origin.x - radius - ANCHOR_GAP - CARD_WIDTH;
      container.classList.toggle('wm-coach--left', placeRight);   // arrow on the card's left, pointing back at the node
      container.classList.toggle('wm-coach--right', !placeRight);
      container.style.left = `${left}px`;
      container.style.top = `${clamp(origin.y, 88, vh - 88)}px`;

      const ring = ringRef.current;
      if (ring) {
        const size = radius * 3.4; // the pulse's mid-expansion, held (frozen mid-pulse)
        ring.style.left = `${origin.x}px`;
        ring.style.top = `${origin.y}px`;
        ring.style.width = `${size}px`;
        ring.style.height = `${size}px`;
      }
    };
    place();
    const unsubscribe = scene.subscribeViewport?.(place);
    window.addEventListener('resize', place);
    return () => { unsubscribe?.(); window.removeEventListener('resize', place); };
  }, [scene, nodeId, shown]);

  // ✕ or Esc retires the chip and nothing else (capture + stop, like VisitorNotice) — the
  // same press must not also deselect a node underneath.
  useEffect(() => {
    if (!shown) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      retire();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [shown, retire]);

  if (retired || !shown || !node) return null;

  return (
    <div
      ref={containerRef}
      className="wm-coach wm-coach--left"
      style={{ position: 'absolute', zIndex: 22, width: CARD_WIDTH, pointerEvents: 'none' }}
    >
      {reduced && (
        <span
          ref={ringRef}
          aria-hidden
          style={{
            position: 'fixed',
            transform: 'translate(-50%, -50%)',
            borderRadius: 'var(--radius-full)',
            border: `2px solid ${hue.base}`,
            boxShadow: `0 0 0 6px ${hue.glow}`,
            opacity: 0.55,
            pointerEvents: 'none',
          }}
        />
      )}
      <div
        className="wm-coach-card"
        style={{
          position: 'relative',
          transform: 'translateY(-50%)',
          pointerEvents: 'auto',
          padding: '14px 16px',
          borderRadius: 'var(--radius-xl)',
          background: 'var(--surface-card)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-lg)',
          animation: `${reduced ? 'wm-fade-in' : 'wm-fade-in-up'} var(--duration-base) var(--ease-soft)`,
        }}
      >
        <span className="wm-coach-arrow" style={{ '--wm-coach-arrow': hue.base }} aria-hidden />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <p
            style={{
              margin: 0,
              flex: 1,
              fontFamily: 'var(--font-body)',
              fontSize: 'var(--text-sm)',
              lineHeight: 1.45,
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            {DEMO_COPY.coachSentence}
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={retire}
            style={{
              flexShrink: 0,
              width: 22,
              height: 22,
              marginTop: -2,
              padding: 0,
              border: 'none',
              borderRadius: 'var(--radius-full)',
              background: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              lineHeight: 1,
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>
        <button
          type="button"
          onClick={() => { retire(); onMarkDone?.(); }}
          style={{
            marginTop: 12,
            width: '100%',
            height: 40,
            border: 'none',
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-brand)',
            color: 'var(--text-on-accent)',
            fontFamily: 'var(--font-body)',
            fontWeight: 700,
            fontSize: 'var(--text-sm)',
            cursor: 'pointer',
          }}
        >
          {DEMO_COPY.coachButton}
        </button>
      </div>
    </div>
  );
}

export default CoachChip;
