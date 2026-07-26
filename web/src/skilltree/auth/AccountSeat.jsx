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

export function AccountSeat({ user, status, size = 36, onSignIn, onSignOut, onSettings, onConnect, onMyTrees, treeCount = null, footer, expired = false, claimBusy }) {
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

  // The claim beat fires only on a live ghost→signed-in flip — never on a page reload
  // that resolves loading→signed-in, so a returning session stays silent. Without a
  // claimBusy prop the chip runs on its own clock (today's timers); with one
  // (anon-first-tree F5) the gold "Syncing your trees…" holds until the claim run
  // reports done — the effect below takes over.
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

  // claimBusy released while the chip is gold: give the syncing line its minimum beat,
  // then "Synced" (olive) holds 1.5s and fades to silence. A re-armed claimBusy cancels
  // the countdown and the gold line simply keeps breathing.
  useEffect(() => {
    if (claimBusy === undefined || claimBusy === true || claim !== 'syncing') return undefined;
    const wait = Math.max(0, 1200 - (Date.now() - beatStartRef.current));
    if (claimBusy === 'incomplete') {
      // Some trees stayed unclaimed (server unreachable mid-run): never say "Synced" —
      // the gold line just fades; the registry tags keep telling the truth and the next
      // boot retries silently.
      const toFading = setTimeout(() => setClaim('fading'), wait);
      const toSilent = setTimeout(() => setClaim(null), wait + 450);
      return () => [toFading, toSilent].forEach(clearTimeout);
    }
    const toSynced = setTimeout(() => setClaim('synced'), wait);
    const toFading = setTimeout(() => setClaim('fading'), wait + 1500);
    const toSilent = setTimeout(() => setClaim(null), wait + 1950);
    return () => [toSynced, toFading, toSilent].forEach(clearTimeout);
  }, [claimBusy, claim]);

  // Sign-out mid-claim: the chip must not survive into the ghost seat and later flash
  // "Synced" at nobody — any departure from signed-in silences it.
  useEffect(() => {
    if (status !== 'signed-in') setClaim(null);
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
        @keyframes wm-seat-chip-fade { from { opacity: 0; } to { opacity: 1; } }
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
            // Reduced motion keeps the chip's story in 150ms cross-fades — no rise, no scale.
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
            <Avatar name={name} size={size} />
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
              {onMyTrees && <MenuRow label="My trees" detail={treeCount != null ? String(treeCount) : null} onSelect={() => choose(onMyTrees)} />}
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
