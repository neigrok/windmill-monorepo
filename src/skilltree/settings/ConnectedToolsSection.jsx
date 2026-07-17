// Settings §02 · Connected tools (F17's connections list). The LLM grants this account
// has handed out — a list separate from browser sessions with a revoke all its own, so
// pulling a tool's key never signs a device out. One row per client: a monogram, its
// name, when it was granted and when it last acted. Disconnect asks once, acts
// immediately, and toasts quietly. A dashed row leads to /connect; an empty account gets
// a calm line and the same door.

import React, { useEffect, useState } from 'react';
import { Avatar, Button, Toast } from '../../components';
import { listGrants, revokeGrant } from '../auth/OAuthClient.js';
import { Section, styles } from './Section.jsx';
import { relativeTime, shortDate } from './format.js';

export function ConnectedToolsSection() {
  const [grants, setGrants] = useState(null); // null while loading
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(null); // clientId mid-confirm
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let alive = true;
    listGrants()
      .then((rows) => { if (alive) setGrants(rows); })
      .catch(() => { if (alive) { setGrants([]); setFailed(true); } });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const disconnect = async (grant) => {
    setConfirming(null);
    try {
      await revokeGrant(grant.clientId);
      setGrants((rows) => rows.filter((row) => row.clientId !== grant.clientId));
      setToast(`${grant.name} disconnected.`);
    } catch {
      setToast(`Couldn't disconnect ${grant.name} just now.`);
    }
  };

  return (
    <Section title="Connected tools">
      {grants === null && <p style={styles.calmLine}>Loading your connections…</p>}

      {grants !== null && grants.length === 0 && (
        <p style={styles.calmLine}>
          {failed ? "Couldn't load your connections just now." : 'No tools connected yet.'}
        </p>
      )}

      {grants?.map((grant) => (
        <div key={grant.clientId} style={styles.row}>
          <Avatar name={grant.name} size={30} />
          <div style={styles.rowMain}>
            <div style={styles.primaryText}>{grant.name}</div>
            <div style={styles.metaText}>
              Granted {shortDate(grant.grantedMs)}
              {grant.lastUsedMs ? ` · Last active ${relativeTime(grant.lastUsedMs)}` : ''}
            </div>
          </div>
          {confirming === grant.clientId ? (
            <div style={confirm}>
              <span style={confirmCopy}>{grant.name} will lose access now.</span>
              <Button variant="secondary" size="sm" onClick={() => disconnect(grant)}>Disconnect</Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(grant.clientId)}>Disconnect</Button>
          )}
        </div>
      ))}

      <a href="#/connect" style={styles.dashedRow}>+ Connect another tool</a>

      {toast && (
        <div style={toastDock}>
          <Toast tone="info" onClose={() => setToast(null)}>{toast}</Toast>
        </div>
      )}
    </Section>
  );
}

export default ConnectedToolsSection;

const confirm = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' };
const confirmCopy = { fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' };
const toastDock = { position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 120 };
