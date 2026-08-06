// The MCP OAuth consent screen (F17 §2) — the ONE frontend surface in the whole
// OAuth flow. The backend's /oauth/authorize validates the request and redirects the
// browser here, at #/oauth/authorize?…, with the PKCE/anti-CSRF params riding in the
// hash. We show the user who's asking, take one Allow/Cancel, and follow the redirect
// the backend returns — we never touch a code, token, or PKCE secret.
//
// Reconciled with the design mock: the params live in OAuth, so "Allow blooms once →
// Connected" plays optimistically over the decision round-trip and then the browser
// hands back to the tool (there is no post-Allow Windmill screen — that lives on the
// client's callback). Deny is a redirect too, carrying access_denied. The three states
// the mock never drew — unknown app, mismatched redirect, expired request — render in
// the calm register; only "can't reach" is a brick, per auth.md.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Icon } from '../../design-system';
import { useAuth } from './AuthProvider.jsx';
import { useSignInDoor } from './SignInDoor.jsx';
import { fetchConsentClient, postDecision } from './OAuthClient.js';
import { capabilityGroups } from './scopes.js';

// Read the OAuth params out of the hash's query (…#/oauth/authorize?client_id=…).
// Three of these (code_challenge, resource, state) are opaque and echoed back untouched; `scope` is
// echoed untouched too, but it is no longer opaque to US — it is the thing this screen is for.
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

  // Fetch the verified client once we're signed in — never before, and never from the
  // URL. A redirect_uri the client never registered is a spoof attempt: refuse it.
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
      window.location.href = redirect; // hands the browser back to the MCP client — we're done
    } catch (err) {
      setPhase('idle');
      if (err.code === 'unauthenticated') { pendingApprove.current = approve; refresh(); openSignInDoor(); }
      else if (err.code === 'expired') setFailure('expired');
      else setFailure('unreachable');
    }
  }, [params, refresh]);

  // Sign-in resolves in another tab (magic link) and AuthProvider flips this one. The door
  // shuts itself on that flip; what's ours is the replay — if a decision was mid-flight when
  // the session lapsed, run it again. Nothing in the client re-runs; the params never left the URL.
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

// ---- the pieces ---------------------------------------------------------

// The card renders THE REQUEST — the scopes this client actually asked for, grouped by product — and
// never a fixed list. Windmill is several products behind one account, so the tool asking may be
// reaching for a training log; three hardcoded roadmap lines would have been a screen that describes
// a different grant from the one the button hands over.
function ConsentCard({ user, client, scope, redirectHost, onAllow, onCancel, onNotYou }) {
  const name = user.name?.trim() || user.email;
  const groups = capabilityGroups(scope);
  const canDelete = groups.some((group) => group.lines.some((line) => line.level === 'delete'));
  return (
    <Card>
      <div style={mark}>Windmill</div>
      <h1 style={title}>
        <b>{client.client_name}</b> wants access to your Windmill account
      </h1>

      <div style={acct}>
        <Avatar name={name} size={20} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</span>
        <button type="button" onClick={onNotYou} style={notYou}>Not you?</button>
      </div>

      {groups.length === 0 ? (
        // The legacy grant: a client that asked for nothing in particular gets the account-wide one
        // this server issued before it had a vocabulary, and it is named rather than dressed up.
        <div style={{ marginTop: 6 }}>
          <div style={grow}>
            <span className="wm-oc-nd wm-oc-bud" />
            Everything in your account — every product, including deleting
          </div>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.product} style={{ marginTop: 8 }}>
            <div style={groupHead}>Your {group.label}</div>
            {group.lines.map((line) => (
              <div key={line.level} style={line.level === 'delete' ? { ...grow, ...growGone } : grow}>
                <span className={`wm-oc-nd wm-oc-${line.glyph}`} />
                {line.label}
              </div>
            ))}
          </div>
        ))
      )}

      <p style={cant}>
        {canDelete
          ? 'Deleting is permanent — this tool can remove things you made. It can’t see your chats or read anything you didn’t grant above.'
          : 'It can only do what’s listed above. It can’t see your chats, and nothing else in your account is reachable.'}
      </p>

      <div style={btnRow}>
        <button type="button" className="wm-oc-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="wm-oc-btn wm-oc-btn--allow" onClick={onAllow}>Allow</button>
      </div>

      {redirectHost && <p style={foot}>Allowing sends you back to {redirectHost}. Only grant access to tools you trust — disconnect anytime in account settings.</p>}
    </Card>
  );
}

