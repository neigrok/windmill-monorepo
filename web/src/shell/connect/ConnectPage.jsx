import React, { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useSignInDoor } from '../auth/SignInDoor.jsx';
import { AccountChrome } from '../account/AccountChrome.jsx';
import { McpKeyPanel } from './McpKeyPanel.jsx';
import { homeHash } from '../products.js';

const MCP_URL = 'https://windmill.works/mcp';
const JSON_TEXT = `{\n  "mcpServers": {\n    "windmill": { "url": "${MCP_URL}" }\n  }\n}`;
const CLIENTS = [
  {
    id: 'chatgpt', name: 'ChatGPT', title: 'ChatGPT · OpenAI', label: 'Server URL', copy: MCP_URL,
    steps: [
      'In ChatGPT, open Settings → Security and login and enable Developer mode.',
      'Open Plugins and use the plus button to create a connection. Enter the settings above and a description, such as “Use Windmill from ChatGPT”.',
      'Choose OAuth, then approve access to Windmill when prompted.',
      'In a conversation, open the + menu → Developer mode and select Windmill.',
    ],
  },
  {
    id: 'desktop', name: 'Claude Desktop', label: 'Connector URL', copy: MCP_URL,
    steps: ['Open Settings → Connectors.', 'Add a custom connector named Windmill and paste the URL.', 'Approve access in the browser when prompted.'],
  },
  {
    id: 'code', name: 'Claude Code', label: 'Terminal',
    copy: `claude mcp add --transport http windmill ${MCP_URL}`,
    steps: ['Run this command in your terminal.', 'Approve access in the browser on first use.'],
  },
  {
    id: 'cursor', name: 'Cursor', label: '~/.cursor/mcp.json', copy: JSON_TEXT,
    steps: ['Save this configuration, then enable Windmill under Cursor settings → MCP.', 'Approve access in the browser tab Cursor opens.'],
  },
  {
    id: 'codex', name: 'Codex', label: '~/.codex/config.toml',
    copy: `[mcp_servers.windmill]\nurl = "${MCP_URL}"`,
    steps: ['Add this configuration to config.toml and restart Codex.', 'Approve access in the browser on the first call.'],
  },
  {
    id: 'any', name: 'Any client', label: 'mcpServers JSON', copy: JSON_TEXT,
    steps: ['Use a client that supports Streamable HTTP and OAuth 2.1.', 'Add this server configuration and approve access when prompted.'],
    note: 'The endpoint uses Streamable HTTP, not SSE. A GET request returns 405.',
  },
];

