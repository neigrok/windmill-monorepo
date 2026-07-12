// The account seat (X6) — the ONE unprompted mention of sign-in in the whole product.
// A small round seat that is a quiet ghost outline when signed-out and the user's
// initial avatar when signed-in; clicking it opens a small popover menu. Purely
// presentational: the integration passes user/status and the three handlers, and we
// never touch the network. On a live ghost→signed-in flip we play the claim beat —
// the avatar wakes and a chip beside the seat narrates "Syncing…" then "Synced" and
// fades to silence. A lapsed session (the optional `expired` flag) keeps the ghost
// seat but voices the "your sign-in expired" line in the menu.

import React, { useEffect, useRef, useState } from 'react';
import { Avatar } from '../../components';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SEAT = 36;

export function AccountSeat({ user, status, onSignIn, onSignOut, onSettings, onConnect, expired = false }) {
  const [open, setOpen] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [claim, setClaim] = useState(null); // null | 'syncing' | 'synced' | 'fading'
  const [woke, setWoke] = useState(false);
  const rootRef = useRef(null);
  const prevStatus = useRef(status);

  const reduced = prefersReducedMotion();
  const signedIn = status === 'signed-in' && Boolean(user);
  const name = signedIn ? (user.name?.trim() || user.email) : '';

  // The claim beat fires only on a live ghost→signed-in flip — never on a page reload
  // that resolves loading→signed-in, so a returning session stays silent.
  useEffect(() => {
    const woken = prevStatus.current === 'ghost' && status === 'signed-in';
    prevStatus.current = status;
    if (!woken) return undefined;
    setWoke(true);
    setClaim('syncing');
    const toSynced = setTimeout(() => setClaim('synced'), 1200);
    const toFading = setTimeout(() => setClaim('fading'), 2100);
    const toSilent = setTimeout(() => setClaim(null), 2550);
    const settle = setTimeout(() => setWoke(false), 520);
    return () => [toSynced, toFading, toSilent, settle].forEach(clearTimeout);
  }, [status]);

  // Esc and click-away dismiss the menu — the seat is never a wall.
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
      `}</style>

      {/* Claim chip — floats to the left of the seat so its arrival never nudges it */}
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
            transition: 'opacity var(--duration-base) var(--ease-soft)',
            animation: reduced ? 'none' : 'wm-fade-in-up var(--duration-fast) var(--ease-soft)',
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
          {claim === 'syncing' ? 'Syncing your trees…' : 'Synced'}
        </span>
      )}

      {/* Seat — one round button; the ghost outline and the avatar are stacked and cross-fade */}
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
          width: SEAT,
          height: SEAT,
          padding: 0,
          border: 'none',
          borderRadius: 'var(--radius-full)',
          background: 'transparent',
          cursor: 'pointer',
          transform: `scale(${pressed ? 0.94 : 1})`,
          transition: 'transform var(--duration-fast) var(--ease-standard)',
        }}
      >
        {/* Ghost layer — a quiet person outline; the resting, signed-out face */}
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

        {/* Avatar layer — the user's initial; wakes on the claim beat */}
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
            <Avatar name={name} size={SEAT} />
          </span>
        )}
      </button>

      {/* Menu — a small popover under the seat; two faces, one for each state */}
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
              <div style={{ padding: '8px 10px 10px', borderBottom: '1px solid var(--border-subtle)', marginBottom: 4 }}>
                {user.name?.trim() && (
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {user.name.trim()}
                  </div>
                )}
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.email}
                </div>
              </div>
              {onConnect && <MenuRow label="Connect your LLM tools" onSelect={() => choose(onConnect)} />}
              <MenuRow label="Account settings" onSelect={() => choose(onSettings)} />
              <MenuRow label="Sign out" onSelect={() => choose(onSignOut)} />
            </>
          ) : (
            <>
              {expired && (
                <div style={{ padding: '8px 10px 10px', marginBottom: 4, borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                  Your sign-in expired. Everything's still here — sign in to keep syncing.
                </div>
              )}
              <MenuRow label="Sign in" onSelect={() => choose(onSignIn)} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({ label, onSelect }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      style={{
        display: 'block',
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
    </button>
  );
}

export default AccountSeat;
