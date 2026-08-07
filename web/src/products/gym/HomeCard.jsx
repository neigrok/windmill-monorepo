// The gym's /app home cell (shell contract §HomeCards) — the training log's one line on the home
// grid. Everything it says it reads off this device: the auth status the shell has already
// resolved, and one localStorage look at whether a workout was left open here. No fetch at all —
// this cell is drawn in the first frame after sign-in, and a training log is a read the log itself
// is a better place to wait for.

import React, { useState } from 'react';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { openSessionOnThisDevice } from './device.js';

// Three answers, one door each. A session left open on this device outranks the other two because
// it is the only one of them that is about today — and it is said as what this device knows
// ("still open here"), never as a claim about what the log currently holds, which nothing on this
// screen has asked.
//
// A ghost is told about the account BEFORE the tap rather than after it. #/gym answers a visitor
// with no account with a sign-in pitch and nothing else, so a cell reading "Open the log →" would
// be an ambush; the log being kept on an account is the honest first fact about this product.
function cell({ signedIn, openSession }) {
  if (signedIn && openSession) return { body: 'A workout is still open on this device.', link: 'Pick it up →' };
  if (signedIn) return { body: 'Two taps a set, and the next session opens with last time’s numbers already in the field.', link: 'Open the log →' };
  return { body: 'Sets, weights, and what you lifted last time — kept on your account.', link: 'Sign in to open your log →' };
}

export function HomeCard() {
  const { status } = useAuth();
  // Read once, on mount: a workout that starts while somebody is looking at the home grid starts
  // inside the log, which is a screen away from here.
  const [openSession] = useState(openSessionOnThisDevice);
  // 'loading' reads as signed out on purpose — the same face a first-ever visitor gets. A returning
  // signed-in tab never sees it: AuthProvider seeds itself from its own hint on the first frame.
  const { body, link } = cell({ signedIn: status === 'signed-in', openSession });

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

// The dot's fallback restates the design system's --kind-sky for scopes that have not loaded the
// palette — the token wins wherever it exists. Steel is gym's hue everywhere else in the product,
// and the home grid is scoped to clay, so the ramp token is read directly rather than --color-brand.
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
