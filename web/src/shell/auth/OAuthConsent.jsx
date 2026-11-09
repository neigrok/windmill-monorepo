// The MCP OAuth consent screen: takes one Allow/Cancel and follows the redirect the backend
// returns. It never touches a code, token or PKCE secret.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, BrandWordmark, Icon } from '../../design-system';
import { useAuth } from './AuthProvider.jsx';
import { useSignInDoor } from './SignInDoor.jsx';
import { fetchConsentClient, postDecision } from './OAuthClient.js';
import { consentSummary } from './scopes.js';
import { t } from '../i18n/index.js';

// The OAuth params out of the hash's query; code_challenge, resource, state and scope are echoed
// back untouched.
function readParams() {
  const hash = window.location.hash;
  const q = hash.indexOf('?');
  const p = new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '');
  return {
    clientId: p.get('client_id') ?? '',
    redirectUri: p.get('redirect_uri') ?? '',
    codeChallenge: p.get('code_challenge') ?? '',
    resource: p.get('resource') ?? '',
    scope: p.get('scope') ?? '',
    state: p.get('state') ?? '',
  };
}

function hostOf(uri) {
  try { return new URL(uri).host; } catch { return null; }
}

export function OAuthConsent() {
  const { user, status, signOut, refresh } = useAuth();
  const params = useMemo(readParams, []);
  const missingParams = !params.clientId || !params.redirectUri || !params.codeChallenge;

  const [client, setClient] = useState(null);
  const [failure, setFailure] = useState(null); // null | 'unknown_client' | 'bad_redirect' | 'expired' | 'unreachable'
  const [phase, setPhase] = useState('idle');    // idle | approving | denying
  const openSignInDoor = useSignInDoor();
  const pendingApprove = useRef(null);           // a decision waiting on a re-auth

  const signedIn = status === 'signed-in' && Boolean(user);

  // Fetch the verified client only once signed in, never from the URL.
  useEffect(() => {
    if (missingParams || !signedIn || client || failure) return undefined;
    let cancelled = false;
    fetchConsentClient(params.clientId)
      .then((c) => {
        if (cancelled) return;
        if (!c.redirect_uris?.includes(params.redirectUri)) { setFailure('bad_redirect'); return; }
        setClient(c);
      })
      .catch((err) => { if (!cancelled) setFailure(err.code ?? 'unreachable'); });
    return () => { cancelled = true; };
  }, [missingParams, signedIn, client, failure, params.clientId, params.redirectUri]);

  const decide = useCallback(async (approve) => {
    setPhase(approve ? 'approving' : 'denying');
    setFailure(null);
    try {
      const { redirect } = await postDecision({
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        resource: params.resource,
        scope: params.scope,
        state: params.state,
        approve,
      });
      window.location.href = redirect;
    } catch (err) {
      setPhase('idle');
      if (err.code === 'unauthenticated') { pendingApprove.current = approve; refresh(); openSignInDoor(); }
      else if (err.code === 'expired') setFailure('expired');
      else setFailure('unreachable');
    }
  }, [params, refresh]);

  // Replay a decision that was mid-flight when the session lapsed, once sign-in resolves.
  useEffect(() => {
    if (!signedIn) return;
    if (pendingApprove.current !== null) {
      const approve = pendingApprove.current;
      pendingApprove.current = null;
      decide(approve);
    }
  }, [signedIn, decide]);

  if (missingParams) return <Shell><FailureCard kind="malformed" /></Shell>;
  if (status === 'loading') return <Shell><Loader /></Shell>;

  if (!signedIn) {
    return (
      <Shell>
        <GateCard onSignIn={openSignInDoor} />
      </Shell>
    );
  }

  if (failure) return <Shell><FailureCard kind={failure} onRetry={failure === 'unreachable' ? () => setFailure(null) : null} /></Shell>;
  if (!client) return <Shell><Loader /></Shell>;
  if (phase === 'approving') return <Shell><ApprovedBloom clientName={client.client_name} /></Shell>;
  if (phase === 'denying') return <Shell><QuietReturn /></Shell>;

  return (
    <Shell>
      <ConsentCard
        user={user}
        client={client}
        scope={params.scope}
        redirectHost={hostOf(params.redirectUri)}
        onAllow={() => decide(true)}
        onCancel={() => decide(false)}
        onNotYou={signOut}
      />
    </Shell>
  );
}

export default OAuthConsent;

