// The one sign-in door. Surfaces ask for it (useSignInDoor) and lend it their skin
// (useSignInDoorHost); the modal is portalled into the innermost lent host.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SignInDialog } from './SignInDialog.jsx';
import { requestMagicLink } from './AuthClient.js';
import { useAuth } from './AuthProvider.jsx';

const SIGN_IN_PARAM = 'signin';

const DoorContext = createContext(null);

// open() shows the door, open({ resume }) reopens it on its wait panel, open({ onSent }) tells the
// caller a link went out.
export function useSignInDoor() {
  return useContext(DoorContext).open;
}

// Put this ref on the element carrying your data-theme/data-brand and the modal renders inside it.
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

  // `?signin` is stripped from the URL the moment it is read, so a refresh does not reopen the door.
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

  useEffect(() => {
    if (!urlAsked || status === 'loading') return;
    setUrlAsked(false);
    if (status !== 'signed-in') open();
  }, [urlAsked, status, open]);

  useEffect(() => {
    if (status === 'signed-in') setRequest(null);
  }, [status]);

  const send = useCallback(async (email) => {
    const result = await requestMagicLink(email);
    request?.onSent?.(); // only on a link that actually went out
    return result;
  }, [request]);

  // With several skinned surfaces mounted, the door belongs to the innermost.
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
