// What this account is entitled to — the frontend half of the platform's one paid axis. It reads
// the same /v1/subscription the backend gates on (fetchSubscription), and hands products a single
// honest signal: `windmillOne`. A product never talks to Paddle or reasons about a subscription
// status — it asks useEntitlements() whether Windmill One is held, exactly as the backend asks its
// Entitlements seam. That keeps the paywall coherent: the mic, the echoes, any paid door is drawn
// from the same truth the server enforces, instead of each surface discovering a 403 after the fact.
//
// The read tracks the session: a ghost holds nothing (no fetch, no flash of a paid door as open),
// and a signed-in tab re-asks on sign-in and on refocus so a checkout completed in another tab, or a
// lapse, pulls this one forward. It is intentionally a sibling of AuthProvider, not folded into it —
// identity is the auth adapter's concern; billing is the billing adapter's, and neither should learn
// the other's vocabulary.

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
  // The answer, tagged with the session state it was computed for. `loading` is DERIVED from that at
  // render, not set in an effect — so on a live ghost→signed-in flip the provider reports loading in
  // the very same commit the status changes, and a subscriber never flashes a locked door for a frame.
  const [state, setState] = useState({ windmillOne: false, settledFor: null });
  // Only the newest read may land: a slow /v1/subscription resolving after the account signed out (or
  // after a newer refresh) must not overwrite the current truth with a stale one.
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

  // Re-read whenever the session settles to a new state, and on refocus while signed in — a card
  // bought or a subscription lapsed elsewhere becomes true here without a reload.
  useEffect(() => {
    refresh();
    if (status !== 'signed-in') return undefined;
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [status, refresh]);

  // A signed-in account is loading only until its own read settles; a ghost holds nothing and never
  // spins. Because settledFor lags status by one commit on a flip, this reads true the instant a
  // sign-in lands and false again the moment the signed-in read returns.
  const loading = status === 'signed-in' && state.settledFor !== 'signed-in';
  const value = { loading, windmillOne: state.windmillOne, refresh };
  return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>;
}
