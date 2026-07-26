// Settings §04 · Your data. Export and delete together, no danger-zone theater. Export
// zips one Markdown file per tree in F3's grammar — the same format the composer pastes
// back, so it round-trips. Delete expands in place and states the deal plainly; the
// confirmation is typing your own email (which catches the wrong-account case that
// "type DELETE" never does). Its button is the one brick in all of settings. On success
// the account enters its 30-day grace, this tab signs out, and the closing chip shows
// on the way home — the undo is simply signing back in before the date.

import React, { useState } from 'react';
import { Button, Input } from '../../../design-system';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { closeAccount } from '../../../shell/auth/AccountClient.js';
import { buildExportArchive } from './buildExportArchive.js';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { shortDate } from '../../../shell/settings/format.js';

const DEAL = [
  'Your account closes in 30 days.',
  'Synced copies and share links go.',
  'Trees on your devices stay.',
  'Export your Markdown archive first — it stays yours.',
];

export function YourDataSection() {
  const { user, signOut } = useAuth();
  const [exportPhase, setExportPhase] = useState('idle'); // idle | working | done | error
  const [exportNote, setExportNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [closing, setClosing] = useState(null); // { date } after the account is closed
  const [deleteError, setDeleteError] = useState(null);

  const runExport = async () => {
    setExportPhase('working');
    setExportNote('');
    try {
      const { count } = await buildExportArchive();
      setExportPhase('done');
      setExportNote(count === 0 ? 'No roadmaps to export yet.' : `Exported ${count} roadmap${count === 1 ? '' : 's'}.`);
    } catch {
      setExportPhase('error');
      setExportNote("Couldn't build your export just now — try again.");
    }
  };

  const emailMatches = confirmEmail.trim().toLowerCase() === user.email.toLowerCase();

  const confirmDelete = async () => {
    if (!emailMatches || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await closeAccount();
      setClosing({ date: shortDate(Date.parse(result.closingOn)) });
      await signOut();
      setTimeout(() => { window.location.hash = '#/'; }, 1800);
    } catch {
      setDeleting(false);
      setDeleteError("Couldn't close your account just now — try again.");
    }
  };

  if (closing) {
    return (
      <Section title="Your data">
        <p style={{ ...styles.primaryText, whiteSpace: 'normal' }}>Account closing · {closing.date}</p>
        <p style={{ ...styles.calmLine, marginTop: 4 }}>Sign in any time before then to undo.</p>
      </Section>
    );
  }

  return (
    <Section title="Your data">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" disabled={exportPhase === 'working'} onClick={runExport}>
          {exportPhase === 'working' ? 'Preparing…' : 'Export my trees'}
        </Button>
        <span style={styles.calmLine}>A .zip of Markdown — one file per tree. Paste any of them back to replant it.</span>
      </div>
      {exportNote && (
        <p style={{ ...styles.metaText, color: exportPhase === 'error' ? 'var(--color-danger)' : 'var(--accent-olive-600)', marginTop: 6 }}>
          {exportNote}
        </p>
      )}

      <div style={deleteBlock}>
        {!expanded ? (
          <button type="button" style={deleteRow} onClick={() => setExpanded(true)}>Delete account</button>
        ) : (
          <div style={deleteOpen}>
            <ul style={dealList}>
              {DEAL.map((line) => <li key={line} style={dealItem}>{line}</li>)}
            </ul>
            <p style={styles.fieldLabel}>Type your email to confirm</p>
            <div style={{ maxWidth: 280 }}>
              <Input
                type="email"
                value={confirmEmail}
                placeholder={user.email}
                onChange={(e) => { setConfirmEmail(e.target.value); if (deleteError) setDeleteError(null); }}
              />
            </div>
            {deleteError && <p style={{ ...styles.metaText, color: 'var(--color-danger)' }}>{deleteError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Button variant="danger" size="sm" disabled={!emailMatches || deleting} onClick={confirmDelete}>
                {deleting ? 'Closing…' : 'Delete account'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setExpanded(false); setConfirmEmail(''); setDeleteError(null); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

export default YourDataSection;

const deleteBlock = { borderTop: '1px solid var(--border-subtle)', marginTop: 16, paddingTop: 14 };
const deleteRow = {
  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-secondary)',
};
const deleteOpen = { display: 'flex', flexDirection: 'column' };
const dealList = { margin: '0 0 12px', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 };
const dealItem = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)' };
