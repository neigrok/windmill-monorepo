// Revoking the current session signs this tab out and returns it home.

import React, { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { listSessions, revokeSession, signOutEverywhere } from '../auth/AccountClient.js';
import { Button } from '../../design-system';
import { Section, styles, QuietX } from './Section.jsx';
import { formatUserAgent, relativeTime } from './format.js';

export function SessionsSection() {
  const { signOut } = useAuth();
  const [sessions, setSessions] = useState(null); // null while loading
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0); // bump to re-run the load after a failure

  useEffect(() => {
    let alive = true;
    listSessions()
      .then((rows) => { if (alive) setSessions(rows); })
      .catch(() => { if (alive) { setSessions([]); setFailed(true); } });
    return () => { alive = false; };
  }, [attempt]);

  const retry = () => { setSessions(null); setFailed(false); setAttempt((n) => n + 1); };

  const revoke = async (session) => {
    try {
      await revokeSession(session.id);
    } catch { /* already gone or unreachable */ }
    if (session.current) {
      await signOut();
      window.location.hash = '#/';
      return;
    }
    setSessions((rows) => rows.filter((row) => row.id !== session.id));
  };

  const signOutOthers = async () => {
    try {
      await signOutEverywhere();
      setSessions((rows) => rows.filter((row) => row.current));
    } catch { /* unreachable */ }
  };

  const others = (sessions ?? []).some((session) => !session.current);

  return (
    <Section title="Sessions & devices">
      {sessions === null && <p style={styles.calmLine}>Loading your sessions…</p>}

      {sessions !== null && sessions.length === 0 && (
        <p style={styles.calmLine}>
          {failed ? (
            <>
              Couldn't load your sessions just now.{' '}
              <button type="button" onClick={retry} style={retryButton}>Try again</button>
            </>
          ) : 'No other sessions.'}
        </p>
      )}

      {sessions?.map((session) => (
        <div key={session.id} style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.primaryText}>{formatUserAgent(session.userAgent)}</div>
            <div style={styles.metaText}>{relativeTime(session.lastSeenMs) || 'Active'}</div>
          </div>
          {session.current && <span style={styles.tag}>THIS DEVICE</span>}
          <QuietX label={`Revoke ${formatUserAgent(session.userAgent)}`} onClick={() => revoke(session)} />
        </div>
      ))}

      {others && (
        <div style={{ marginTop: 12 }}>
          <Button variant="ghost" size="sm" onClick={signOutOthers}>Sign out everywhere</Button>
        </div>
      )}
    </Section>
  );
}

export default SessionsSection;

const retryButton = {
  background: 'none', border: 'none', padding: 0, font: 'inherit',
  color: 'var(--text-secondary)', cursor: 'pointer',
  textDecoration: 'underline', textUnderlineOffset: '2px',
};
