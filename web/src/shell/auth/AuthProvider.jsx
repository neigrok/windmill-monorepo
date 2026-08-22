// The auth context: one source of truth for who this tab is. On mount it asks the
// server (fetchMe → signed-in, else ghost), then keeps itself honest so a session
// made in another tab pulls this one forward without a reload — see the effect below.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fetchMe, logout } from './AuthClient.js';
import { DeviceSeat } from './accountChange.js';

const AuthContext = createContext(null);
const CHANNEL_NAME = 'wm-auth';
const POLL_INTERVAL_MS = 20_000;
const HINT_KEY = 'windmill:auth-hint';

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within an AuthProvider');
  return value;
}

// The last settled answer, remembered across reloads so a returning tab paints its true
// face on the first frame instead of flashing signed-out while fetchMe is still in flight.
// Only the two resolved states are written — a blip never overwrites a good hint — and it
// is a pure optimization: fetchMe still runs on every boot and corrects a stale hint.
function rememberAuth(status, user) {
  try {
    if (status === 'signed-in' && user) localStorage.setItem(HINT_KEY, JSON.stringify({ status, user }));
    else if (status === 'ghost') localStorage.setItem(HINT_KEY, JSON.stringify({ status: 'ghost' }));
  } catch { /* storage unavailable — the hint is never load-bearing */ }
}

function readAuthHint() {
  try {
    const hint = JSON.parse(localStorage.getItem(HINT_KEY) || 'null');
    if (hint?.status === 'signed-in' && hint.user) return { status: 'signed-in', user: hint.user };
    if (hint?.status === 'ghost') return { status: 'ghost', user: null };
  } catch { /* absent or malformed — fall through to a cold boot */ }
  return null;
}

export default function AuthProvider({ children }) {
  // The hint PAINTS: a returning signed-in tab renders signed-in on the first frame instead of
  // flashing signed-out. It is never the account — `account` below stays null until the server has
  // answered once on this load, because a hint is the device claiming an identity and the device
  // cannot tell the owner from a stranger holding it (see accountChange.js).
  const [user, setUser] = useState(() => readAuthHint()?.user ?? null);
  const [status, setStatus] = useState(() => readAuthHint()?.status ?? 'loading'); // 'loading' | 'ghost' | 'signed-in'
  // What a product may derive a device scope from: the account /v1/me confirmed on THIS document
  // load, or nobody. A cold start with no network therefore opens a signed-out journal or roadmap
  // even though the pages are still on the disk under it — the deliberate cost of asking the server
  // rather than the device, and the data comes back with the network.
  const [account, setAccount] = useState(null);
  const channelRef = useRef(null);
  const statusRef = useRef(status);
  // The seat is seeded from nothing at all: it holds only accounts the server confirmed, so an
  // unconfirmed hint can neither be handed out nor be treated as the previous account of a change.
  const [seat] = useState(() => new DeviceSeat());

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // fetchMe's three answers — a user → signed-in, null (a real 401) → ghost, undefined (a blip:
  // server error or unreachable) — are all handed to the seat, which owns what each one means and
  // answers null when the answer changes nothing (a blip once this load has a confirmed account:
  // the network dying mid-session must never throw anyone out of their own work).
  const settle = useCallback((me) => {
    const settled = seat.receive(me);
    if (!settled) return null;
    setUser(settled.user);
    setStatus(settled.status);
    setAccount(settled.account);
    if (settled.confirmed) rememberAuth(settled.status, settled.user); // an unreachable blip never poisons the hint
    return settled;
  }, [seat]);

  // Answers what the caller has always been told: the user, null for no session, and undefined for
  // "unknown" — a blip a confirmed seat simply held.
  const refresh = useCallback(async () => {
    const settled = settle(await fetchMe());
    if (!settled) return undefined;
    return settled.user;
  }, [settle]);

  const signIn = useCallback((nextUser) => {
    settle(nextUser);
    channelRef.current?.postMessage({ type: 'signed-in' });
  }, [settle]);

  const signOut = useCallback(async () => {
    await logout();
    settle(null);
    channelRef.current?.postMessage({ type: 'signed-out' });
  }, [settle]);

  // Boot once, then wake the tab from three nudges: another tab's broadcast, a poll
  // while we're still a ghost, and a window refocus. Each just re-asks the server —
  // the session cookie is shared same-origin, so a ghost flips to signed-in on its own.
  useEffect(() => {
    refresh();

    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null;
    channelRef.current = channel;
    if (channel) channel.onmessage = () => refresh();

    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);

    // A lapse is noticed on refocus too, not only on a rejected write (honesty moments):
    // a tab returning to view re-checks a signed-in session so the chrome never lies stale.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && statusRef.current === 'signed-in') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    const poll = setInterval(() => {
      if (statusRef.current === 'ghost') refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      channel?.close();
      channelRef.current = null;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(poll);
    };
  }, [refresh]);

  const value = { user, status, account, signIn, signOut, refresh };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
