// The layer is inert to pointer input so pans reach the canvas; only Fork and Recenter opt back in.

import React, { useState } from 'react';
import { Icon } from '../../../../design-system';
import { NODE_COLORS, DEFAULT_NODE_COLOR } from '../../theme.js';

const SAFE_TOP = 'max(env(safe-area-inset-top, 0px), 44px)';
const SAFE_BOTTOM = 'env(safe-area-inset-bottom, 0px)';
const TABLET_PANEL_WIDTH = 320;

export function MobileChrome({
  title,
  progress = { done: 0, total: 0 },
  author,
  byline = null,
  dominantKind,
  onFork,
  onSignInToKeep,
  ctaEcho = false,
  onRecenter,
  showRecenter = false,
  tablet = false,
  panelOpen = false,
  view = 'tree',
}) {
  const [pressed, setPressed] = useState(false);

  const hue = NODE_COLORS[dominantKind] ? dominantKind : DEFAULT_NODE_COLOR;
  const c = NODE_COLORS[hue];
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const recenterRight = tablet && panelOpen ? TABLET_PANEL_WIDTH + 24 : 16;
  const appear = 'wm-fade-in-up var(--duration-fast) var(--ease-soft)';
  const listView = view === 'list';

  // The list view never renders this: the list header owns the sign-in line as its notice row.
  const signInNudge = onSignInToKeep ? (
    <button
      type="button"
      onClick={onSignInToKeep}
      style={{
        pointerEvents: 'auto',
        marginTop: 1,
        padding: 0,
        border: 'none',
        background: 'none',
        textAlign: 'left',
        fontFamily: 'var(--font-body)',
        fontSize: 12,
        fontWeight: 700,
        color: 'var(--color-brand)',
        cursor: 'pointer',
      }}
    >
      Saved on this device — sign in to keep it →
    </button>
  ) : null;

  return (
    <div
      className="st-mobile-chrome"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20 }}
    >
      {/* Dominant-kind rule — a 4px hairline across the very top */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 4,
          background: c.base,
        }}
      />

      {!listView && (
      <>
      {/* Plaque — a label, never a menu; sits below the status-bar-safe area */}
      <div
        style={{
          position: 'absolute',
          top: `calc(${SAFE_TOP} + 8px)`,
          left: 'calc(env(safe-area-inset-left, 0px) + 12px)',
          maxWidth: 'min(236px, calc(100vw - 150px))',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '10px 12px',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--surface-card)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-md)',
          animation: appear,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            style={{
              flexShrink: 0,
              width: 10,
              height: 10,
              borderRadius: 'var(--radius-full)',
              background: c.base,
              boxShadow: `inset 0 0 0 1.5px ${c.ring}`,
            }}
          />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 17,
              color: 'var(--text-primary)',
            }}
          >
            {title}
          </span>
        </div>

        {byline ? (
          // The demo plaque: one honest byline in place of the count + bar.
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {byline}
          </span>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--text-secondary)',
              }}
            >
              {done}/{total}
            </span>
            <span
              style={{
                flex: 1,
                maxWidth: 96,
                height: 6,
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-sunken)',
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${pct}%`,
                  borderRadius: 'var(--radius-full)',
                  background: `linear-gradient(90deg, ${c.soft}, ${c.base})`,
                  transition: 'width var(--duration-base) var(--ease-soft)',
                }}
              />
            </span>
          </div>
        )}

        {author && !byline && (
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--text-tertiary)' }}>
            {author}
          </span>
        )}

        {signInNudge}
      </div>

      {/* Wordmark chip — the way home: a real link on every read-only surface */}
      <a
        className="st-wordmark-link"
        href="#/"
        aria-label="Windmill — home"
        style={{
          position: 'absolute',
          top: `calc(${SAFE_TOP} + 8px)`,
          right: 'calc(env(safe-area-inset-right, 0px) + 12px)',
          display: 'inline-flex',
          alignItems: 'center',
          height: 30,
          padding: '0 12px',
          borderRadius: 'var(--radius-full)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)',
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 13,
          color: 'var(--color-brand)',
          textDecoration: 'none',
          pointerEvents: 'auto',
          animation: appear,
        }}
      >
        Windmill
      </a>
      </>
      )}

      {/* Fork CTA — the share page's one verb; absent on your own trees */}
      {onFork && (
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
          bottom: `calc(${SAFE_BOTTOM} + 18px)`,
          left: tablet ? 'calc(env(safe-area-inset-left, 0px) + 20px)' : '50%',
          transform: `${tablet ? '' : 'translateX(-50%) '}scale(${pressed ? 0.97 : 1})`,
          pointerEvents: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          height: 50,
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

      {/* Recenter chip — only when off-center; the list has no camera to recenter. */}
      {showRecenter && !listView && (
        <button
          type="button"
          onClick={onRecenter}
          aria-label="Recenter"
          style={{
            position: 'absolute',
            // With a fork present on a narrow phone the chip lifts clear above its 50px pill;
            // tablet puts the fork bottom-left, so no lift.
            bottom: onFork && !tablet ? `calc(${SAFE_BOTTOM} + 80px)` : `calc(${SAFE_BOTTOM} + 14px)`,
            right: `calc(env(safe-area-inset-right, 0px) + ${recenterRight}px)`,
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            padding: 4,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            animation: appear,
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 36,
              padding: '0 14px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--surface-card)',
              border: '1px solid var(--border-subtle)',
              boxShadow: 'var(--shadow-sm)',
              fontFamily: 'var(--font-body)',
              fontWeight: 700,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="8" cy="8" r="5" />
              <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
              <line x1="8" y1="0.5" x2="8" y2="3" />
              <line x1="8" y1="13" x2="8" y2="15.5" />
              <line x1="0.5" y1="8" x2="3" y2="8" />
              <line x1="13" y1="8" x2="15.5" y2="8" />
            </svg>
            Recenter
          </span>
        </button>
      )}

    </div>
  );
}

export default MobileChrome;
