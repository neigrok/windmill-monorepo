// Pointer input reaches the canvas outside the selected-step bar, Fork and the camera controls.

import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button, Icon } from '../../../design-system';
import { KIND_CSS } from '../theme.js';
import { DOCK_WIDTH, TABLET_PANEL_WIDTH } from './viewport.js';
import { DeviceLine } from '../board/SyncNotices.jsx';
import { COLUMN_TITLES, FORK_OFFER, OPEN_STEP } from '../board/copy.js';

const SAFE_BOTTOM = 'env(safe-area-inset-bottom, 0px)';
// The reader's Fork this tree pill, above the bottom safe area; whatever must clear it reads its geometry here.
export const FORK_PILL = { bottom: 18, height: 50 };
export const GRAPH_CAMERA_SIZE = { width: 248, height: 50 };

export function GraphChrome({
  onFork,
  deviceLine = null,
  ctaEcho = false,
  onFocus,
  onShowAll,
  view = 'tree',
  band = 'phone',
  rowBottom = 0,
  onZoomIn,
  onZoomOut,
  cameraRight = 24,
  cameraBottom = 24,
  onTopBottom,
  step = null,
  onOpenStep = null,
  onBarBottom,
}) {
  const [pressed, setPressed] = useState(false);
  const [nudgeHeight, setNudgeHeight] = useState(0);
  const cameraRef = useRef(null);
  const nudgeRef = useRef(null);
  const barRef = useRef(null);

  const appear = 'wm-fade-in-up var(--duration-fast) var(--ease-soft)';
  const canvasView = view === 'tree';
  const phone = band === 'phone';
  const phoneGraph = phone && canvasView;
  const nudge = phoneGraph && Boolean(deviceLine);
  const phoneCameraTop = rowBottom + 8 + (nudge ? nudgeHeight : 0);
  const showStep = phoneGraph && Boolean(step);

  useLayoutEffect(() => {
    if (!onBarBottom) return undefined;
    const bar = barRef.current;
    if (!showStep || !bar) {
      onBarBottom(0);
      return undefined;
    }
    const measure = () => onBarBottom(bar.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar, { box: 'border-box' });
    return () => {
      observer.disconnect();
      onBarBottom(0);
    };
  }, [showStep, onBarBottom]);

  useLayoutEffect(() => {
    if (!onTopBottom && !nudge) return undefined;
    const measure = () => {
      setNudgeHeight(nudgeRef.current?.offsetHeight ?? 0);
      const topChrome = [cameraRef.current, nudgeRef.current].filter(Boolean);
      const bottom = Math.max(rowBottom, ...topChrome.map((element) => element.offsetTop + element.offsetHeight));
      onTopBottom?.(bottom);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [cameraRef.current, nudgeRef.current]) {
      if (element) observer.observe(element, { box: 'border-box' });
    }
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [onTopBottom, nudge, canvasView, rowBottom, phoneCameraTop]);

  return (
    <div
      className="st-graph-chrome"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20 }}
    >
      {/* Fork CTA — the share page's one verb; absent on your own trees */}
      {onFork && !showStep && phone && (
      <button
        type="button"
        className={ctaEcho ? 'wm-cta-echo' : undefined}
        onClick={onFork}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        style={{
          position: 'absolute',
          bottom: `calc(${SAFE_BOTTOM} + ${FORK_PILL.bottom}px)`,
          left: '50%',
          transform: `translateX(-50%) scale(${pressed ? 0.97 : 1})`,
          pointerEvents: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          height: FORK_PILL.height,
          padding: '0 22px',
          border: 'none',
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-brand)',
          color: 'var(--text-on-accent)',
          fontFamily: 'var(--font-body)',
          fontWeight: 700,
          fontSize: 'var(--text-base)',
          boxShadow: 'var(--shadow-md)',
          cursor: 'pointer',
          transition: 'transform var(--duration-fast) var(--ease-standard)',
          animation: appear,
        }}
      >
        <Icon name="git-branch-plus" size={18} />
        Fork this tree
      </button>
      )}

      {showStep && (
        <div ref={barRef} className="st-graph-step-bar" data-graph-step-bar="">
          <div className="st-graph-step-heading">
            {onFork && onOpenStep ? (
              <button type="button" className="st-graph-step-title" onClick={() => onOpenStep(step.id)}>
                {step.title}
              </button>
            ) : <span className="st-graph-step-title">{step.title}</span>}
            <span className="st-graph-step-state">{COLUMN_TITLES[step.state]}</span>
          </div>
          <button type="button" className="st-graph-step-primary" data-graph-step-primary=""
            onClick={onFork ?? (() => onOpenStep?.(step.id))}>
            {onFork ? FORK_OFFER : OPEN_STEP}
          </button>
        </div>
      )}

      {nudge && (
        <div ref={nudgeRef} className="st-roadmap-device-nudge" style={{ top: rowBottom }}>
          <DeviceLine {...deviceLine} />
        </div>
      )}

      {/* The phone camera clears the row and its device notice. */}
      {phoneGraph && (
        <div
          className="st-view-actions"
          ref={cameraRef}
          role="group"
          aria-label="Camera"
          style={{
            position: 'absolute',
            top: phoneCameraTop,
            right: 'calc(env(safe-area-inset-right, 0px) + 12px)',
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            padding: 4,
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-card)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--shadow-sm)',
            animation: appear,
          }}
        >
          <button type="button" className="st-view-action" onClick={onFocus}>Focus</button>
          <button type="button" className="st-view-action" onClick={onShowAll}>All steps</button>
        </div>
      )}

      {canvasView && !phone && (
        <div className="st-graph-camera" role="group" aria-label="Camera"
          style={{ right: cameraRight, bottom: cameraBottom }}>
          <button type="button" className="st-graph-camera-zoom" aria-label="Zoom out" title="Zoom out" onClick={onZoomOut}>
            <Icon name="zoom-out" size={20} />
          </button>
          <button type="button" className="st-graph-camera-zoom" aria-label="Zoom in" title="Zoom in" onClick={onZoomIn}>
            <Icon name="zoom-in" size={20} />
          </button>
          <button type="button" className="st-graph-camera-action" onClick={onFocus}>Focus</button>
          <button type="button" className="st-graph-camera-action" onClick={onShowAll}>All steps</button>
        </div>
      )}

    </div>
  );
}

