// The auth context: one source of truth for who this tab is. On mount it asks the
// server (fetchMe → signed-in, else ghost), then keeps itself honest so a session
// made in another tab pulls this one forward without a reload — see the effect below.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fetchMe, logout } from './AuthClient.js';

const AuthContext = createContext(null);
const CHANNEL_NAME = 'wm-auth';
const POLL_INTERVAL_MS = 20_000;

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within an AuthProvider');
  return value;
}

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ghost' | 'signed-in'
  const channelRef = useRef(null);
  const statusRef = useRef(status);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const refresh = useCallback(async () => {
    const me = await fetchMe();
    setUser(me ?? null);
    setStatus(me ? 'signed-in' : 'ghost');
    return me;
  }, []);

  const signIn = useCallback((nextUser) => {
    setUser(nextUser);
    setStatus('signed-in');
    channelRef.current?.postMessage({ type: 'signed-in' });
  }, []);

  const signOut = useCallback(async () => {
    await logout();
    setUser(null);
    setStatus('ghost');
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

    const poll = setInterval(() => {
      if (statusRef.current === 'ghost') refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      channel?.close();
      channelRef.current = null;
      window.removeEventListener('focus', onFocus);
      clearInterval(poll);
    };
  }, [refresh]);

  const value = { user, status, signIn, signOut, refresh };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