// Allow blooms once — the olive check wakes while the decision round-trips, then the
// browser follows the redirect back to the tool (F17 §2, reconciled with the OAuth flow).
function ApprovedBloom({ clientName }) {
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0 4px' }}>
        <span className={`wm-oc-check ${reduced() ? '' : 'wm-oc-wake'}`}>
          <Icon name="check" size={20} color="#fff" strokeWidth={3} />
        </span>
      </div>
      <h1 style={{ ...title, textAlign: 'center' }}>Connected</h1>
      <p style={{ ...cant, textAlign: 'center', marginTop: 4 }}>Returning to {clientName}…</p>
    </Card>
  );
}

function QuietReturn() {
  return (
    <Card>
      <h1 style={{ ...title, textAlign: 'center', marginTop: 8 }}>No changes made</h1>
      <p style={{ ...cant, textAlign: 'center', marginTop: 4 }}>Taking you back…</p>
    </Card>
  );
}

function GateCard({ onSignIn }) {
  return (
    <Card>
      <div style={mark}>Windmill</div>
      <h1 style={title}>Sign in to connect your tool</h1>
      <p style={{ ...cant, marginTop: 6 }}>Connecting a tool starts with signing in — the same magic link as always. Your tool waits right where it is.</p>
      <div style={btnRow}>
        <button type="button" className="wm-oc-btn wm-oc-btn--allow" onClick={onSignIn} style={{ flex: 1 }}>Email me a link</button>
      </div>
    </Card>
  );
}

const FAILURES = {
  malformed: {
    title: 'This request is incomplete',
    body: 'The authorization link is missing something. Start again from your MCP client — it will send you back here with a fresh one.',
  },
  unknown_client: {
    title: 'We don’t recognize this app',
    body: 'This link is for an application Windmill hasn’t seen register. Start again from your MCP client.',
  },
  bad_redirect: {
    title: 'This link doesn’t add up',
    body: 'Where it wants to send you back doesn’t match what this app registered. For your safety, we won’t continue — start again from your MCP client.',
  },
  expired: {
    title: 'This sign-in request expired',
    body: 'These links last about ten minutes. Start again from your MCP client and you’ll come right back.',
  },
  unreachable: {
    title: 'Can’t reach windmill.works',
    body: 'Check your connection and try again — nothing was authorized.',
    brick: true,
  },
};

function FailureCard({ kind, onRetry }) {
  const f = FAILURES[kind] ?? FAILURES.malformed;
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {f.brick && <Icon name="wifi" size={18} color="var(--color-danger)" />}
        <h1 style={{ ...title, color: f.brick ? 'var(--color-danger)' : 'var(--text-primary)' }}>{f.title}</h1>
      </div>
      <p style={{ ...cant, marginTop: 8 }}>{f.body}</p>
      <div style={btnRow}>
        {onRetry && <button type="button" className="wm-oc-btn wm-oc-btn--allow" onClick={onRetry} style={{ flex: 1 }}>Try again</button>}
        {!onRetry && <a href="#/" className="wm-oc-btn" style={{ flex: 1, textDecoration: 'none' }}>Back to Windmill</a>}
      </div>
    </Card>
  );
}

function Loader() {
  return (
    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--text-xl)', color: 'var(--text-tertiary)', letterSpacing: 'var(--tracking-wide)' }}>
      Windmill
    </div>
  );
}

function Shell({ children }) {
  return (
    <div style={shell}>
      <style>{GLYPH_CSS}</style>
      {children}
    </div>
  );
}

function Card({ children }) {
  return <div style={card}>{children}</div>;
}

// ---- style ---------------------------------------------------------------

