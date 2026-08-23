// One source of truth for who this tab is; re-asked on a broadcast, a refocus and a ghost poll.

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

// Only the two resolved states are written: a blip never overwrites a good hint.
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
  // The hint only paints; it is never the account.
  const [user, setUser] = useState(() => readAuthHint()?.user ?? null);
  const [status, setStatus] = useState(() => readAuthHint()?.status ?? 'loading'); // 'loading' | 'ghost' | 'signed-in'
  const [account, setAccount] = useState(null);
  const channelRef = useRef(null);
  const statusRef = useRef(status);
  const [seat] = useState(() => new DeviceSeat());

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const settle = useCallback((me) => {
    const settled = seat.receive(me);
    if (!settled) return null;
    setUser(settled.user);
    setStatus(settled.status);
    setAccount(settled.account);
    if (settled.confirmed) rememberAuth(settled.status, settled.user);
    return settled;
  }, [seat]);

  // Returns the user, null for no session, undefined for a blip.
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

  useEffect(() => {
    refresh();

    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null;
    channelRef.current = channel;
    if (channel) channel.onmessage = () => refresh();

    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);

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
