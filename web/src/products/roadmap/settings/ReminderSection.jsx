// An enable that cannot name an IANA zone is refused here: the server never marks a user due without one.

import React from 'react';
import { Switch } from '../../../design-system';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import {
  browserTimezone, describeSchedule, fetchReminders, reminderPatch, saveReminders,
} from '../reminders/remindersClient.js';

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
      setError("This browser won't say which timezone you're in, so we can't pick a decent hour to send. Reminders stay off.");
      return;
    }
    setPhase('saving');
    setError(null);
    const saved = await saveReminders(patch);
    if (!saved) {
      setPhase('error');
      setError("Couldn't save just now — try again.");
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
      <Section title="Reminders">
        <div style={{ padding: '2px 0 4px' }}>
          <p style={{ ...styles.primaryText, whiteSpace: 'normal' }}>
            We can't send reminders to your email address.
          </p>
          <p style={{ ...styles.metaText, marginTop: 8 }}>
            Mail we sent came back permanently undeliverable, or was reported as spam. Either way
            we stopped writing to an address that can't receive it, rather than keep trying.
          </p>
          <p style={styles.metaText}>
            Sign-in email is unaffected — magic links still go to this address, so you can always
            get back in.
          </p>
          <p style={styles.metaText}>
            We won't retry on our own. If the address works again, turn reminders back on and
            we'll write to it — and stop again if that mail comes back too.
          </p>
          <button type="button" style={styles.dashedRow} onClick={() => toggle(true)}
                  disabled={phase === 'saving'}>
            Turn reminders back on
          </button>
          {phase === 'saving' && <p style={styles.metaText}>Saving…</p>}
          {phase === 'error' && <p style={{ ...styles.metaText, color: 'var(--color-danger)' }}>{error}</p>}
        </div>
      </Section>
    );
  }

  return (
    <Section title="Reminders">
      <div style={{ padding: '2px 0 4px' }}>
        <Switch checked={settings.enabled} onChange={toggle} label="Weekly reminder email" />

        <p style={{ ...styles.metaText, marginTop: 8 }}>
          One email a week — {describeSchedule(settings)} — and only when a tree of yours has
          steps ready and you haven't opened Windmill in three days. A busy week means no email;
          so does a quiet one. And nothing at all in your first week here.
        </p>

        <p style={styles.metaText}>
          The email names the tree and up to three of its ready steps, so those titles ride
          along in ordinary email — and can surface on a lock screen.
        </p>

        {settings.enabled && settings.timezone && (
          <p style={styles.metaText}>
            Sending on {settings.timezone} time. Every reminder carries a one-tap pause.
          </p>
        )}

        {phase === 'saving' && <p style={styles.metaText}>Saving…</p>}
        {phase === 'saved' && <p style={{ ...styles.metaText, color: 'var(--accent-olive-600)' }}>Saved.</p>}
        {phase === 'error' && <p style={{ ...styles.metaText, color: 'var(--color-danger)' }}>{error}</p>}
      </div>
    </Section>
  );
}

export default ReminderSection;