export function ConnectPage({ inShell = false }) {
  const { user, status } = useAuth();
  const signedIn = status === 'signed-in' && Boolean(user);
  const openSignInDoor = useSignInDoor();
  const [active, setActive] = useState('chatgpt');
  const [copyStatus, setCopyStatus] = useState('idle');
  const [advOpen, setAdvOpen] = useState(false);
  const copyRequest = useRef(0);
  const id = useId();
  const client = CLIENTS.find((item) => item.id === active);
  const isChatGPT = active === 'chatgpt';
  const isUrl = client.copy === MCP_URL;

  useEffect(() => {
    if (copyStatus !== 'copied') return undefined;
    const timer = setTimeout(() => setCopyStatus('idle'), 1400);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  useEffect(() => () => { copyRequest.current += 1; }, []);

  const onCopy = async () => {
    if (!signedIn) { openSignInDoor(); return; }
    const request = ++copyRequest.current;
    setCopyStatus('pending');
    try {
      await navigator.clipboard.writeText(client.copy);
      if (request === copyRequest.current) setCopyStatus('copied');
    } catch {
      if (request === copyRequest.current) setCopyStatus('failed');
    }
  };

  return (
    <AccountChrome width={560} backHash={homeHash()} bare={inShell}>
      <style>{CSS}</style>
      <div className="wm-cn">
        <h1>Connect your LLM tools</h1>
        <p className="wm-cn-intro">Use your AI tools with Windmill.</p>

        <fieldset className="wm-cn-tools">
          <legend>Choose tool</legend>
          <div className="wm-cn-options">
            {CLIENTS.map((item) => (
              <label key={item.id} className="wm-cn-option">
                <input type="radio" name={`${id}-tool`} value={item.id} checked={item.id === active}
                  onChange={() => { copyRequest.current += 1; setActive(item.id); setCopyStatus('idle'); }} />
                <span>{item.name}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <section className="wm-cn-setup" aria-labelledby={`${id}-setup`}>
          <h2 id={`${id}-setup`}>{client.title || client.name}</h2>
          {isChatGPT && (
            <dl className="wm-cn-settings">
              <div><dt>Name</dt><dd>Windmill</dd></div>
              <div><dt>Authentication</dt><dd>OAuth</dd></div>
            </dl>
          )}
          <div className="wm-cn-well">
            <div className="wm-cn-wellhead">
              <span className="wm-cn-lang">{client.label}</span>
              <button type="button" className="wm-cn-copy" disabled={copyStatus === 'pending'} onClick={onCopy}>
                {copyStatus === 'copied' ? 'Copied' : copyStatus === 'pending' ? 'Copying…' : isUrl ? 'Copy URL' : 'Copy'}
              </button>
            </div>
            <pre className="wm-cn-pre"><code>{client.copy}</code></pre>
          </div>
          <p className="wm-cn-feedback" role="status" aria-live="polite">
            {copyStatus === 'copied' ? 'Copied to clipboard.' : copyStatus === 'failed' ? 'Couldn’t copy. Select the text above and copy it manually.' : ''}
          </p>
          <ol className="wm-cn-steps">{client.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          {isChatGPT ? (
            <p className="wm-cn-note">
              Availability depends on your ChatGPT account and workspace settings.{' '}
              <a href="https://developers.openai.com/plugins/deploy/connect-chatgpt" target="_blank" rel="noreferrer">OpenAI setup guide ↗</a>
            </p>
          ) : <p className="wm-cn-note">{client.note || 'OAuth opens your browser to approve access. No API key to paste.'}</p>}
        </section>

        <div className="wm-cn-advanced">
          <button type="button" className="wm-cn-summary" aria-expanded={advOpen} aria-controls={`${id}-keys`}
            onClick={() => setAdvOpen((open) => !open)}>
            <span aria-hidden="true">{advOpen ? '−' : '+'}</span> API keys
            <span className="wm-cn-fallback">For clients without OAuth</span>
          </button>
          <div id={`${id}-keys`} hidden={!advOpen}>
            {advOpen && <>
              <p className="wm-cn-note">Use a Windmill API key only if your client cannot use OAuth. Keep it private, like a password.</p>
              <McpKeyPanel signedIn={signedIn} onRequireSignIn={openSignInDoor} />
              <a className="wm-cn-manage" href="#/settings">Manage keys in Settings → API keys</a>
            </>}
          </div>
        </div>
      </div>
    </AccountChrome>
  );
}

export default ConnectPage;

const CSS = `
  .wm-cn { font-size:13px; line-height:1.55; }
  .wm-cn h1 { font-family:var(--font-display); font-size:24px; line-height:1.2; margin:14px 0 6px; }
  .wm-cn h2 { font-size:15px; line-height:1.4; margin:0 0 12px; }
  .wm-cn-intro { color:var(--text-secondary); margin:0 0 20px; }
  .wm-cn a { color:var(--text-link); text-underline-offset:3px; }
  .wm-cn-tools { border:0; padding:0; margin:0 0 22px; min-width:0; }
  .wm-cn-tools legend { font-size:12px; font-weight:800; color:var(--text-secondary); margin-bottom:8px; }
  .wm-cn-options { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px; }
  .wm-cn-option { position:relative; cursor:pointer; min-width:0; }
  .wm-cn-option input { position:absolute; opacity:0; width:1px; height:1px; }
  .wm-cn-option span { min-height:44px; box-sizing:border-box; display:flex; justify-content:center; align-items:center;
    padding:7px 8px; text-align:center; font-size:12px; font-weight:700; border:1px solid var(--border-subtle);
    border-radius:var(--radius-full); background:var(--surface-canvas); color:var(--text-secondary);
    transition:background 150ms var(--ease-standard), border-color 150ms var(--ease-standard); }
  .wm-cn-option:hover span { color:var(--text-primary); border-color:var(--text-tertiary); }
  .wm-cn-option input:checked + span { background:var(--surface-card); color:var(--text-primary); border-color:var(--text-primary); }
  .wm-cn-option input:focus-visible + span, .wm-cn button:focus-visible, .wm-cn a:focus-visible {
    outline:2px solid var(--text-link); outline-offset:3px; }
  .wm-cn-settings { display:flex; flex-wrap:wrap; gap:12px 36px; margin:0 0 12px; }
  .wm-cn-settings div { display:flex; gap:8px; }
  .wm-cn-settings dt { color:var(--text-secondary); }
  .wm-cn-settings dd { margin:0; font-weight:700; }
  .wm-cn-well { background:var(--neutral-900); border-radius:var(--radius-md); overflow:hidden; }
  .wm-cn-wellhead { display:flex; gap:8px; align-items:center; padding:6px 8px 0 14px; }
  .wm-cn-lang { flex:1; overflow-wrap:anywhere; font-family:var(--font-mono); font-size:11px; color:var(--neutral-300); }
  .wm-cn-copy { flex:none; font-family:var(--font-body); font-size:12px; font-weight:800; color:var(--neutral-50);
    background:color-mix(in srgb, var(--neutral-50) 12%, transparent); border:0; border-radius:var(--radius-full);
    min-height:44px; padding:6px 14px; cursor:pointer; }
  .wm-cn-copy:hover { background:color-mix(in srgb, var(--neutral-50) 22%, transparent); }
  .wm-cn-copy:disabled { cursor:wait; opacity:.7; }
  .wm-cn-pre { margin:0; padding:10px 14px 16px; font-family:var(--font-mono); font-size:12px; line-height:1.65;
    color:var(--neutral-50); white-space:pre-wrap; overflow-wrap:anywhere; }
  .wm-cn-pre code { font:inherit; }
  .wm-cn-feedback { font-size:12px; color:var(--text-secondary); margin:6px 0 0; }
  .wm-cn-feedback:empty { margin:0; }
  .wm-cn-steps { padding-left:24px; margin:16px 0; color:var(--text-secondary); }
  .wm-cn-steps li { padding-left:3px; margin-bottom:10px; }
  .wm-cn-steps li::marker { color:var(--text-primary); font-weight:800; }
  .wm-cn-note { color:var(--text-secondary); font-size:12px; margin:12px 0; }
  .wm-cn-advanced { border-top:1px solid var(--border-subtle); margin-top:22px; padding-top:8px; }
  .wm-cn-summary { display:flex; align-items:center; flex-wrap:wrap; gap:8px; width:100%; min-height:44px; border:0; padding:8px 0;
    background:none; color:var(--text-primary); font:inherit; font-weight:800; text-align:left; cursor:pointer; }
  .wm-cn-fallback { margin-left:auto; font-size:12px; font-weight:400; color:var(--text-tertiary); }
  .wm-cn-manage { display:inline-block; margin-top:12px; font-size:12px; }
  @media (max-width:380px) { .wm-cn-options { grid-template-columns:repeat(2, minmax(0, 1fr)); } }
  @media (prefers-reduced-motion:reduce) { .wm-cn-option span { transition:none; } }
`;
