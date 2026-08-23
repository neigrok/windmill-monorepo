// Presentational: the caller passes user/status and the handlers. `expired` keeps the ghost seat
// and voices the lapsed-session line in the menu.

import React, { useEffect, useRef, useState } from 'react';
import { Avatar } from '../../design-system';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// `mine` — { label, count, onSelect } — is the row back to a visitor's own work; omit it for no row.
export function AccountSeat({ user, status, size = 36, onSignIn, onSignOut, onSettings, onConnect, mine, footer, expired = false, claimBusy }) {
  const [open, setOpen] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [claim, setClaim] = useState(null); // null | 'syncing' | 'synced' | 'fading'
  const [woke, setWoke] = useState(false);
  const rootRef = useRef(null);
  const prevStatus = useRef(status);
  const beatStartRef = useRef(0);
  const claimBusyRef = useRef(claimBusy);
  claimBusyRef.current = claimBusy;

  const reduced = prefersReducedMotion();
  const signedIn = status === 'signed-in' && Boolean(user);
  const name = signedIn ? (user.name?.trim() || user.email) : '';

  // Fires only on a live ghost→signed-in flip. Without a claimBusy prop the chip runs on its own
  // timers; with one, the "Syncing…" line holds until the claim reports done.
  useEffect(() => {
    const woken = prevStatus.current === 'ghost' && status === 'signed-in';
    prevStatus.current = status;
    if (!woken) return undefined;
    setWoke(true);
    setClaim('syncing');
    beatStartRef.current = Date.now();
    const settle = setTimeout(() => setWoke(false), 520);
    if (claimBusyRef.current !== undefined) return () => clearTimeout(settle);
    const toSynced = setTimeout(() => setClaim('synced'), 1200);
    const toFading = setTimeout(() => setClaim('fading'), 2100);
    const toSilent = setTimeout(() => setClaim(null), 2550);
    return () => [toSynced, toFading, toSilent, settle].forEach(clearTimeout);
  }, [status]);

  // claimBusy released mid-beat: hold the syncing line for its minimum, then "Synced", then fade.
  useEffect(() => {
    if (claimBusy === undefined || claimBusy === true || claim !== 'syncing') return undefined;
    const wait = Math.max(0, 1200 - (Date.now() - beatStartRef.current));
    if (claimBusy === 'incomplete') {
      // Something stayed unclaimed: never say "Synced".
      const toFading = setTimeout(() => setClaim('fading'), wait);
      const toSilent = setTimeout(() => setClaim(null), wait + 450);
      return () => [toFading, toSilent].forEach(clearTimeout);
    }
    const toSynced = setTimeout(() => setClaim('synced'), wait);
    const toFading = setTimeout(() => setClaim('fading'), wait + 1500);
    const toSilent = setTimeout(() => setClaim(null), wait + 1950);
    return () => [toSynced, toFading, toSilent].forEach(clearTimeout);
  }, [claimBusy, claim]);

  useEffect(() => {
    if (status !== 'signed-in') setClaim(null);
  }, [status]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
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
        @keyframes wm-seat-breathe { 0%, 100% { opacity: 0.6; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.12); } }
        @keyframes wm-seat-chip-fade { from { opacity: 0; } to { opacity: 1; } }
      `}</style>

      {claim && (
        <span
          style={{
            position: 'absolute',
            right: 'calc(100% + 8px)',
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            height: 28,
            padding: '0 12px',
            whiteSpace: 'nowrap',
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-card)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--shadow-sm)',
            fontFamily: 'var(--font-body)',
            fontSize: 'var(--text-xs)',
            fontWeight: 600,
            color: claim === 'syncing' ? 'var(--accent-gold-600)' : 'var(--accent-olive-600)',
            opacity: claim === 'fading' ? 0 : 1,
            transition: `opacity ${reduced ? 'var(--duration-fast)' : 'var(--duration-base)'} var(--ease-soft)`,
            animation: reduced
              ? 'wm-seat-chip-fade var(--duration-fast) var(--ease-soft)'
              : 'wm-fade-in-up var(--duration-fast) var(--ease-soft)',
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 'var(--radius-full)',
              background: claim === 'syncing' ? 'var(--accent-gold-500)' : 'var(--accent-olive-500)',
              animation: !reduced && claim === 'syncing' ? 'wm-seat-breathe 1.6s var(--ease-standard) infinite' : 'none',
            }}
          />
          {claim === 'syncing' ? 'Syncing…' : 'Synced'}
        </span>
      )}

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={signedIn ? `Account — ${name}` : 'Account'}
        onClick={() => setOpen((v) => !v)}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        style={{
          position: 'relative',
          width: size,
          height: size,
          padding: 0,
          border: 'none',
          borderRadius: 'var(--radius-full)',
          background: 'transparent',
          cursor: 'pointer',
          transform: `scale(${pressed ? 0.94 : 1})`,
          transition: 'transform var(--duration-fast) var(--ease-standard)',
        }}
      >
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
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: 208,
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
              {mine && <MenuRow label={mine.label} detail={mine.count != null ? String(mine.count) : null} onSelect={() => choose(mine.onSelect)} />}
              {onConnect && <MenuRow label="Connect your LLM tools" onSelect={() => choose(onConnect)} />}
              <MenuRow label="Account settings" onSelect={() => choose(onSettings)} />
              <MenuRow label="Sign out" onSelect={() => choose(onSignOut)} />
              {footer && (
                <div style={{ padding: '8px 10px 4px', marginTop: 4, borderTop: '1px solid var(--border-subtle)', fontSize: 'var(--text-xs)', lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                  {footer}
                </div>
              )}
            </>
          ) : (
            <>
              {expired && (
                <div style={{ padding: '8px 10px 10px', marginBottom: 4, borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                  Your sign-in expired. Everything's still here — sign in to keep syncing.
                </div>
              )}
              <MenuRow label="Sign in" onSelect={() => choose(onSignIn)} />
              {onSettings && <MenuRow label="Settings" onSelect={() => choose(onSettings)} />}
            </>
          )}
        </div>
      )}
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
