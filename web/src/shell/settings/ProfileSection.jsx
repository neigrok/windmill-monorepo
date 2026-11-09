// Saving writes PATCH /v1/me then pulls useAuth().refresh() so the seat sees the new name.

import React, { useState } from 'react';
import { Avatar, Button, Input } from '../../design-system';
import { useAuth } from '../auth/AuthProvider.jsx';
import { updateProfile } from '../auth/AccountClient.js';
import { Section, styles } from './Section.jsx';
import { t } from '../i18n/settings/index.js';

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
      setError(err?.code === 'invalid' ? t('shell.profile.nameRefused') : t('shell.profile.saveFailed'));
    }
  };

  return (
    <Section title={t('shell.profile.title')}>
      <div style={identity}>
        <Avatar name={displayName} size={48} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={styles.fieldLabel}>{t('shell.profile.name')}</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <Input
                value={name}
                placeholder={t('shell.profile.namePlaceholder')}
                onChange={(e) => { setName(e.target.value); if (phase !== 'idle') { setPhase('idle'); setError(null); } }}
              />
            </div>
            <Button variant="secondary" size="sm" disabled={!canSave} onClick={save}>
              {phase === 'saving' ? t('shell.profile.saving') : t('shell.profile.save')}
            </Button>
          </div>
          {phase === 'saved' && <p style={{ ...styles.metaText, color: 'var(--accent-olive-600)' }}>{t('shell.profile.saved')}</p>}
          {phase === 'error' && <p style={{ ...styles.metaText, color: 'var(--color-danger)' }}>{error}</p>}
        </div>
      </div>

      <div style={block}>
        <p style={styles.fieldLabel}>{t('shell.profile.email')}</p>
        <p style={styles.readonly}>{user.email}</p>
      </div>

      <div style={block}>
        <p style={styles.fieldLabel}>{t('shell.profile.signInMethod')}</p>
        <p style={styles.readonly}>{t('shell.profile.magicLink', { email: user.email })}</p>
        <p style={{ ...styles.metaText, marginTop: 4 }}>{t('shell.profile.googleSoon')}</p>
      </div>
    </Section>
  );
}

export default ProfileSection;

const identity = { display: 'flex', gap: 14, alignItems: 'flex-start' };
const block = { marginTop: 14 };
