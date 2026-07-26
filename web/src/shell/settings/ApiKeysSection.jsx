// Settings §API keys. The static MCP bearers this account has minted — a credential list
// sibling to Connected tools, for clients that can't run the OAuth flow. One row per key:
// its name, when it was minted and when it last authenticated. Minting reveals a token once
// (the shared McpKeyPanel) and refreshes the list; revoking is a two-step confirm and a
// quiet toast, because a static bearer is sensitive — the key stops working the moment it
// goes. An empty account gets a calm line and the same create door.

import React, { useEffect, useState } from 'react';
import { Button, Toast } from '../../design-system';
import { listMcpKeys, revokeMcpKey } from '../auth/McpKeyClient.js';
import { McpKeyPanel } from '../connect/McpKeyPanel.jsx';
import { Section, styles } from './Section.jsx';
import { mcpKeyMeta } from './format.js';

export function ApiKeysSection() {
  const [keys, setKeys] = useState(null); // null while loading
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0); // bump to re-run the load
  const [confirming, setConfirming] = useState(null); // key id mid-confirm
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let alive = true;
    listMcpKeys()
      .then((rows) => { if (alive) setKeys(rows); })
      .catch(() => { if (alive) { setKeys([]); setFailed(true); } });
    return () => { alive = false; };
  }, [attempt]);

  const retry = () => { setKeys(null); setFailed(false); setAttempt((n) => n + 1); };
  const reload = () => setAttempt((n) => n + 1);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const revoke = async (key) => {
    setConfirming(null);
    const label = key.name ? `"${key.name}"` : 'Key';
    try {
      await revokeMcpKey(key.id);
      setKeys((rows) => rows.filter((row) => row.id !== key.id));
      setToast(`${label} revoked.`);
    } catch {
      setToast(`Couldn't revoke ${key.name ? `"${key.name}"` : 'that key'} just now.`);
    }
  };

  return (
    <Section title="API keys">
      {keys === null && <p style={styles.calmLine}>Loading your API keys…</p>}

      {keys !== null && keys.length === 0 && (
        <p style={styles.calmLine}>
          {failed ? (
            <>
              Couldn't load your API keys just now.{' '}
              <button type="button" onClick={retry} style={retryButton}>Try again</button>
            </>
          ) : 'No API keys yet.'}
        </p>
      )}

      {keys?.map((key) => (
        <div key={key.id} style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.primaryText}>{key.name || 'Unnamed key'}</div>
            <div style={styles.metaText}>{mcpKeyMeta(key)}</div>
          </div>
          {confirming === key.id ? (
            <div style={confirm}>
              <span style={confirmCopy}>This key will stop working now.</span>
              <Button variant="secondary" size="sm" onClick={() => revoke(key)}>Revoke</Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(key.id)}>Revoke</Button>
          )}
        </div>
      ))}

      {creating ? (
        <div style={{ marginTop: 12 }}>
          <McpKeyPanel signedIn onRequireSignIn={() => window.location.reload()} onMinted={reload} compact />
          <div style={{ marginTop: 10 }}>
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>Close</Button>
          </div>
        </div>
      ) : (
        <button type="button" style={styles.dashedRow} onClick={() => setCreating(true)}>+ Create a key</button>
      )}

      {toast && (
        <div style={toastDock}>
          <Toast tone="info" onClose={() => setToast(null)}>{toast}</Toast>
        </div>
      )}
    </Section>
  );
}

export default ApiKeysSection;

const confirm = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' };
const confirmCopy = { fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' };
const toastDock = { position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 120 };

const retryButton = {
  background: 'none', border: 'none', padding: 0, font: 'inherit',
  color: 'var(--text-secondary)', cursor: 'pointer',
  textDecoration: 'underline', textUnderlineOffset: '2px',
};
