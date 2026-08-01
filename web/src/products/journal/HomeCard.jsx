// The journal's /app home cell (shell contract §HomeCards) — static true copy in the journal
// register: page, the canvas, write. No fetches, no counters, nothing unlocked or earned. The
// auth hint (read once, never fetched) only picks which door line shows; a first-ever visitor
// reads as signed out.

import React, { useState } from 'react';

function signedIn() {
  try {
    const hint = JSON.parse(localStorage.getItem('windmill:auth-hint') || 'null');
    return hint?.status === 'signed-in' && Boolean(hint.user);
  } catch { return false; }
}

export function HomeCard() {
  const [writer] = useState(signedIn);

  return (
    <>
      <style>{CSS}</style>
      <a className="wm-jhc" href="#/journal">
        <span className="wm-jhc-head">
          <span className="wm-jhc-dot" aria-hidden="true" />
          Journal
        </span>
        <span className="wm-jhc-body">{writer ? 'The cursor is already waiting.' : 'Tonight’s page can be three lines.'}</span>
        <span className="wm-jhc-link">{writer ? 'Open journal →' : 'Start writing →'}</span>
      </a>
    </>
  );
}

export default HomeCard;

// The lamp dot's fallback restates the design system's --lamp-500 for scopes that haven't
// loaded the journal ramp — the token wins wherever it exists.
const CSS = `
  .wm-jhc { display:flex; flex-direction:column; gap:8px; text-align:left; box-sizing:border-box;
            background:var(--surface-card); border:1px solid var(--border-subtle); border-radius:var(--radius-xl);
            padding:20px 22px; box-shadow:var(--shadow-sm); text-decoration:none; cursor:pointer;
            transition:box-shadow 150ms var(--ease-standard), transform 150ms var(--ease-standard); }
  .wm-jhc:hover { box-shadow:var(--shadow-md); }
  .wm-jhc:active { transform:scale(0.97); }
  .wm-jhc-head { display:flex; align-items:center; gap:9px; font-family:var(--font-display);
                 font-weight:700; font-size:17px; color:var(--text-primary); }
  .wm-jhc-dot { width:10px; height:10px; border-radius:50%; flex:none; background:var(--lamp-500, #C29A4E); }
  .wm-jhc-body { font-family:var(--font-body); font-size:14px; line-height:1.5; color:var(--text-secondary); }
  .wm-jhc-link { font-weight:700; font-size:13.5px; color:var(--text-link); }

  @media (prefers-reduced-motion: reduce) { .wm-jhc { transition:none; } .wm-jhc:active { transform:none; } }
`;
