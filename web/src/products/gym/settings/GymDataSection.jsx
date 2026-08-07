// Settings · Your training log — the export, and nothing else. Account deletion is the account's own
// business and lives in one place for the whole brand; a product may not grow a second door that
// closes it.
//
// IT DRAWS NOTHING WHEN THERE IS NOTHING TO EXPORT. The settings page composes every product's
// sections for every signed-in visitor, and one account may use one product — so an account that
// has only ever grown skill trees would otherwise be offered a file of a training log it has never
// had. One cheap read settles it, and a read that does not come back draws nothing either: a
// section that appears only when it is real may not appear on a maybe.
//
// The link is an anchor and not a fetch. The server answers with a Content-Disposition and the
// browser saves the file — so a log too large to sit in a tab's memory still lands, and nothing is
// held, parsed or re-serialized on the way.

import React, { useEffect, useState } from 'react';
import { EXPORT_HREF, gymApi } from '../gymApi.js';
import { Section, styles } from '../../../shell/settings/Section.jsx';

export function GymDataSection() {
  const [hasLog, setHasLog] = useState(false);

  useEffect(() => {
    let live = true;
    gymApi.sessions({ limit: 1 })
      .then((sessions) => { if (live) setHasLog(sessions.length > 0); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  if (!hasLog) return null;

  return (
    <Section title="Your training log">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <a href={EXPORT_HREF} style={link}>Export my sets</a>
        <span style={styles.calmLine}>
          A .csv of every set you have logged — one row per set, nothing left out. It stays yours.
        </span>
      </div>
    </Section>
  );
}

export default GymDataSection;

const link = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 32,
  padding: '0 14px',
  borderRadius: 8,
  border: '1px solid var(--border-default)',
  background: 'var(--surface-card)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  textDecoration: 'none',
};
