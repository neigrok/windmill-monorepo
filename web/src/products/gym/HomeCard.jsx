import React from 'react';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';

function cell({ signedIn }) {
  if (signedIn) return { body: 'Workouts start on your phone and land here — the log, the routines, the long line of showing up.', link: 'Open the log →' };
  return { body: 'Sets, weights, and what you lifted last time — kept on your account.', link: 'Sign in to open your log →' };
}

export function HomeCard() {
  const { status } = useAuth();
  const { body, link } = cell({ signedIn: status === 'signed-in' });

  return (
    <>
      <style>{CSS}</style>
      <a className="wm-ghc" href="#/gym">
        <span className="wm-ghc-head">
          <span className="wm-ghc-dot" aria-hidden="true" />
          Gym
        </span>
        <span className="wm-ghc-body">{body}</span>
        <span className="wm-ghc-link">{link}</span>
      </a>
    </>
  );
}

export default HomeCard;

const CSS = `
  .wm-ghc { display:flex; flex-direction:column; gap:8px; text-align:left; box-sizing:border-box;
            background:var(--surface-card); border:1px solid var(--border-subtle); border-radius:var(--radius-xl);
            padding:20px 22px; box-shadow:var(--shadow-sm); text-decoration:none; cursor:pointer;
            transition:box-shadow 150ms var(--ease-standard), transform 150ms var(--ease-standard); }
  .wm-ghc:hover { box-shadow:var(--shadow-md); }
  .wm-ghc:active { transform:scale(0.97); }
  .wm-ghc-head { display:flex; align-items:center; gap:9px; font-family:var(--font-display);
                 font-weight:700; font-size:17px; color:var(--text-primary); }
  .wm-ghc-dot { width:10px; height:10px; border-radius:50%; flex:none; background:var(--kind-sky, #5F8494); }
  .wm-ghc-body { font-family:var(--font-body); font-size:14px; line-height:1.5; color:var(--text-secondary); }
  .wm-ghc-link { font-weight:700; font-size:13.5px; color:var(--text-link); }

  @media (prefers-reduced-motion: reduce) { .wm-ghc { transition:none; } .wm-ghc:active { transform:none; } }
`;
