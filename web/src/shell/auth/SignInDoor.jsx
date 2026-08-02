// The one sign-in door — one piece of state, one mount, one address.
//
// Before this, ten surfaces each kept their own `signInOpen` flag and their own SignInDialog,
// and the only way to open somebody else's was a counter prop-drilled from the router through
// three product route tables. A static marketing page can hand over nothing but a URL, so
// /gym's "Sign in" had nothing to aim at: it navigated to the app root and hoped. The door now
// answers to `?signin` on any URL — `/?signin#/gym` opens gym's own door — and the flag is
// stripped the moment it is read, so a refresh doesn't reopen it.
//
// Surfaces no longer own the door; they ask for it (useSignInDoor) and lend it their skin
// (useSignInDoorHost). The modal is portalled into the innermost lent host, so it still wears
// the room it opens over — including journal's live light/dark — and DOM containment decides
// which host that is, never the order two effects happened to run in.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SignInDialog } from './SignInDialog.jsx';
import { requestMagicLink } from './AuthClient.js';
import { useAuth } from './AuthProvider.jsx';

const SIGN_IN_PARAM = 'signin';

const DoorContext = createContext(null);

// Ask for the door: open() shows it, open({ resume }) reopens it on its wait panel, and
// open({ onSent }) tells the caller a link went out (the landing's "check your email" chip).
export function useSignInDoor() {
  return useContext(DoorContext).open;
}

// Lend the door your skin: put this ref on the element that carries your data-theme/data-brand
// and the modal renders inside it, inheriting the tokens it already sets for its own subtree.
export function useSignInDoorHost() {
  const { lendHost } = useContext(DoorContext);
  const lent = useRef(null);
  return useCallback((element) => {
    if (lent.current) lendHost(lent.current, false);
    lent.current = element;
    if (element) lendHost(element, true);
  }, [lendHost]);
}

export function SignInDoorProvider({ children }) {
  const { status } = useAuth();
  const [request, setRequest] = useState(null); // null while shut; { resume, onSent } while open
  const [hosts, setHosts] = useState([]);
  const [urlAsked, setUrlAsked] = useState(false);

  const open = useCallback((options = {}) => {
    setRequest({ resume: options.resume ?? null, onSent: options.onSent ?? null });
  }, []);

  const lendHost = useCallback((element, lending) => {
    setHosts((current) => (lending ? [...current, element] : current.filter((held) => held !== element)));
  }, []);

  // `?signin` on any URL, read on arrival and on every navigation. Consuming it rewrites the
  // URL in place, so the address is a one-shot instruction and never sticky state.
  useEffect(() => {
    const claim = () => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has(SIGN_IN_PARAM)) return;
      url.searchParams.delete(SIGN_IN_PARAM);
      window.history.replaceState({}, '', url.toString());
      setUrlAsked(true);
    };
    claim();
    window.addEventListener('hashchange', claim);
    window.addEventListener('popstate', claim);
    return () => {
      window.removeEventListener('hashchange', claim);
      window.removeEventListener('popstate', claim);
    };
  }, []);

  // Held until we know who is asking: a link followed by someone already signed in is already
  // through the door, and opening it at them would be a modal with nothing behind it.
  useEffect(() => {
    if (!urlAsked || status === 'loading') return;
    setUrlAsked(false);
    if (status !== 'signed-in') open();
  }, [urlAsked, status, open]);

  // Sign-in usually lands in the other tab, where the link was opened. Whichever surface is
  // showing, the door that asked for it is done.
  useEffect(() => {
    if (status === 'signed-in') setRequest(null);
  }, [status]);

  const send = useCallback(async (email) => {
    const result = await requestMagicLink(email);
    request?.onSent?.(); // only on a link that actually went out — a throw never reaches here
    return result;
  }, [request]);

  // Several skinned surfaces are mounted at once — the shell, and the product room inside it.
  // The door belongs to the innermost, and containment says which that is.
  const host = useMemo(
    () => hosts.reduce((inner, element) => (inner && !inner.contains(element) ? inner : element), null),
    [hosts],
  );

  const value = useMemo(() => ({ open, lendHost }), [open, lendHost]);

  return (
    <DoorContext.Provider value={value}>
      {children}
      {request && createPortal(
        <SignInDialog open resume={request.resume} onClose={() => setRequest(null)} onSend={send} />,
        host ?? document.body,
      )}
    </DoorContext.Provider>
  );
}

export default SignInDoorProvider;
