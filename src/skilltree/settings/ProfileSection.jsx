// Settings §01 · Profile. The monogram bloom (same as the seat), the one editable
// identity field (name), the read-only email (the account key), and how you sign in.
// Saving writes PATCH /v1/me then pulls useAuth().refresh() so the seat and every other
// tab see the new name. No photo upload in v1; the Google slot is ghosted until the
// provider lands.

import React, { useState } from 'react';
import { Avatar, Button, Input } from '../../components';
import { useAuth } from '../auth/AuthProvider.jsx';
import { updateProfile } from '../auth/AccountClient.js';
import { Section, styles } from './Section.jsx';

export function ProfileSection() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user.name ?? '');
  const [phase, setPhase] = useState('idle'); // idle | saving | saved | error
  const [error, setError] = useState(null);

  const trimmed = name.trim();
  const dirty = trimmed !== (user.name ?? '').trim();
  const canSave = dirty && trimmed !== '' && phase !== 'saving';
  const displayName = user.name?.trim() || user.email;

  const save = async () => {
    if (!canSave) return;
    setPhase('saving');
    setError(null);
    try {
      await updateProfile({ name: trimmed });
      await refresh();
      setPhase('saved');
    } catch (err) {
      setPhase('error');
      setError(err?.code === 'invalid' ? 'That name was not accepted.' : "Couldn't save just now — try again.");
    }
  };

  return (
    <Section title="Profile">
      <div style={identity}>
        <Avatar name={displayName} size={48} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={styles.fieldLabel}>Name</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <Input
                value={name}
                placeholder="Your name"
                onChange={(e) => { setName(e.target.value); if (phase !== 'idle') { setPhase('idle'); setError(null); } }}
              />
            </div>
            <Button variant="secondary" size="sm" disabled={!canSave} onClick={save}>
              {phase === 'saving' ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {phase === 'saved' && <p style={{ ...styles.metaText, color: 'var(--accent-olive-600)' }}>Saved.</p>}
          {phase === 'error' && <p style={{ ...styles.metaText, color: 'var(--color-danger)' }}>{error}</p>}
        </div>
      </div>

      <div style={block}>
        <p style={styles.fieldLabel}>Email</p>
        <p style={styles.readonly}>{user.email}</p>
      </div>

      <div style={block}>
        <p style={styles.fieldLabel}>How you sign in</p>
        <p style={styles.readonly}>Magic link to {user.email}</p>
        <p style={{ ...styles.metaText, marginTop: 4 }}>Continue with Google — coming soon.</p>
      </div>
    </Section>
  );
}

export default ProfileSection;

const identity = { display: 'flex', gap: 14, alignItems: 'flex-start' };
const block = { marginTop: 14 };
