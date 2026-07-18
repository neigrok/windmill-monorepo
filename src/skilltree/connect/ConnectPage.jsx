// The connect surface (F17 §2) — windmill.works/connect. One page that answers exactly
// three things: which tool, what to paste, what happens next. Tool tabs (tools, not
// transports), one dark snippet well with one Copy, per-tool steps, the passive waiting
// seat, and the five-verb capability chips. The snippet carries no secret — the promise
// line replaces the auth wall, and first connect opens the browser to approve (§3, the
// grant, is OAuthConsent). Signed out, the page still shows; Copy opens the sign-in door.
//
// Canon: guidelines/mcp-connect.md. Copy, snippets, and steps are cited from it verbatim.

import React, { useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { requestMagicLink } from '../auth/AuthClient.js';
import { SignInDialog } from '../auth/SignInDialog.jsx';
import { AccountChrome } from '../account/AccountChrome.jsx';
import { McpKeyPanel } from './McpKeyPanel.jsx';

const MCP_URL = 'https://windmill.works/mcp';
const JSON_TEXT = `{\n  "mcpServers": {\n    "windmill": { "url": "${MCP_URL}" }\n  }\n}`;
const JSON_COPY = `{ "mcpServers": { "windmill": { "url": "${MCP_URL}" } } }`;

// One roster for the tabs — the snippet, its label, and the follow-up steps all swap per
// tool; the URL inside never varies (§2 per-tool snippets). Default tab is Claude Code.
const CLIENTS = [
  { id: 'desktop', tab: 'Claude Desktop', who: 'Claude Desktop', lang: 'CONNECTOR URL', copyLbl: 'Copy URL',
    copy: MCP_URL, pre: MCP_URL,
    steps: [['1', 'Open Settings → Connectors'], ['2', 'Add custom connector'], ['3', 'Name it Windmill, paste the URL — done']] },
  { id: 'code', tab: 'Claude Code', who: 'Claude Code', lang: 'TERMINAL — ONE LINE',
    copy: `claude mcp add --transport http windmill ${MCP_URL}`,
    pre: `claude mcp add --transport http \\\n  windmill ${MCP_URL}`,
    steps: [['↵', 'Run it anywhere — your browser opens to approve on first use']] },
  { id: 'cursor', tab: 'Cursor', who: 'Cursor', lang: '~/.cursor/mcp.json',
    copy: JSON_COPY, pre: JSON_TEXT,
    steps: [['1', 'Save, then switch it on under Cursor settings → MCP'], ['2', 'Approve in the browser tab Cursor opens']] },
  { id: 'codex', tab: 'Codex', who: 'Codex', lang: '~/.codex/config.toml',
    copy: `[mcp_servers.windmill]\nurl = "${MCP_URL}"`,
    pre: `[mcp_servers.windmill]\nurl = "${MCP_URL}"`,
    steps: [['1', 'Add to config.toml and restart Codex'], ['2', 'Approve in the browser on the first call']] },
  { id: 'any', tab: 'Any client', who: 'your client', lang: 'STANDARD mcpServers JSON',
    copy: JSON_COPY, pre: JSON_TEXT,
    steps: [['·', 'Streamable HTTP + OAuth 2.1 — SSE fallback at /sse for older clients']] },
];

// The five verbs, each wearing its node hue (§4) — the canonical block, compact.
const CAPS = [
  ['plant roadmaps', 'terracotta'],
  ['add & connect steps', 'olive'],
  ['color with your legend', 'gold'],
  ['mark progress', 'plum'],
  ['read your trees', 'sky'],
];

// The one dark well highlights just the URL (gold) and mutes comment lines — enough to read
// "code" without a full tokenizer.
function Snippet({ text }) {
  return text.split('\n').map((line, i) => {
    const key = `${i}`;
    if (line.trimStart().startsWith('#')) return <span key={key} className="wm-cn-cm">{line}{'\n'}</span>;
    const parts = line.split(MCP_URL);
    return (
      <span key={key}>
        {parts.map((part, j) => (
          <React.Fragment key={j}>
            {part}
            {j < parts.length - 1 && <span className="wm-cn-hl">{MCP_URL}</span>}
          </React.Fragment>
        ))}
        {'\n'}
      </span>
    );
  });
}

export function ConnectPage() {
  const { user, status } = useAuth();
  const signedIn = status === 'signed-in' && Boolean(user);
  const [active, setActive] = useState(1); // Claude Code
  const [copied, setCopied] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const client = CLIENTS[active];

  // Copy is the sign-in gate: connecting needs an account, so a signed-out Copy opens the
  // door instead of copying (§2). Signed in, it copies and flips to olive "Copied" for 1.4s.
  const onCopy = () => {
    if (!signedIn) { setSignInOpen(true); return; }
    try { navigator.clipboard?.writeText(client.copy); } catch { /* clipboard unavailable */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <>
      <AccountChrome>
        <style>{CSS}</style>

        <h1 style={title}>Connect your LLM tools</h1>
        <p style={sub}>Claude, Cursor, or Codex can plant and tend your roadmaps. Pick your tool, paste one snippet — your browser handles the rest.</p>

        <div className="wm-cn-tabs">
          {CLIENTS.map((c, i) => (
            <button key={c.id} type="button" className={`wm-cn-tab${i === active ? ' on' : ''}`}
              onClick={() => { setActive(i); setCopied(false); }}>
              {c.tab}
            </button>
          ))}
        </div>

        <div className="wm-cn-well">
          <div className="wm-cn-wellhead">
            <span className="wm-cn-lang">{client.lang}</span>
            <button type="button" className={`wm-cn-copy${copied ? ' ok' : ''}`} onClick={onCopy}>
              {copied ? 'Copied' : (client.copyLbl || 'Copy')}
            </button>
          </div>
          <pre className="wm-cn-pre"><Snippet text={client.pre} /></pre>
        </div>

        <div style={steps}>
          {client.steps.map(([n, label]) => (
            <div key={n + label} style={step}>
              <i style={stepNum}>{n}</i><span>{label}</span>
            </div>
          ))}
        </div>

        <p style={promise}>First connect opens your browser to approve — no keys to paste.</p>

        <div style={{ marginTop: 12 }}>
          <span className="wm-cn-seat">
            <span className="wm-cn-breath" />
            Listening for a hello from <b style={{ marginLeft: -2 }}>{client.who}</b>…
          </span>
        </div>

        <div className="wm-cn-caps">
          <span className="wm-cn-capslabel">ONCE CONNECTED IT CAN</span>
          {CAPS.map(([label, kind]) => (
            <span key={label} className="wm-cn-chip">
              <i style={{ background: `var(--kind-${kind})` }} />{label}
            </span>
          ))}
        </div>

        <div style={adv}>
          <button type="button" style={advSummary} onClick={() => setAdvOpen((open) => !open)}>
            <span style={advCaret(advOpen)}>›</span>
            Advanced — static API key for clients without OAuth
          </button>
          {advOpen && (
            <div style={advBody}>
              <p style={advPara}>
                OAuth above is the way in — first connect opens your browser, no keys to paste. A static key is a
                fallback for clients that can't run that flow: a credential you paste yourself, so guard it like a password.
              </p>
              <McpKeyPanel signedIn={signedIn} onRequireSignIn={() => setSignInOpen(true)} />
              <a href="#/settings" style={advManage}>Manage your keys in Settings → API keys</a>
            </div>
          )}
        </div>
      </AccountChrome>

      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} onSend={requestMagicLink} />
    </>
  );
}

export default ConnectPage;

// ---- style ---------------------------------------------------------------

const title = { fontFamily: 'var(--font-display)', fontSize: '19px', fontWeight: 700, lineHeight: 1.25, margin: '4px 0 2px' };
const sub = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)', margin: '0 0 12px' };
const steps = { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 };
const step = { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.45 };
const stepNum = { fontStyle: 'normal', fontFamily: 'var(--font-mono)', fontSize: '9.5px', color: 'var(--accent-terracotta-500)', fontWeight: 700, flex: 'none' };
const promise = { fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '11px 2px 0' };

