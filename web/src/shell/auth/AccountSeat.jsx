// Presentational: the caller passes user/status and the handlers. Appearance is the one thing the seat reads for
// itself — a device preference, so the row shows signed out too — unless `appearance` is false: a
// landing chooses it in the nav's own toggle instead. The pop-up is a plain popover: the identity,
// the Appearance radiogroup, then the one menu of rows.

import React, { useEffect, useId, useRef, useState } from 'react';
import { Avatar, SegmentedControl } from '../../design-system';
import { useAppearance } from '../useAppearance.js';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// `mine` — { label, count, onSelect } — is the row back to a visitor's own work; omit it for no row.
export function AccountSeat({ user, status, size = 36, onSignIn, onSignOut, onSettings, onConnect, mine, footer, appearance = true, display = 'avatar' }) {
  const [open, setOpen] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [woke, setWoke] = useState(false);
  const rootRef = useRef(null);
  const seatRef = useRef(null);
  const popoverId = useId();
  const prevStatus = useRef(status);

  const reduced = prefersReducedMotion();
  const signedIn = status === 'signed-in' && Boolean(user);
  const name = signedIn ? (user.name?.trim() || user.email) : '';

  // The avatar wakes on a live ghost→signed-in flip.
  useEffect(() => {
    const woken = prevStatus.current === 'ghost' && status === 'signed-in';
    prevStatus.current = status;
    if (!woken) return undefined;
    setWoke(true);
    const settle = setTimeout(() => setWoke(false), 520);
    return () => clearTimeout(settle);
  }, [status]);

  // Escape and a press outside both close the pop-up and hand focus back to the seat.
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = () => { setOpen(false); seatRef.current?.focus(); };
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) dismiss(); };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (handler) => { setOpen(false); handler?.(); };

  const crossfade = `opacity ${reduced ? 'var(--duration-fast)' : 'var(--duration-slow)'} var(--ease-soft)`;

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <style>{`
        @keyframes wm-seat-wake { 0% { transform: scale(1); } 45% { transform: scale(1.02); } 100% { transform: scale(1); } }
      `}</style>

      <button
        ref={seatRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={signedIn ? `Account — ${name}` : 'Account'}
        onClick={() => setOpen((v) => !v)}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        style={{
          position: 'relative',
          width: display === 'label' ? 'auto' : size,
          height: display === 'label' ? 40 : size,
          padding: 0,
          border: 'none',
          borderRadius: 'var(--radius-full)',
          background: 'transparent',
          cursor: 'pointer',
          transform: `scale(${pressed ? 0.94 : 1})`,
          transition: 'transform var(--duration-fast) var(--ease-standard)',
        }}
      >
        {display === 'label' ? <span style={{ color: 'var(--text-primary)', font: '700 13px/18px var(--font-body)' }}>Account</span> : <>
        <span
          style={{
            position: 'absolute',
            inset: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-card)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--shadow-xs)',
            color: 'var(--text-tertiary)',
            opacity: signedIn ? 0 : 1,
            transition: crossfade,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="8.5" r="3.8" />
            <path d="M4.5 20c0-4 3.4-6.4 7.5-6.4S19.5 16 19.5 20" />
          </svg>
        </span>

        {user && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              display: 'inline-flex',
              opacity: signedIn ? 1 : 0,
              transition: crossfade,
              animation: woke && !reduced ? 'wm-seat-wake var(--duration-slow) var(--ease-soft)' : 'none',
            }}
          >
            <Avatar name={name} size={size} />
          </span>
        )}
        </>}
      </button>

      {open && (
        <div
          id={popoverId}
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 'min(272px, calc(100vw - 24px))',
            boxSizing: 'border-box',
            padding: 6,
            background: 'var(--surface-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 40,
            fontFamily: 'var(--font-body)',
            fontSize: 'var(--text-sm)',
            animation: reduced ? 'none' : 'wm-fade-in-up var(--duration-fast) var(--ease-soft)',
          }}
        >
          {signedIn ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 10px', borderBottom: '1px solid var(--border-subtle)', marginBottom: 4 }}>
                <Avatar name={name} size={28} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {user.name?.trim() && (
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {user.name.trim()}
                    </div>
                  )}
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {user.email}
                  </div>
                </div>
              </div>
              {appearance && <AppearanceRow />}
              <div role="menu" aria-label="Account">
                {mine && <MenuRow label={mine.label} detail={mine.count != null ? String(mine.count) : null} onSelect={() => choose(mine.onSelect)} />}
                {onConnect && <MenuRow label="Connect your LLM tools" onSelect={() => choose(onConnect)} />}
                <MenuRow label="Account settings" onSelect={() => choose(onSettings)} />
                <MenuRow label="Sign out" onSelect={() => choose(onSignOut)} />
              </div>
              {footer && (
                <div style={{ padding: '8px 10px 4px', marginTop: 4, borderTop: '1px solid var(--border-subtle)', fontSize: 'var(--text-xs)', lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                  {footer}
                </div>
              )}
            </>
          ) : (
            <>
              {appearance && <AppearanceRow />}
              <div role="menu" aria-label="Account">
                <MenuRow label="Sign in" onSelect={() => choose(onSignIn)} />
                {onSettings && <MenuRow label="Settings" onSelect={() => choose(onSettings)} />}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const APPEARANCE_OPTIONS = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

function AppearanceRow() {
  const { choice, set } = useAppearance();
  const labelId = useId();
  return (
    <div style={{ padding: '8px 10px 10px', marginBottom: 4, borderBottom: '1px solid var(--border-subtle)' }}>
      <div id={labelId} style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-tertiary)', marginBottom: 6 }}>Appearance</div>
      <SegmentedControl labelledBy={labelId} options={APPEARANCE_OPTIONS} value={choice} onChange={set} />
    </div>
  );
}

function MenuRow({ label, detail = null, onSelect }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        width: '100%',
        padding: '8px 10px',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        background: 'transparent',
        color: 'var(--text-primary)',
        fontFamily: 'inherit',
        fontSize: 'var(--text-sm)',
        fontWeight: 600,
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      {label}
      {detail != null && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{detail}</span>
      )}
    </button>
  );
}

export default AccountSeat;