const shell = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--space-4)',
  background: 'var(--surface-canvas)',
  fontFamily: 'var(--font-body)',
  color: 'var(--text-primary)',
};

const card = {
  width: 340,
  maxWidth: '100%',
  boxSizing: 'border-box',
  background: 'var(--surface-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xl)',
  boxShadow: 'var(--shadow-lg)',
  padding: '20px 20px 16px',
};

const mark = { fontFamily: 'var(--font-display)', fontSize: 'var(--text-xs)', fontWeight: 800, color: 'var(--text-tertiary)' };

const title = { fontFamily: 'var(--font-display)', fontSize: '17px', fontWeight: 700, lineHeight: 1.3, margin: '8px 0 2px' };

const acct = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 'var(--text-xs)',
  color: 'var(--text-secondary)',
  margin: '10px 0 4px',
};

const notYou = {
  marginLeft: 'auto',
  flexShrink: 0,
  border: 'none',
  background: 'none',
  padding: 0,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '11px',
  fontWeight: 700,
  color: 'var(--text-link)',
};

const groupHead = {
  fontSize: '10px',
  fontWeight: 800,
  letterSpacing: 'var(--tracking-wide)',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
  margin: '0 2px 2px',
};

const grow = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 10px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--surface-canvas)',
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  marginTop: 5,
};

// Delete does not wear the same face as the rest. The line a person skims past is the one that
// takes something away, so it is the one line on the card that is allowed to look different.
const growGone = { color: 'var(--color-danger)' };

const cant = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-tertiary)', margin: '10px 2px 0' };

const btnRow = { display: 'flex', gap: 8, marginTop: 14 };

const foot = { fontSize: '10px', color: 'var(--text-tertiary)', lineHeight: 1.5, textAlign: 'center', marginTop: 10 };

// The node glyphs (F17 §3, inline hues — there are no --kind-* tokens on the DOM side),
// the button pseudo-states, and the one wake keyframe Allow blooms with. `gone` is the delete level:
// a hollow brick ring rather than a filled node, because the level it marks is the one that empties.
const GLYPH_CSS = `
  .wm-oc-nd { width:14px; height:14px; border-radius:50%; box-sizing:border-box; flex:none; }
  .wm-oc-dim  { border:2px solid rgba(95,132,148,.32); background:rgba(95,132,148,.22); }
  .wm-oc-bud  { border:2px dashed #BC6C42; background:rgba(188,108,66,.16); }
  .wm-oc-gone { border:2.5px solid #9E3B32; background:transparent; }
  .wm-oc-done { border:2.5px solid #6F3B67; background:#8D4F83;
                box-shadow:0 0 0 3px rgba(141,79,131,.4), 0 0 16px rgba(141,79,131,.4); }
  .wm-oc-check { display:inline-flex; align-items:center; justify-content:center; width:38px; height:38px;
                 border-radius:50%; background:#7D8C43; border:2.5px solid #616E33;
                 box-shadow:0 0 0 4px rgba(125,140,67,.28), 0 0 26px 6px rgba(125,140,67,.28); }
  .wm-oc-wake { animation:wm-oc-wake 480ms var(--ease-soft) 1; }
  @keyframes wm-oc-wake { 0% { transform:scale(.82); opacity:0; } 55% { transform:scale(1.04); opacity:1; } 100% { transform:scale(1); } }
  .wm-oc-btn { flex:1; display:inline-flex; align-items:center; justify-content:center; cursor:pointer;
               font-family:var(--font-body); font-size:var(--text-sm); font-weight:700; padding:10px 16px;
               border-radius:var(--radius-md); border:1.5px solid var(--border-default);
               background:var(--surface-card); color:var(--text-primary);
               transition:background var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard); }
  .wm-oc-btn:hover { background:var(--surface-hover); }
  .wm-oc-btn:active { transform:scale(.97); }
  .wm-oc-btn--allow { border-color:transparent; background:var(--color-brand); color:var(--text-on-accent); box-shadow:var(--shadow-sm); }
  .wm-oc-btn--allow:hover { background:var(--color-brand-hover); }
`;
