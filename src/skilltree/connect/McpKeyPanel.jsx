// The mint-and-reveal panel for a personal MCP key — the one credential surface, shared by
// the connect page's Advanced disclosure and settings' API keys section. A named form mints
// a static bearer; once minted the form gives way to a one-time reveal, because the server
// keeps only the token's hash and this is the only moment it exists in the clear. The reveal
// well is token-driven, not literal hex, so it reads as a dark code well in light mode and a
// readable light well under [data-theme="dark"] — it survives both mounts and both themes.

import React, { useEffect, useRef, useState } from 'react';
import { Button, Input } from '../../components';
import { createMcpKey } from '../auth/McpKeyClient.js';

const MCP_URL = 'https://windmill.works/mcp';

export function McpKeyPanel({ signedIn, onRequireSignIn, onMinted, compact = false }) {
  const [name, setName] = useState('');
  const [minted, setMinted] = useState(null); // { id, name, token, createdMs } after a mint
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copiedTimer = useRef(null);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const generate = async () => {
    if (!signedIn) { onRequireSignIn?.(); return; }
    setBusy(true);
    setError(null);
    try {
      const key = await createMcpKey(name.trim() || undefined);
      setMinted(key);
      onMinted?.();
    } catch (e) {
      if (e?.status === 401) {
        if (onRequireSignIn) onRequireSignIn();
        else setError('Your session expired — refresh and sign in to create a key.');
        return;
      }
      setError("Couldn't generate a key just now — try again.");
    } finally {
      setBusy(false);
    }
  };

  const header = minted ? `Authorization: Bearer ${minted.token}` : '';

  const copy = async () => {
    if (!(await copyText(header))) {
      setCopyFailed(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopyFailed(false), 2500);
      return;
    }
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const done = () => {
    setMinted(null);
    setName('');
    setError(null);
    setCopied(false);
    setCopyFailed(false);
  };

  if (minted) {
    return (
      <div style={{ marginTop: compact ? 0 : 10 }}>
        <p style={honesty}>This is shown once. Treat it like a password — store it now, you won't see it again.</p>

        <div style={well}>
          <div style={wellHead}>
            <span style={wellLang}>{minted.name ? `AUTHORIZATION HEADER · ${minted.name}` : 'AUTHORIZATION HEADER'}</span>
            <button type="button" style={copied ? copyBtnOk : copyBtn} onClick={copy}>
              {copied ? 'Copied' : copyFailed ? 'Press ⌘C' : 'Copy'}
            </button>
          </div>
          <pre style={wellPre}>{header}</pre>
        </div>

        <p style={usage}>Point your client at {MCP_URL} and send this header — no browser round-trip.</p>

        <div style={{ marginTop: 10 }}>
          <Button variant="ghost" size="sm" onClick={done}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: compact ? 0 : 10 }}>
      <div style={{ maxWidth: 320 }}>
        <Input
          label="Name this key"
          placeholder="Codex on my laptop"
          value={name}
          onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
        />
      </div>
      <div style={{ marginTop: 10 }}>
        <Button variant="secondary" size="sm" disabled={busy} onClick={generate}>
          {busy ? 'Generating…' : 'Generate key'}
        </Button>
      </div>
      {error && <p style={errorLine}>{error}</p>}
    </div>
  );
}

export default McpKeyPanel;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    area.remove();
    return copied;
  }
}

const honesty = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)', margin: '0 0 8px' };
const usage = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-tertiary)', margin: '8px 2px 0', wordBreak: 'break-word' };
const errorLine = { fontSize: 'var(--text-xs)', color: 'var(--color-danger)', margin: '8px 0 0' };

// The well reads its colors from the neutral ramp, which is re-authored (not inverted) per
// theme: neutral-900 is dark ink in light mode and warm cream in dark, neutral-0 the reverse
// — so bg/text stay in contrast in both, a dark well by day and a light one by night.
const well = { background: 'var(--neutral-900)', borderRadius: 'var(--radius-md)', overflow: 'hidden' };
const wellHead = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px 0 12px' };
const wellLang = { flex: 1, fontFamily: 'var(--font-mono)', fontSize: '9px', fontWeight: 700, letterSpacing: '.07em', color: 'var(--neutral-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const copyBtn = {
  fontFamily: 'var(--font-body)', fontSize: '10px', fontWeight: 800, color: 'var(--neutral-0)',
  background: 'transparent', border: '1px solid var(--neutral-500)', borderRadius: 'var(--radius-full)',
  padding: '5px 13px', cursor: 'pointer', flex: 'none',
};
const copyBtnOk = { ...copyBtn, background: 'var(--accent-olive-500)', borderColor: 'var(--accent-olive-500)' };
const wellPre = {
  margin: 0, padding: '9px 12px 12px', fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: 1.65,
  color: 'var(--neutral-0)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
};
