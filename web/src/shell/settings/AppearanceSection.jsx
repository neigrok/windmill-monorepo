import React from 'react';
import { Section } from './Section.jsx';
import { APPEARANCE_CHOICES } from '../appearance.js';
import { useAppearance } from '../useAppearance.js';

// A device preference, so it shows signed out too. It sets the shell and every room that does not
// pin its own skin.

const LABELS = { light: 'Light', dark: 'Dark', system: 'System' };

export function AppearanceSection() {
  const { choice, set } = useAppearance();

  return (
    <Section title="Appearance">
      <div style={row} role="group" aria-label="Appearance">
        {APPEARANCE_CHOICES.map((option) => {
          const active = option === choice;
          return (
            <button
              key={option}
              type="button"
              onClick={() => set(option)}
              aria-pressed={active}
              style={{ ...pill, ...(active ? pillOn : null) }}
            >
              {LABELS[option]}
            </button>
          );
        })}
      </div>
      <p style={note}>
        Sets Windmill — this page and every room. Each room answers it in its own colours: roadmap is
        Tuscany at midday or the embers after it, journal is paper in north light or dusk with one
        candle. Gym keeps its basalt whichever you pick. “System” follows your device.
      </p>
    </Section>
  );
}

export default AppearanceSection;

const row = { display: 'flex', gap: '6px', padding: '4px', borderRadius: '999px', background: 'var(--surface-sunken)', width: 'fit-content' };
const pill = {
  appearance: 'none', border: '1px solid transparent', background: 'transparent', cursor: 'pointer',
  padding: '7px 16px', borderRadius: '999px', font: 'inherit', fontSize: 'var(--text-xs)',
  fontWeight: 700, color: 'var(--text-tertiary)',
};
const pillOn = { background: 'var(--surface-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-link)' };
const note = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)', margin: '10px 0 0' };
