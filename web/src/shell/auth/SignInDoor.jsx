// The one sign-in door. Surfaces ask for it (useSignInDoor) and lend it their skin
// (useSignInDoorHost); the modal is portalled into the innermost lent host.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SignInDialog } from './SignInDialog.jsx';
import { requestMagicLink } from './AuthClient.js';
import { useAuth } from './AuthProvider.jsx';
import { readNavigation, subscribeNavigation, replaceLocation } from '../navigation.js';
import { track } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';

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
      const url = new URL(readNavigation().href);
      if (!url.searchParams.has(SIGN_IN_PARAM)) return;
      url.searchParams.delete(SIGN_IN_PARAM);
      replaceLocation(url.toString());
      setUrlAsked(true);
    };
    claim();
    return subscribeNavigation(claim);
  }, []);

  useEffect(() => {
    if (!urlAsked || status === 'loading') return;
    setUrlAsked(false);
    if (status !== 'signed-in') open();
  }, [urlAsked, status, open]);

  useEffect(() => {
    if (status === 'signed-in') setRequest(null);
  }, [status]);

  // Each link asked for tells one `sign_in_link`; a refusal the door words is told alone, any other failure is reported too.
  const send = useCallback(async (email) => {
    let result;
    try { result = await requestMagicLink(email); }
    catch (error) {
      if (['invalid_email', 'rate_limited'].includes(error?.code)) {
        track('sign_in_link', { outcome: 'refused', reason: error.code });
        throw error;
      }
      const reason = !error?.status ? 'network' : error.status >= 500 ? 'server' : 'request';
      track('sign_in_link', { outcome: 'failed', reason });
      captureError('auth', 'auth-magic-link', '', '/auth', { reason });
      throw error;
    }
    track('sign_in_link', { outcome: 'sent' });
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
