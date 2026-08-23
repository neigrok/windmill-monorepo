// Reads /v1/subscription and hands products one signal, `windmillOne`.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { fetchSubscription } from './checkout.js';

const EntitlementsContext = createContext(null);

export function useEntitlements() {
  const value = useContext(EntitlementsContext);
  if (!value) throw new Error('useEntitlements must be used within an EntitlementsProvider');
  return value;
}

export default function EntitlementsProvider({ children }) {
  const { status } = useAuth();
  // Tagged with the session state it was computed for; `loading` is derived at render, not in an
  // effect, so a ghost→signed-in flip reports loading in the same commit.
  const [state, setState] = useState({ windmillOne: false, settledFor: null });
  // Only the newest read may land.
  const reqRef = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++reqRef.current;
    if (status !== 'signed-in') {
      if (id === reqRef.current) setState({ windmillOne: false, settledFor: status });
      return false;
    }
    const subscription = await fetchSubscription();
    const windmillOne = Boolean(subscription?.active);
    if (id === reqRef.current) setState({ windmillOne, settledFor: 'signed-in' });
    return windmillOne;
  }, [status]);

  useEffect(() => {
    refresh();
    if (status !== 'signed-in') return undefined;
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [status, refresh]);

  const loading = status === 'signed-in' && state.settledFor !== 'signed-in';
  const value = { loading, windmillOne: state.windmillOne, refresh };
  return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>;
}