// The Graph's right-hand seat: one tenant at a time, keyed so its entrance replays.
export function GraphDock({ open, top, tablet = false, tenant, children }) {
  return (
    <aside className={`st-detail-panel ${tablet ? 'st-detail-panel--tablet' : ''} ${open ? 'st-detail-panel--open' : ''}`}
      style={{ width: tablet ? TABLET_PANEL_WIDTH : DOCK_WIDTH, top }}>
      <div className="st-dock-tenant" key={tenant}>{children}</div>
    </aside>
  );
}

export function GraphSelectionBar({ stepCount, linkCount, kinds, ringedKind, onPreviewKind, onRestoreKind, onRecolor, onMarkDone, onPreviewDelete, onClearDelete, onDelete }) {
  return (
    <div className="st-selection-bar" role="status">
      <span className="st-selection-count">{stepCount + linkCount} selected</span>
      {stepCount > 0 && (
        <div className="st-step-kinds" role="group" aria-label="Recolour selected steps">
          {kinds.map((kind) => {
            const name = kind.label || kind.hue.charAt(0).toUpperCase() + kind.hue.slice(1);
            return (
              <button
                key={kind.id}
                type="button"
                className={`st-step-swatch ${kind.hue === ringedKind ? 'st-step-swatch--current' : ''}`}
                style={{ background: KIND_CSS[kind.hue].base }}
                title={name}
                aria-label={`Recolour selection to ${name}`}
                onPointerEnter={() => onPreviewKind(kind.hue)}
                onPointerLeave={onRestoreKind}
                onClick={() => onRecolor(kind.hue)}
              />
            );
          })}
        </div>
      )}
      {stepCount > 0 && (
        <button type="button" className="st-selection-done" onClick={onMarkDone}>Mark all done</button>
      )}
      <span className="st-selection-delete" onPointerEnter={onPreviewDelete} onPointerLeave={onClearDelete}>
        <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
      </span>
    </div>
  );
}

// The desktop editor's Graph of a roadmap with no steps.
export function EmptyGraphCard({ onAddFirstStep }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 15, pointerEvents: 'none' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-4)', padding: 'var(--space-6) var(--space-7)', background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)', pointerEvents: 'auto', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--text-primary)' }}>This tree is empty</div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Add a first step to start growing it.</p>
        <Button onClick={onAddFirstStep}>Add your first step</Button>
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>or paste a plan — ⌘V</p>
      </div>
    </div>
  );
}
