// New-tree birth (F1·F2 §6) — one bud, one name. Not a dialog: a single bud waits at
// canvas center, the name is typed in place, and ↵ plants it. The name is the
// confirmation — no toast. Committing calls the registry (POST /v1/trees) and the app
// navigates into the freshly-planted tree, where its real first arrival plays.
//
// Reconciled with the backend: planting is signed-in only, so ↵ while signed out opens
// the one sign-in door (X6) and replays once the tab flips. The full WebGL bud-wake
// ceremony is a follow-up; this is the faithful DOM birth — bud, in-place name, plaque.

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { requestMagicLink } from '../auth/AuthClient.js';
import { SignInDialog } from '../auth/SignInDialog.jsx';
import { createTree } from '../persistence/TreeRegistry.js';

const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function NewTreeBirth() {
  const { status } = useAuth();
  const [name, setName] = useState('');
  const [phase, setPhase] = useState('naming'); // naming | planting | error
  const [signInOpen, setSignInOpen] = useState(false);
  const inputRef = useRef(null);
  const pending = useRef(false); // a plant waiting on sign-in

  const signedIn = status === 'signed-in';

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function plant() {
    if (phase === 'planting') return;
    if (!signedIn) { pending.current = true; setSignInOpen(true); return; }
    setPhase('planting');
    try {
      const title = name.trim();
      const { treeId } = await createTree({ blank: true, ...(title ? { title } : {}) });
      window.location.hash = `#/app/${treeId}`;
    } catch (err) {
      if (err.code === 'unauthenticated') { pending.current = true; setSignInOpen(true); setPhase('naming'); }
      else setPhase('error');
    }
  }

  // Sign-in resolves in another tab; AuthProvider flips this one. Close the door and,
  // if a plant was waiting, run it now — the typed name is still in state.
  useEffect(() => {
    if (!signedIn) return;
    setSignInOpen(false);
    if (pending.current) { pending.current = false; plant(); }
  }, [signedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); plant(); }
    else if (e.key === 'Escape') { e.preventDefault(); window.history.back(); }
  };

  const planting = phase === 'planting';
  const plaqueName = name.trim() || 'New tree';

  return (
    <div style={shell}>
      <style>{CSS}</style>

      {/* The plaque mirrors the typing — naming the root names the tree */}
      <div style={plaque}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', background: 'var(--color-brand-soft)', color: 'var(--color-brand-hover)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 20v-8" /><path d="M12 12c0-3 2-5 6-5 0 3-2 5-6 5z" /><path d="M12 14c0-2.5-1.7-4-5-4 0 2.5 1.7 4 5 4z" /></svg>
        </span>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>Windmill</span>
        <span style={{ fontSize: 'var(--text-xs)', color: name.trim() ? 'var(--text-secondary)' : 'var(--text-tertiary)', marginLeft: 4, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{plaqueName}</span>
      </div>

      <div style={stage}>
        <span className={`birth-bud ${planting ? 'is-planting' : ''} ${reduced() ? '' : 'is-wake'}`} />

        {phase === 'error' ? (
          <>
            <div style={title}>Couldn’t plant it just now</div>
            <p style={sub}>Nothing was created. Try again in a moment.</p>
            <button type="button" className="birth-plant" onClick={() => setPhase('naming')}>Try again</button>
          </>
        ) : (
          <>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Name your roadmap"
              disabled={planting}
              aria-label="Name your roadmap"
              style={nameInput}
            />
            <div style={hint}>
              {planting ? 'Planting…' : (<><kbd style={kbd}>↵</kbd> plants your tree</>)}
            </div>
          </>
        )}
      </div>

      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} onSend={requestMagicLink} />
    </div>
  );
}

export default NewTreeBirth;

const shell = { position: 'fixed', inset: 0, background: 'var(--surface-canvas)', fontFamily: 'var(--font-body)', color: 'var(--text-primary)' };
const plaque = { position: 'absolute', top: 'var(--space-6)', left: 'var(--space-6)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', background: 'color-mix(in srgb, var(--surface-card) 88%, transparent)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-full)', boxShadow: 'var(--shadow-sm)' };
const stage = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-4)', padding: 'var(--space-6)' };
const title = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-xl)' };
const sub = { fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 };
const nameInput = { width: 'min(420px, 80vw)', textAlign: 'center', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '26px', color: 'var(--text-primary)' };
const hint = { fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 };
const kbd = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 5px', border: '1px solid var(--border-default)', borderBottomWidth: 2, borderRadius: 5, background: 'var(--surface-card)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-primary)' };

const CSS = `
  .birth-bud { width:46px; height:46px; border-radius:50%; box-sizing:border-box;
               border:2.5px dashed var(--accent-terracotta-400); background:var(--color-brand-soft);
               box-shadow:0 0 0 0 rgba(188,108,66,.28); }
  .birth-bud.is-wake { animation:birth-wake 480ms var(--ease-soft) 1, birth-breathe 2400ms var(--ease-glow) 480ms infinite; }
  .birth-bud.is-planting { border-style:solid; border-color:var(--accent-terracotta-600); background:var(--color-brand);
               box-shadow:0 0 0 5px rgba(188,108,66,.28), 0 0 28px 6px rgba(188,108,66,.32);
               transition:background 280ms var(--ease-standard), border-color 280ms var(--ease-standard), box-shadow 280ms var(--ease-standard); }
  @keyframes birth-wake { 0% { transform:scale(.82); opacity:0; } 55% { transform:scale(1.04); opacity:1; } 100% { transform:scale(1); } }
  @keyframes birth-breathe { 0%,100% { box-shadow:0 0 0 3px rgba(188,108,66,.14); } 50% { box-shadow:0 0 0 5px rgba(188,108,66,.24), 0 0 22px 4px rgba(188,108,66,.22); } }
  .birth-plant { display:inline-flex; align-items:center; justify-content:center; cursor:pointer;
                 font-family:var(--font-body); font-size:var(--text-sm); font-weight:800; padding:10px 20px;
                 border:none; border-radius:var(--radius-full); background:var(--color-brand); color:var(--text-on-accent);
                 box-shadow:var(--shadow-sm); transition:background var(--duration-fast) var(--ease-standard); }
  .birth-plant:hover { background:var(--color-brand-hover); }
  @media (prefers-reduced-motion: reduce) { .birth-bud { animation:none !important; } }
`;
