import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { createTree } from '../persistence/TreeRegistry.js';
import { bearLocalTree, bearImportedTree, deviceKeepsTrees } from '../sync/localTrees.js';
import { DEFAULT_KINDS } from '../model/Legend.js';
import { parsePlan } from './planGrammar.js';
import { PasteComposer } from './PasteComposer.jsx';
import { GhostSkeleton } from './GhostSkeleton.jsx';
import { BottomSheet } from './BottomSheet.jsx';
import { useViewMode } from '../room/useViewMode.js';
import { DOCK_WIDTH } from '../graph/viewport.js';
import { stampBorn } from '../persistence/ViewPrefs.js';
import { prefersReducedMotion } from '../theme.js';
import { DEVICE_REFUSED } from '../copy.js';
import { t } from '../i18n/index.js';
import { countBucket } from '../board/acts.js';
import { reportUnexpectedFailure } from '../reportFailure.js';
import { track } from '../../../telemetry/beacon.js';


// Stamp the tree so its first open is the canvas, where the arrival ceremony plays.
function openBorn(treeId) {
  stampBorn(treeId);
  window.location.hash = `#/app/${treeId}`;
}


export function NewTreeBirth() {
  const { status, holdDeviceLine } = useAuth();
  const { breakpoint } = useViewMode();
  const [name, setName] = useState('');
  const [phase, setPhase] = useState('naming'); // naming | planting | error
  const [draft, setDraft] = useState('');       // the composer's text — survives Esc
  const [draftKinds, setDraftKinds] = useState(DEFAULT_KINDS);
  const [composerOpen, setComposerOpen] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.hash.split('?')[1] ?? '').has('compose'));
  const [dropHot, setDropHot] = useState(false);
  const [deviceRefused, setDeviceRefused] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Short of a signed-in account a plan lives only on this device: a browser that will not keep one is told before anyone types.
  useEffect(() => {
    if (status === 'signed-in') {
      setDeviceRefused(false);
      return undefined;
    }
    let current = true;
    deviceKeepsTrees().then((keeps) => { if (current) setDeviceRefused(!keeps); });
    return () => { current = false; };
  }, [status]);

  useEffect(() => (deviceRefused ? holdDeviceLine() : undefined), [deviceRefused, holdDeviceLine]);

  const parse = useMemo(
    () => (composerOpen ? parsePlan(draft, draftKinds) : null),
    [composerOpen, draft, draftKinds],
  );

  // Capture-phase, and mounted ONLY while the composer is closed, so its own textarea pastes stay ordinary.
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

  // Every file drop is neutralized, plan or not, or the browser navigates away and takes the draft with it.
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
        // Retire any in-flight AI stream BEFORE the draft lands: a pending flush would overwrite the drop.
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
        const rootId = crypto.randomUUID?.() ?? `n-${Date.now()}`;
        const root = { id: rootId, label: title, icon: 'sparkles', color: DEFAULT_KINDS[0].hue, prerequisites: [] };
        const { treeId } = await createTree({ ...(title ? { title } : {}), nodes: [root] });
        track('birth');
        openBorn(treeId);
        return;
      }
      openBorn(await plantLocally(title));
    } catch (err) {
      reportUnexpectedFailure('roadmap-plant', err);
      // A signed-in plant the server refuses for want of a session falls back to the local birth.
      if (err.code === 'unauthenticated' || err.code === 'unreachable') {
        try {
          openBorn(await plantLocally(title));
          return;
        } catch { /* the local soil failed too — fall through to the error face */ }
      }
      track('roadmap_board_create', { step: 'failed', door: 'blank' });
      setPhase('error');
    }
  }

  async function plantImported(plan) {
    if (phase === 'planting') return;
    setPhase('planting');
    try {
      if (status === 'signed-in') {
        const { treeId } = await createTree({ ...(plan.title ? { title: plan.title } : {}), nodes: plan.nodes, kinds: plan.kinds });
        track('birth', { import: true, steps: countBucket(plan.nodes.length) });
        openBorn(treeId);
        return;
      }
      openBorn(await plantImportedLocally(plan));
    } catch (err) {
      reportUnexpectedFailure('roadmap-plant', err);
      if (err.code === 'unauthenticated' || err.code === 'unreachable') {
        try {
          openBorn(await plantImportedLocally(plan));
          return;
        } catch { /* the local soil failed too — fall through to the error face */ }
      }
      track('roadmap_board_create', { step: 'failed', door: 'import' });
      setPhase('error');
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); plant(); }
    else if (e.key === 'Escape') { e.preventDefault(); window.location.hash = '#/app'; }
  };

  const planting = phase === 'planting';
  const composing = composerOpen && !deviceRefused;
  const plaqueName = name.trim() || t('roadmap.untitled');
  const pasteDoor = <button type="button" className="birth-paste-door" onClick={() => setComposerOpen(true)}>{t('roadmap.birth.pasteDoor')}</button>;

  const composer = composing && parse && (
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

      <div style={plaque}>
        <a href="#/app" style={plaqueLink}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', background: 'var(--color-brand-soft)', color: 'var(--color-brand-hover)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 20v-8" /><path d="M12 12c0-3 2-5 6-5 0 3-2 5-6 5z" /><path d="M12 14c0-2.5-1.7-4-5-4 0 2.5 1.7 4 5 4z" /></svg>
          </span>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>Windmill</span>
          <span style={{ fontSize: 'var(--text-xs)', color: name.trim() ? 'var(--text-secondary)' : 'var(--text-tertiary)', marginLeft: 4, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{plaqueName}</span>
        </a>
      </div>

      <div style={stage}>
        <span className={`birth-bud ${planting ? 'is-planting' : ''} ${prefersReducedMotion() ? '' : 'is-wake'} ${composing ? 'is-dimmed' : ''}`} />

        {deviceRefused ? (
          <div role="alert" style={{ display: 'contents' }}>
            <div style={title}>{DEVICE_REFUSED.title}</div>
            <p style={sub}>{DEVICE_REFUSED.body}</p>
          </div>
        ) : phase === 'error' ? (
          <>
            <div style={title}>{t('roadmap.birth.failedTitle')}</div>
            <p style={sub}>{t('roadmap.birth.failedBody')}</p>
            <button type="button" className="birth-plant" onClick={() => setPhase('naming')}>{t('roadmap.birth.retry')}</button>
          </>
        ) : (
          <>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('roadmap.birth.name')}
              disabled={planting}
              aria-label={t('roadmap.birth.name')}
              style={nameInput}
            />
            <div style={hint}>
              {planting ? t('roadmap.birth.planting') : t('roadmap.birth.enterPlants', { key: <kbd style={kbd}>↵</kbd> })}
            </div>
            {breakpoint !== 'desktop' && (
              <button type="button" className="birth-plant" onClick={plant} disabled={planting}>{t('roadmap.birth.plant')}</button>
            )}
            {!planting && !composerOpen && (
              <div style={hint}>
                {breakpoint !== 'phone' ? t('roadmap.birth.orPasteAnywhere', { paste: pasteDoor }) : t('roadmap.birth.orPaste', { paste: pasteDoor })}
              </div>
            )}
          </>
        )}
      </div>

      {composing && parse && breakpoint !== 'phone' && (
        <div className={`birth-ghost-stage${breakpoint === 'desktop' ? '' : ' birth-ghost-stage--wide'}`}>
          <GhostSkeleton nodes={parse.nodes} />
        </div>
      )}

      {composing && parse && (breakpoint === 'desktop' ? (
        <aside className="birth-composer" style={{ width: DOCK_WIDTH }}>{composer}</aside>
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
  track('birth', { import: true, steps: countBucket(plan.nodes.length), local: true });
  return treeId;
}

const shell = { position: 'fixed', inset: 0, background: 'var(--surface-canvas)', fontFamily: 'var(--font-body)', color: 'var(--text-primary)' };
const plaque = { position: 'absolute', top: 'var(--space-6)', left: 'var(--space-6)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', background: 'color-mix(in srgb, var(--surface-card) 88%, transparent)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-full)', boxShadow: 'var(--shadow-sm)' };
const plaqueLink = { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', textDecoration: 'none', color: 'inherit' };
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
  .birth-paste-door { border:none; background:none; padding:0; cursor:pointer; font-family:inherit;
                      font-size:inherit; font-weight:700; color:var(--text-secondary); }
  .birth-paste-door:hover { color:var(--text-primary); }
  @media (prefers-reduced-motion: reduce) { .birth-bud { animation:none !important; } }
`;
