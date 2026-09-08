import React, { useEffect, useRef, useState } from 'react';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { gymApi } from '../gymApi.js';
import { NOTES_HREF } from '../log.js';
import { HEAD_LINE } from '../notes/notes.js';
import { LB, spellWeightsIn, UNITS } from '../units.js';
import { preferenceRefusal, preferencesWrite, readPreferences } from './preferences.js';

export function GymSettingsSection({ api = gymApi } = {}) {
  const [preferences, setPreferences] = useState(null);
  const [refused, setRefused] = useState('');
  // The document the store last confirmed; a ref, so a reverting reply cannot close over a stale copy.
  const stored = useRef(null);
  // An older reply landing after a newer one must not redraw the row.
  const write = useRef(0);
  const confirmed = useRef(0);

  useEffect(() => {
    let live = true;
    api.preferences()
      .then((document) => {
        if (!live) return;
        const held = readPreferences(document);
        stored.current = held;
        setPreferences(held);
        spellWeightsIn(held.units);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [api]);

  if (!preferences) return null;

  const changeUnits = async (units) => {
    const next = { ...preferences, units };
    setPreferences(next);
    spellWeightsIn(next.units);
    setRefused('');
    const mine = write.current + 1;
    write.current = mine;
    try {
      const answered = readPreferences(await api.savePreferences(preferencesWrite(next)));
      if (mine > confirmed.current) {
        confirmed.current = mine;
        stored.current = answered;
      }
      if (write.current !== mine) return;
      setPreferences(answered);
      spellWeightsIn(answered.units);
    } catch (error) {
      if (write.current !== mine) return;
      setPreferences(stored.current);
      spellWeightsIn(stored.current.units);
      setRefused(preferenceRefusal(error));
    }
  };

  return (
    <Section title="Your training log">
      <div style={look.row}>
        <div style={look.head}>
          <span style={styles.primaryText}>Units</span>
          <span style={look.choices} role="group" aria-label="Weight units">
            {UNITS.map((unit) => (
              <button key={unit} type="button" aria-pressed={unit === preferences.units}
                onClick={() => changeUnits(unit)}
                style={unit === preferences.units ? { ...look.choice, ...look.choiceOn } : look.choice}>
                {unit}
              </button>
            ))}
          </span>
        </div>
        {preferences.units === LB && <p style={{ ...styles.calmLine, marginTop: 8 }}>A backfill, a correction, a routine target — typed in kg.</p>}
      </div>

      <a href={NOTES_HREF} style={look.door}>
        <span style={look.doorMain}>
          <span style={styles.primaryText}>Notes</span>
          <span style={styles.metaText}>{HEAD_LINE}</span>
        </span>
        <span aria-hidden="true" style={look.chevron}>›</span>
      </a>

      {refused && <p style={look.refused}>{refused}</p>}
    </Section>
  );
}

export default GymSettingsSection;

const look = {
  row: { padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  choices: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' },
  choice: {
    minWidth: 54, padding: '5px 12px',
    border: '1px solid var(--border-default)', borderRadius: 'var(--radius-full)',
    background: 'transparent', color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: 700, cursor: 'pointer',
  },
  choiceOn: { borderColor: 'var(--color-brand)', color: 'var(--color-brand)', background: 'var(--color-brand-soft)' },
  door: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0',
    borderBottom: '1px solid var(--border-subtle)', textDecoration: 'none',
  },
  doorMain: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  chevron: { fontSize: 18, color: 'var(--text-tertiary)' },
  refused: { ...styles.calmLine, marginTop: 10, color: 'var(--color-danger)' },
};
