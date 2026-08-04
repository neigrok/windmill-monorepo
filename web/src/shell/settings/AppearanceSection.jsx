import React from 'react';
import { Section } from './Section.jsx';
import { APPEARANCE_CHOICES } from '../appearance.js';
import { useAppearance } from '../useAppearance.js';

// Light or dark for the whole app, chosen once. Shown whether or not anyone is signed in — this is
// a preference of the DEVICE, not of an account, so gating it behind sign-in would be asking for a
// password to turn on a lamp.
//
// What it sets: the shell and every room that does not pin its own skin. Journal maps it onto night
// or parchment; gym's instrument skin stays steel either way. The marketing pages are outside the
// app surface and stay warm cream, which is canon rather than an oversight.

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
        Sets Windmill — the rail, this page and every room. Journal wears its night canvas in dark and
        warm parchment in light; gym stays steel. “System” follows your device.
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
