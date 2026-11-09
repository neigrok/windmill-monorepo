// An enable that cannot name an IANA zone is refused here: the server never marks a user due without one.

import React from 'react';
import { Switch } from '../../../design-system';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import {
  browserTimezone, describeSchedule, fetchReminders, reminderPatch, saveReminders,
} from '../reminders/remindersClient.js';
import { t } from '../i18n/index.js';

export function ReminderSection() {
  const [settings, setSettings] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [phase, setPhase] = React.useState('idle'); // idle | saving | saved | error
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let alive = true;
    fetchReminders().then((next) => {
      if (!alive) return;
      setSettings(next);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  // "Saved." is an acknowledgement, not a state: it clears itself.
  React.useEffect(() => {
    if (phase !== 'saved') return undefined;
    const settle = setTimeout(() => setPhase('idle'), 2400);
    return () => clearTimeout(settle);
  }, [phase]);

  // `armed` means a reminder could reach this inbox; `enabled` means this person asked for one.
  if (loading || !settings || !settings.armed) return null;

  const toggle = async (next) => {
    if (phase === 'saving') return;
    const patch = reminderPatch(next, browserTimezone());
    if (!patch) {
      setPhase('error');
      setError(t('roadmap.reminders.noTimezone'));
      return;
    }
    setPhase('saving');
    setError(null);
    const saved = await saveReminders(patch);
    if (!saved) {
      setPhase('error');
      setError(t('roadmap.reminders.saveFailed'));
      return;
    }
    // Only the server knows whether the enable lifted the suppression, so read it back.
    if (settings.suppressed) {
      const fresh = await fetchReminders();
      setSettings(fresh ?? { ...settings, enabled: next, timezone: patch.timezone ?? settings.timezone });
      setPhase('saved');
      return;
    }
    setSettings({ ...settings, enabled: next, timezone: patch.timezone ?? settings.timezone });
    setPhase('saved');
  };

  // Turning reminders back on is what clears suppression; nothing here retries on its own.
  if (settings.suppressed) {
    return (
      <Section title={t('roadmap.reminders.title')}>
        <div style={{ padding: '2px 0 4px' }}>
          <p style={{ ...styles.primaryText, whiteSpace: 'normal' }}>
            {t('roadmap.reminders.suppressedTitle')}
          </p>
          <p style={{ ...styles.metaText, marginTop: 8 }}>
            {t('roadmap.reminders.suppressedWhy')}
          </p>
          <p style={styles.metaText}>
            {t('roadmap.reminders.suppressedSignIn')}
          </p>
          <p style={styles.metaText}>
            {t('roadmap.reminders.suppressedNoRetry')}
          </p>
          <button type="button" style={styles.dashedRow} onClick={() => toggle(true)}
                  disabled={phase === 'saving'}>
            {t('roadmap.reminders.turnBackOn')}
          </button>
          {phase === 'saving' && <p style={styles.metaText}>{t('roadmap.reminders.saving')}</p>}
          {phase === 'error' && <p style={{ ...styles.metaText, color: 'var(--color-danger)' }}>{error}</p>}
        </div>
      </Section>
    );
  }

  return (
    <Section title={t('roadmap.reminders.title')}>
      <div style={{ padding: '2px 0 4px' }}>
        <Switch checked={settings.enabled} onChange={toggle} label={t('roadmap.reminders.weekly')} />

        <p style={{ ...styles.metaText, marginTop: 8 }}>
          {t('roadmap.reminders.when', { schedule: describeSchedule(settings) })}
        </p>

        <p style={styles.metaText}>
          {t('roadmap.reminders.privacy')}
        </p>

        {settings.enabled && settings.timezone && (
          <p style={styles.metaText}>
            {t('roadmap.reminders.sendingOn', { timezone: settings.timezone })}
          </p>
        )}

        {phase === 'saving' && <p style={styles.metaText}>{t('roadmap.reminders.saving')}</p>}
        {phase === 'saved' && <p style={{ ...styles.metaText, color: 'var(--accent-olive-600)' }}>{t('roadmap.reminders.saved')}</p>}
        {phase === 'error' && <p style={{ ...styles.metaText, color: 'var(--color-danger)' }}>{error}</p>}
      </div>
    </Section>
  );
}

export default ReminderSection;
