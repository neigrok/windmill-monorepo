// The auth context: one source of truth for who this tab is. On mount it asks the
// server (fetchMe → signed-in, else ghost), then keeps itself honest so a session
// made in another tab pulls this one forward without a reload — see the effect below.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fetchMe, logout } from './AuthClient.js';

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
  // Seed from the last remembered answer so a returning signed-in tab renders signed-in on
  // the first frame; a first-ever visit has no hint and settles through 'loading' as before.
  const [user, setUser] = useState(() => readAuthHint()?.user ?? null);
  const [status, setStatus] = useState(() => readAuthHint()?.status ?? 'loading'); // 'loading' | 'ghost' | 'signed-in'
  const channelRef = useRef(null);
  const statusRef = useRef(status);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // fetchMe's three answers: a user → signed-in, null (a real 401) → ghost, undefined
  // (a blip — server error or unreachable) → keep the current status untouched and let
  // the next nudge retry. The one exception is boot: 'loading' has to resolve, and a
  // ghost still works offline, so an unreachable server at boot settles there.
  const refresh = useCallback(async () => {
    const me = await fetchMe();
    if (me === undefined && statusRef.current !== 'loading') return undefined;
    setUser(me ?? null);
    setStatus(me ? 'signed-in' : 'ghost');
    if (me !== undefined) rememberAuth(me ? 'signed-in' : 'ghost', me); // an unreachable blip never poisons the hint
    return me ?? null;
  }, []);

  const signIn = useCallback((nextUser) => {
    setUser(nextUser);
    setStatus('signed-in');
    rememberAuth('signed-in', nextUser);
    channelRef.current?.postMessage({ type: 'signed-in' });
  }, []);

  const signOut = useCallback(async () => {
    await logout();
    setUser(null);
    setStatus('ghost');
    rememberAuth('ghost', null);
    channelRef.current?.postMessage({ type: 'signed-out' });
  }, []);

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

  const value = { user, status, signIn, signOut, refresh };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
