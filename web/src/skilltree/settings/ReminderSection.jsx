// Settings §Reminders: the weekly nudge, and the whole rule that governs it. One switch, and an
// honest sentence under it — including the two clauses that keep most weeks quiet, because a
// person with ready steps who never gets mail should recognise the reason here rather than
// conclude the thing is broken. The mail names the tree and its steps, so the copy says that
// out loud before anyone decides.
//
// Turning it ON carries this browser's IANA timezone with the PATCH. The server never marks a
// user due without one, so an enable that can't name a zone is refused here rather than saved as
// a switch that reads "on" and sends nothing. A read that doesn't land — dark server, failed
// fetch — renders nothing at all, the same as every other section whose feature isn't a thing
// here yet.

import React from 'react';
import { Switch } from '../../components';
import { Section, styles } from './Section.jsx';
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

  // "Saved." is an acknowledgement, not a state: it clears itself so it can't sit under the
  // switch for the rest of the session, long outliving the change it described.
  React.useEffect(() => {
    if (phase !== 'saved') return undefined;
    const settle = setTimeout(() => setPhase('idle'), 2400);
    return () => clearTimeout(settle);
  }, [phase]);

  // Nothing while the read is in flight, nothing if it missed, and nothing unless a reminder
  // could actually land in THIS person's inbox — `armed` means deliverable to you (the engine
  // is on AND you are inside its rollout), `enabled` means you asked for it. Offering a switch
  // that promises a weekly email no sweep will send is the one dishonest thing this section
  // could do.
  if (loading || !settings || !settings.armed) return null;

  // `settings.suppressed` rides the wire and is deliberately not rendered: nothing anywhere can
  // set it yet — there is no bounce or complaint webhook — so "we stopped mailing this address"
  // is a state that cannot occur, and copy for a state that cannot occur is copy that lies.
  // The branch comes back here the day the webhook lands.

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
    setSettings({ ...settings, enabled: next, timezone: patch.timezone ?? settings.timezone });
    setPhase('saved');
  };

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

        {/* There is no enabled-but-no-timezone branch: the API refuses that write and is the
            only writer, so the row cannot exist. The guard below is a belt, not a state. */}
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