function ConsentCard({ user, client, scope, redirectHost, onAllow, onCancel, onNotYou }) {
  const name = user.name?.trim() || user.email;
  const { reach, groups, canDelete } = consentSummary(scope);
  return (
    <Card>
      <BrandWordmark size={24} style={mark} />
      <h1 style={title}>{t('shell.oauth.title', { client: client.client_name })}</h1>
      <p style={{ ...cant, marginTop: 8 }}>{t('shell.oauth.review')}</p>

      <div style={acct}>
        <Avatar name={name} size={20} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</span>
        <button type="button" onClick={onNotYou} style={notYou}>{t('shell.oauth.notYou')}</button>
      </div>

      <div style={permissions}>
        {reach === 'everything' ? (
          <p style={permissionLine}>
            <span className="wm-oc-dot wm-oc-dot--delete" aria-hidden="true" />
            {t('shell.oauth.everything')}
          </p>
        ) : reach === 'nothing' ? (
          <p style={permissionLine}>
            <span className="wm-oc-dot" aria-hidden="true" />
            {t('shell.oauth.nothing')}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.product} aria-label={t('shell.oauth.group', { product: group.label })}>
              <h2 style={groupHead}>{t('shell.oauth.group', { product: group.label })}</h2>
              <ul style={permissionList}>
                {group.lines.map((line) => (
                  <li key={line.level} style={permissionLine}>
                    <span className={`wm-oc-dot${line.level === 'delete' ? ' wm-oc-dot--delete' : ''}`} aria-hidden="true" />
                    {line.label}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <p style={cant}>
        {canDelete
          ? t('shell.oauth.canDelete')
          : t('shell.oauth.cannotDelete')}
      </p>

      <div style={btnRow}>
        <button type="button" className="wm-oc-btn" onClick={onCancel}>{t('shell.common.cancel')}</button>
        <button type="button" className="wm-oc-btn wm-oc-btn--allow" onClick={onAllow}>{t('shell.oauth.allow')}</button>
      </div>

      {redirectHost && <p style={foot}>{t('shell.oauth.redirectNote', { host: redirectHost })}</p>}
    </Card>
  );
}

function ApprovedBloom({ clientName }) {
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0 4px' }}>
        <span className="wm-oc-check wm-oc-wake">
          <Icon name="check" size={20} color="var(--color-success)" strokeWidth={2} />
        </span>
      </div>
      <h1 style={{ ...title, textAlign: 'center' }}>{t('shell.oauth.connected')}</h1>
      <p style={{ ...cant, textAlign: 'center', marginTop: 4 }}>{t('shell.oauth.returning', { client: clientName })}</p>
    </Card>
  );
}

function QuietReturn() {
  return (
    <Card>
      <h1 style={{ ...title, textAlign: 'center', marginTop: 8 }}>{t('shell.oauth.noChanges')}</h1>
      <p style={{ ...cant, textAlign: 'center', marginTop: 4 }}>{t('shell.oauth.takingBack')}</p>
    </Card>
  );
}

function GateCard({ onSignIn }) {
  return (
    <Card>
      <BrandWordmark size={24} style={mark} />
      <h1 style={title}>{t('shell.oauth.gateTitle')}</h1>
      <p style={{ ...cant, marginTop: 6 }}>{t('shell.oauth.gateBody')}</p>
      <div style={btnRow}>
        <button type="button" className="wm-oc-btn wm-oc-btn--allow" onClick={onSignIn} style={{ flex: 1 }}>{t('shell.auth.signIn')}</button>
      </div>
    </Card>
  );
}

const FAILURES = {
  malformed: {
    title: t('shell.oauth.malformedTitle'),
    body: t('shell.oauth.malformedBody'),
  },
  unknown_client: {
    title: t('shell.oauth.unknownClientTitle'),
    body: t('shell.oauth.unknownClientBody'),
  },
  bad_redirect: {
    title: t('shell.oauth.badRedirectTitle'),
    body: t('shell.oauth.badRedirectBody'),
  },
  expired: {
    title: t('shell.oauth.expiredTitle'),
    body: t('shell.oauth.expiredBody'),
  },
  unreachable: {
    title: t('shell.oauth.unreachableTitle'),
    body: t('shell.oauth.unreachableBody'),
    brick: true,
  },
};

function FailureCard({ kind, onRetry }) {
  const f = FAILURES[kind] ?? FAILURES.malformed;
  return (
    <Card>
      <BrandWordmark size={24} style={mark} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {f.brick && <Icon name="wifi" size={18} color="var(--text-secondary)" />}
        <h1 style={title}>{f.title}</h1>
      </div>
      <p style={{ ...cant, marginTop: 8 }}>{f.body}</p>
      <div style={btnRow}>
        {onRetry && <button type="button" className="wm-oc-btn wm-oc-btn--allow" onClick={onRetry} style={{ flex: 1 }}>{t('shell.common.tryAgain')}</button>}
        {!onRetry && <a href="#/" className="wm-oc-btn" style={{ flex: 1, textDecoration: 'none' }}>{t('shell.oauth.backToWindmill')}</a>}
      </div>
    </Card>
  );
}

function Loader() {
  return (
    <Card>
      <BrandWordmark size={24} style={mark} />
      <p role="status" style={cant}>{t('shell.oauth.preparing')}</p>
    </Card>
  );
}

function Shell({ children }) {
  return (
    <main className="wm-oc-shell">
      <style>{CONSENT_CSS}</style>
      {children}
    </main>
  );
}

function Card({ children }) {
  return <div className="wm-oc-card">{children}</div>;
}

const mark = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)' };

const title = { fontFamily: 'var(--font-display)', fontSize: '24px', fontWeight: 500, lineHeight: 1.35, letterSpacing: '-0.02em', margin: '16px 0 0', overflowWrap: 'anywhere' };

const acct = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 'var(--text-xs)',
  color: 'var(--text-secondary)',
  margin: '16px 0 0',
};

const notYou = {
  marginLeft: 'auto',
  flexShrink: 0,
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  background: 'none',
  minHeight: 44,
  padding: '0 4px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 'var(--text-xs)',
  fontWeight: 500,
  color: 'var(--text-link)',
};

const permissions = { display: 'grid', gap: 20, margin: '24px 0' };

const groupHead = { fontSize: 'var(--text-sm)', fontWeight: 600, lineHeight: 1.5, color: 'var(--text-primary)', margin: '0 0 8px' };

const permissionList = { listStyle: 'none', display: 'grid', gap: 8, padding: 0, margin: 0 };

const permissionLine = { display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 'var(--text-sm)', lineHeight: 1.5, fontWeight: 400, color: 'var(--text-secondary)', margin: 0, overflowWrap: 'anywhere' };

const cant = { fontSize: '13px', lineHeight: 1.65, color: 'var(--text-secondary)', margin: '20px 0 0' };

const btnRow = { display: 'flex', gap: 12, marginTop: 24 };

const foot = { fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.6, textAlign: 'center', margin: '16px 0 0', overflowWrap: 'anywhere' };

const CONSENT_CSS = `
  .wm-oc-shell { position:fixed; inset:0; display:flex; overflow-y:auto; box-sizing:border-box;
    padding:32px 16px; background:var(--surface-canvas); font-family:var(--font-body); color:var(--text-primary); }
  .wm-oc-card { width:440px; max-width:100%; flex:none; box-sizing:border-box; margin:auto;
    padding:32px; background:var(--surface-card); border:1px solid var(--border-subtle);
    border-radius:24px; box-shadow:var(--shadow-sm); }
  .wm-oc-dot { width:8px; height:8px; box-sizing:border-box; flex:none; border-radius:50%;
    background:var(--text-tertiary); }
  .wm-oc-dot--delete { border:1px solid var(--text-secondary); background:transparent; }
  .wm-oc-check { display:inline-flex; align-items:center; justify-content:center; width:44px; height:44px;
    border-radius:50%; background:var(--color-success-bg); }
  .wm-oc-wake { animation:wm-oc-wake 480ms var(--ease-soft) 1; }
  @keyframes wm-oc-wake { 0% { transform:scale(.82); opacity:0; } 55% { transform:scale(1.04); opacity:1; } 100% { transform:scale(1); } }
  .wm-oc-btn { flex:1; display:inline-flex; align-items:center; justify-content:center; cursor:pointer;
    min-height:44px; box-sizing:border-box; font-family:var(--font-body); font-size:var(--text-sm); font-weight:500;
    padding:12px 16px; border-radius:var(--radius-full); border:1px solid var(--border-subtle);
    background:transparent; color:var(--text-primary);
    transition:background var(--duration-fast) var(--ease-standard); }
  .wm-oc-btn:hover { background:var(--surface-hover); }
  .wm-oc-btn--allow { border-color:transparent; background:var(--color-brand); color:var(--text-on-accent); }
  .wm-oc-btn--allow:hover { background:var(--color-brand-hover); }
  .wm-oc-btn--allow:active { background:var(--color-brand-active); }
  .wm-oc-shell :is(button,a):focus-visible { outline:2px solid var(--color-brand); outline-offset:4px; }
  @media (max-width:480px) {
    .wm-oc-shell { padding:16px; }
    .wm-oc-card { padding:24px; }
  }
  @media (prefers-reduced-motion:reduce) {
    .wm-oc-btn { transition:none; }
    @keyframes wm-oc-wake { 0% { opacity:0; } 100% { opacity:1; } }
  }
`;
