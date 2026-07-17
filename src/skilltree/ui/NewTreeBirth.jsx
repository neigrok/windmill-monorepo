// New-tree birth (F1·F2 §6) — one bud, one name. Not a dialog: a single bud waits at
// canvas center, the name is typed in place, and ↵ plants it. The name is the
// confirmation — no toast. Signed in, the registry (POST /v1/trees) plants it; signed
// out, the tree is born locally (anon-first-tree §01) — client-minted id, lattice-born,
// IndexedDB-persisted — and the editor opens exactly the same. No sign-in door here:
// the seat menu stays the product's only unprompted mention of sign-in.
//
// paste-import (F3) adds a HANDLE, never a surface: raw ⌘V anywhere (and a dropped
// .md/.txt) opens the composer already filled and parsed, docked where the StepPanel
// lives while the bud dims but never leaves. Esc returns to the bud, draft kept.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { createTree } from '../persistence/TreeRegistry.js';
import { bearLocalTree, bearImportedTree } from '../sync/localTrees.js';
import { DEFAULT_KINDS } from '../model/Legend.js';
import { parsePlan } from '../paste/planGrammar.js';
import { PasteComposer } from '../paste/PasteComposer.jsx';
import { GhostSkeleton } from '../paste/GhostSkeleton.jsx';
import { BottomSheet } from './mobile/BottomSheet.jsx';
import { useViewMode } from './useViewMode.js';
import { track } from '../../telemetry/beacon.js';