const adv = { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' };
const advSummary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'none', padding: 0, cursor: 'pointer',
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-tertiary)',
};
const advCaret = (open) => ({
  display: 'inline-block', fontSize: '13px', lineHeight: 1, transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
  transition: 'transform 150ms var(--ease-standard)',
});
const advBody = { marginTop: 8 };
const advPara = { fontSize: 'var(--text-xs)', lineHeight: 1.55, color: 'var(--text-secondary)', margin: '0 0 6px' };
const advManage = { display: 'inline-block', marginTop: 12, fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-link)', textDecoration: 'none' };

const CSS = `
  .wm-cn-tabs { display:flex; gap:3px; background:var(--surface-canvas); border-radius:var(--radius-full); padding:3px; margin-bottom:10px; }
  .wm-cn-tab { flex:1; text-align:center; font-family:var(--font-body); font-size:10.5px; font-weight:700; color:var(--text-tertiary);
               border:none; background:none; border-radius:var(--radius-full); padding:6px 2px; cursor:pointer; white-space:nowrap;
               transition:background 150ms var(--ease-standard), color 150ms var(--ease-standard); }
  .wm-cn-tab:hover { color:var(--text-primary); }
  .wm-cn-tab.on { background:var(--neutral-0); color:var(--text-primary); font-weight:800; box-shadow:var(--shadow-xs); }

  .wm-cn-well { background:var(--neutral-900); border-radius:var(--radius-md); overflow:hidden; }
  .wm-cn-wellhead { display:flex; align-items:center; padding:8px 8px 0 12px; }
  .wm-cn-lang { flex:1; font-family:var(--font-mono); font-size:9px; font-weight:700; letter-spacing:.07em; color:var(--neutral-500); }
  .wm-cn-copy { font-family:var(--font-body); font-size:10px; font-weight:800; color:var(--neutral-50);
                background:rgba(244,238,223,.12); border:none; border-radius:var(--radius-full); padding:5px 13px; cursor:pointer;
                transition:background 150ms var(--ease-standard), color 150ms var(--ease-standard); }
  .wm-cn-copy:hover { background:rgba(244,238,223,.22); }
  .wm-cn-copy.ok { background:var(--accent-olive-500); color:#fff; }
  .wm-cn-pre { margin:0; padding:9px 12px 12px; font-family:var(--font-mono); font-size:11px; line-height:1.65;
               color:#F4EEDF; white-space:pre-wrap; word-break:break-all; }
  .wm-cn-cm { color:var(--neutral-500); }
  .wm-cn-hl { color:var(--accent-gold-400); }

  .wm-cn-seat { display:inline-flex; align-items:center; gap:8px; font-size:11px; font-weight:700; border-radius:var(--radius-full);
                padding:6px 13px 6px 11px; background:var(--accent-gold-50); color:var(--accent-gold-600); }
  .wm-cn-seat b { color:var(--accent-gold-600); }
  .wm-cn-breath { width:7px; height:7px; border-radius:var(--radius-full); background:currentColor; flex:none;
                  animation:wm-cn-breath 2400ms var(--ease-glow) infinite; }
  @keyframes wm-cn-breath { 0%,100% { opacity:.35; } 50% { opacity:1; } }

  .wm-cn-caps { display:flex; flex-wrap:wrap; gap:5px 6px; margin-top:14px; padding-top:12px; border-top:1px solid var(--border-subtle); }
  .wm-cn-capslabel { flex-basis:100%; font-size:9px; font-weight:800; letter-spacing:.06em; color:var(--text-tertiary); margin-bottom:1px; }
  .wm-cn-chip { display:inline-flex; align-items:center; gap:6px; font-size:10px; font-weight:700; color:var(--text-secondary);
                background:var(--surface-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-full); padding:4px 11px 4px 8px; }
  .wm-cn-chip i { width:8px; height:8px; border-radius:var(--radius-full); flex:none; }

  @media (prefers-reduced-motion: reduce) { .wm-cn-breath { animation:none; opacity:.7; } }
`;
