import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { fetchSubscription, holdsWindmillOne } from './subscription.js';

const EntitlementsContext = createContext(null);

export function useEntitlements() {
  const value = useContext(EntitlementsContext);
  if (!value) throw new Error('useEntitlements must be used within an EntitlementsProvider');
  return value;
}

export function useOptionalEntitlements() {
  return useContext(EntitlementsContext);
}

export default function EntitlementsProvider({ children }) {
  const { status } = useAuth();
  const [state, setState] = useState({
    windmillOne: false,
    subscription: null,
    readStatus: 'loading',
    settledFor: null,
  });
  const reqRef = useRef(0);

  const refresh = useCallback(async ({ pending = false } = {}) => {
    const id = ++reqRef.current;
    if (status !== 'signed-in') {
      if (id === reqRef.current) {
        setState({ windmillOne: false, subscription: null, readStatus: 'ready', settledFor: status });
      }
      return false;
    }
    if (pending) {
      setState((prev) => ({ ...prev, readStatus: 'loading', settledFor: null }));
    }
    const subscription = await fetchSubscription();
    const windmillOne = holdsWindmillOne(subscription);
    if (id === reqRef.current) {
      setState({
        windmillOne,
        subscription,
        readStatus: subscription ? 'ready' : 'error',
        settledFor: 'signed-in',
      });
    }
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
  const subscriptionStatus = status === 'loading' || loading
    ? 'loading'
    : status !== 'signed-in'
      ? 'ready'
      : state.readStatus;
  const subscription = status === 'signed-in' && !loading ? state.subscription : null;
  const value = {
    loading,
    windmillOne: status === 'signed-in' ? state.windmillOne : false,
    subscription,
    subscriptionStatus,
    refresh,
  };
  return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>;
}