const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function NewTreeBirth() {
  const { status } = useAuth();
  const { breakpoint } = useViewMode();
  const [name, setName] = useState('');
  const [phase, setPhase] = useState('naming'); // naming | planting | error
  const [draft, setDraft] = useState('');       // the composer's text — survives Esc
  const [draftKinds, setDraftKinds] = useState(DEFAULT_KINDS);
  const [composerOpen, setComposerOpen] = useState(false);
  const [dropHot, setDropHot] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const parse = useMemo(
    () => (composerOpen ? parsePlan(draft, draftKinds) : null),
    [composerOpen, draft, draftKinds],
  );

  // Raw ⌘V anywhere on the canvas opens the composer already filled and parsed —
  // capture-phase, mounted ONLY while the composer is closed, so the composer's own
  // textarea pastes stay ordinary. Images and empty clipboards fall through untouched.
  useEffect(() => {
    if (composerOpen) return undefined;
    const onPaste = (event) => {
      const pasted = event.clipboardData?.getData('text/plain') ?? '';
      if (pasted.trim() === '') return;
      event.preventDefault();
      setDraft(pasted);
      setComposerOpen(true);
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, [composerOpen]);

  // A dropped .md/.txt/text file is the same door — and it stays open: with the
  // composer up, a plan file simply replaces the well text (the parse follows live).
  // Every drop is neutralized, plan or not — the browser must never navigate away to
  // a file and take the draft with it. The welcome hint lights only for drags that
  // plausibly carry text (file names are hidden mid-drag, so the item type decides).
  useEffect(() => {
    const planFile = (file) => file && (/\.(md|txt)$/i.test(file.name) || file.type.startsWith('text/'));
    const onDragOver = (event) => {
      const items = [...(event.dataTransfer?.items ?? [])];
      if (!items.some((item) => item.kind === 'file')) return;
      event.preventDefault(); // accept every file drag — an unaccepted drop navigates the tab
      setDropHot(items.some((item) => item.kind === 'file' && (item.type === '' || item.type.startsWith('text/'))));
    };
    const onDragLeave = (event) => { if (event.relatedTarget === null) setDropHot(false); };
    const onDrop = (event) => {
      setDropHot(false);
      if (!(event.dataTransfer?.types ?? []).includes('Files')) return; // a text drag keeps its default (dropping into the well)
      event.preventDefault();
      const file = [...event.dataTransfer.files].find(planFile);
      if (!file) return;
      file.text().then((content) => {
        // Synchronously retire any in-flight AI stream BEFORE the draft lands, or a
        // pending stream flush (rAF fires ahead of React effects) overwrites the drop.
        window.dispatchEvent(new Event('wm-draft-replaced'));
        setDraft(content);
        setComposerOpen(true);
      });
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  async function plant() {
    if (phase === 'planting') return;
    setPhase('planting');
    const title = name.trim();
    try {
      if (status === 'signed-in') {
        // Plant the named bud as the tree's first node — its root — so the new tree opens on the
        // very node you just named rather than an empty canvas (F1·F2 §6: naming the root names the
        // tree). It's born in the default 'Build' kind; the server seeds the matching legend.
        const rootId = crypto.randomUUID?.() ?? `n-${Date.now()}`;
        const root = { id: rootId, label: title, icon: 'sparkles', color: DEFAULT_KINDS[0].hue, prerequisites: [] };
        const { treeId } = await createTree({ ...(title ? { title } : {}), nodes: [root] });
        track('birth');
        window.location.hash = `#/app/${treeId}`;
        return;
      }
      window.location.hash = `#/app/${await plantLocally(title)}`;
    } catch (err) {
      // A signed-in plant the server refuses for want of a session falls back to the
      // local birth — the worst case of auth is the product's normal signed-out state.
      if (err.code === 'unauthenticated' || err.code === 'unreachable') {
        try {
          window.location.hash = `#/app/${await plantLocally(title)}`;
          return;
        } catch { /* the local soil failed too — fall through to the error face */ }
      }
      setPhase('error');
    }
  }

  // The composer's Plant: the parsed subgraph through the same two roads — the registry
  // when signed in (it seeds structure, statuses and legend from the post), the local
  // soil otherwise or when the server can't answer.
  async function plantImported(plan) {
    if (phase === 'planting') return;
    setPhase('planting');
    try {
      if (status === 'signed-in') {
        const { treeId } = await createTree({ ...(plan.title ? { title: plan.title } : {}), nodes: plan.nodes, kinds: plan.kinds });
        track('birth', { import: true, steps: plan.nodes.length });
        window.location.hash = `#/app/${treeId}`;
        return;
      }
      window.location.hash = `#/app/${await plantImportedLocally(plan)}`;
    } catch (err) {
      if (err.code === 'unauthenticated' || err.code === 'unreachable') {
        try {
          window.location.hash = `#/app/${await plantImportedLocally(plan)}`;
          return;
        } catch { /* the local soil failed too — fall through to the error face */ }
      }
      setPhase('error');
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); plant(); }
    else if (e.key === 'Escape') { e.preventDefault(); window.history.back(); }
  };

  const planting = phase === 'planting';
  const plaqueName = name.trim() || 'New tree';

  const composer = composerOpen && parse && (
    <PasteComposer
      text={draft}
      onTextChange={setDraft}
      kinds={draftKinds}
      onKindsChange={setDraftKinds}
      parse={parse}
      budName={name}
      planting={planting}
      onClose={() => setComposerOpen(false)}
      onPlant={plantImported}
      sheet={breakpoint !== 'desktop'}
    />
  );

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
        <span className={`birth-bud ${planting ? 'is-planting' : ''} ${reduced() ? '' : 'is-wake'} ${composerOpen ? 'is-dimmed' : ''}`} />

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
            {!planting && !composerOpen && (
              <div style={hint}>
                or <button type="button" className="birth-paste-door" onClick={() => setComposerOpen(true)}>paste a plan</button> — ⌘V anywhere
              </div>
            )}
          </>
        )}
      </div>

      {/* The ghost skeleton grows on the stage as the plan is typed — cut on phone. */}
      {composerOpen && parse && breakpoint !== 'phone' && (
        <div className={`birth-ghost-stage${breakpoint === 'desktop' ? '' : ' birth-ghost-stage--wide'}`}>
          <GhostSkeleton nodes={parse.nodes} />
        </div>
      )}

      {composerOpen && parse && (breakpoint === 'desktop' ? (
        <aside className="birth-composer">{composer}</aside>
      ) : (
        <BottomSheet open onDismiss={() => setComposerOpen(false)}>{composer}</BottomSheet>
      ))}

      {dropHot && <div className="birth-drop-hint" />}
    </div>
  );
}

export default NewTreeBirth;

// The signed-out plant: born on this device, claimed by whichever account signs in later.
async function plantLocally(title) {
  const treeId = await bearLocalTree({ title });
  track('birth', { local: true });
  return treeId;
}

async function plantImportedLocally(plan) {
  const treeId = await bearImportedTree(plan);
  track('birth', { import: true, steps: plan.nodes.length, local: true });
  return treeId;
}

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
               box-shadow:0 0 0 0 rgba(188,108,66,.28); transition:opacity 150ms var(--ease-standard); }
  .birth-bud.is-wake { animation:birth-wake 480ms var(--ease-soft) 1, birth-breathe 2400ms var(--ease-glow) 480ms infinite; }
  .birth-bud.is-dimmed { opacity:.35; }
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
  .birth-plant:disabled { opacity:.5; cursor:default; }
  .birth-plant:disabled:hover { background:var(--color-brand); }
  .birth-paste-door { border:none; background:none; padding:0; cursor:pointer; font-family:inherit;
                      font-size:inherit; font-weight:700; color:var(--text-secondary); }
  .birth-paste-door:hover { color:var(--text-primary); }
  @media (prefers-reduced-motion: reduce) { .birth-bud { animation:none !important; } }
`;
