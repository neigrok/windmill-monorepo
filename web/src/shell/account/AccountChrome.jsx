// The frame /connect and /settings share: one centred card.

import React from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Avatar, BrandWordmark } from '../../design-system';
import { previousLocation, returnToPreviousLocation } from '../navigation.js';

// The shell supplies identity chrome; both modes retain the same return action.
export function AccountChrome({ width = 460, bare = false, children }) {
  const { user, status } = useAuth();
  const signedIn = status === 'signed-in' && Boolean(user);
  const name = signedIn ? (user.name?.trim() || user.email) : '';

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const element = document.activeElement;
      if (element?.isContentEditable || element?.tagName === 'TEXTAREA' || element?.tagName === 'SELECT') return;
      if (element?.tagName === 'INPUT' && !['radio', 'checkbox', 'button', 'submit', 'reset'].includes(element.type)) return;
      event.preventDefault();
      returnToPreviousLocation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const content = (
    <div style={{ ...card, width }}>
      <style>{`
        .wm-account-back { display:inline-flex; align-items:center; gap:8px; min-height:44px;
          color:var(--text-link); font-size:var(--text-xs); font-weight:700; text-decoration:none; }
        .wm-account-back:focus-visible { outline:2px solid var(--text-link); outline-offset:3px; border-radius:var(--radius-sm); }
        .wm-account-escape { color:var(--text-tertiary); font-size:10px; font-weight:400; }
        @media (pointer:coarse) { .wm-account-escape { display:none; } }
      `}</style>
      <div style={head}>
        <a className="wm-account-back" href={previousLocation() ?? '/app'} title="Back (Esc)" onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          returnToPreviousLocation();
        }}>
          <span aria-hidden="true">←</span> Back <span className="wm-account-escape" aria-hidden="true">Esc</span>
        </a>
        {!bare && <>
          <BrandWordmark size={22} style={mark} />
          {signedIn && <Avatar name={name} size={22} />}
        </>}
      </div>
      {children}
    </div>
  );
  if (bare) return content;
  return <div style={shell}>{content}</div>;
}

export default AccountChrome;

const shell = {
  position: 'fixed', inset: 0, display: 'flex', justifyContent: 'center', overflow: 'auto',
  padding: 'var(--space-4)',
  background: 'var(--surface-canvas)', fontFamily: 'var(--font-body)', color: 'var(--text-primary)',
};
const card = {
  maxWidth: '100%', boxSizing: 'border-box', margin: 'auto', background: 'var(--surface-card)',
  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)',
  padding: '18px 20px 18px',
};
const head = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 };
const mark = { fontSize: '14px', fontWeight: 800, marginLeft: 'auto' };
