// A titled block, the style tokens every settings section lays its rows out with, and the seat the page is drawn for.

import React from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useSyncReplica } from '../../platform/sync/react.js';
import './settings.css';

// `loading` until the shell settles who is here; `signed-in`, an account it has settled; `browsers-own`, nobody signed in
// over the browser's own copy, the anon replica; `signed-out`, nobody signed in over any other copy or none yet, as a lapsed
// session's, whose copy is still the account's and is drawn nowhere on the page.
export function useSettingsSeat() {
  const { user, status } = useAuth();
  const replica = useSyncReplica();
  if (status === 'loading') return 'loading';
  if (status === 'signed-in' && user) return 'signed-in';
  return replica?.state === 'anon' ? 'browsers-own' : 'signed-out';
}

export function Section({ title, children }) {
  return (
    <section style={wrap}>
      <h2 style={heading}>{title}</h2>
      {children}
    </section>
  );
}

export default Section;

const wrap = { borderTop: '1px solid var(--border-subtle)', paddingTop: 16, marginTop: 16 };
const heading = {
  fontFamily: 'var(--font-display)', fontSize: '13px', fontWeight: 800, letterSpacing: '.01em',
  color: 'var(--text-primary)', margin: '0 0 10px',
};

const calmLine = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)', margin: 0 };

export const styles = {
  calmLine,
  // A button with its calm line beside it, the line wrapping under the button only where it has too little room.
  actionRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 12px' },
  actionLine: { ...calmLine, flex: '1 1 0', minWidth: 160 },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--border-subtle)' },
  rowMain: { flex: 1, minWidth: 0 },
  primaryText: { fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  metaText: { fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.45, marginTop: 1 },
  fieldLabel: { fontSize: '10px', fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-tertiary)', margin: '0 0 5px' },
  readonly: { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)' },
  tag: {
    fontSize: '9px', fontWeight: 800, letterSpacing: '.05em', color: 'var(--accent-olive-600)',
    background: 'var(--accent-olive-50)', borderRadius: 'var(--radius-full)', padding: '2px 8px', flex: 'none',
  },
  neutralTag: {
    fontSize: '9px', fontWeight: 800, letterSpacing: '.05em', color: 'var(--text-secondary)',
    background: 'var(--surface-sunken)', borderRadius: 'var(--radius-full)', padding: '2px 8px', flex: 'none',
  },
  dashedRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%',
    padding: '10px', marginTop: 8, boxSizing: 'border-box',
    border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-md)', background: 'transparent',
    fontFamily: 'var(--font-body)', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-secondary)',
    textDecoration: 'none', cursor: 'pointer',
  },
};

export function QuietX({ label, onClick, disabled = false }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 26, height: 26, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', borderRadius: 'var(--radius-full)', cursor: disabled ? 'default' : 'pointer',
        background: hover && !disabled ? 'var(--surface-hover)' : 'transparent',
        color: hover && !disabled ? 'var(--text-primary)' : 'var(--text-tertiary)',
        opacity: disabled ? 0.4 : 1, fontSize: 16, lineHeight: 1,
        transition: 'background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)',
      }}
    >
      ×
    </button>
  );
}

export function ExternalLink({ href, onClick, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className="wm-settings-ext-link"
    >
      <span>{children}</span>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path
          d="M3.5 8.5L8.5 3.5M4.25 3.5H8.5V7.75"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </a>
  );
}
