// The quest shelf (F5) — nine calm doors and a dashed one; the inventory is the pitch.
// First run's gallery route (#/app/start) renders it full-bleed: wordmark, "Start a
// quest", the dev wedge row, the breadth row with the bring-your-own card pinned last.
// A card is a seed packet — kind rule, the quest's real layout, a humble readout — and
// clicking ANYWHERE plants it through the birth canvas's two roads (registry when
// signed in, local soil otherwise). Ceremony #04, approximated: the shelf yields 150ms,
// the picked thumbnail IS the seed and eases to viewport center over 600ms while the
// plant request runs in parallel; the root crowns at ~90% settle, and the arrival
// (ceremony #3 proper) plays on the other side of the navigation. Nothing here animates
// at rest but the crown's one resting breath.

import React, { useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { createTree } from '../persistence/TreeRegistry.js';
import { stampBorn } from '../persistence/ViewPrefs.js';
import { bearImportedTree } from '../sync/localTrees.js';
import { useViewMode } from '../ui/useViewMode.js';
import { track } from '../../telemetry/beacon.js';
import { NODE_COLORS, DEFAULT_NODE_COLOR } from '../theme.js';
import { QuestThumb } from './QuestThumb.jsx';
import { ROSTER } from './roster/index.js';

const PLANTED_QUEST_KEY = 'windmill:planted-quest';
const SEED_EASE_MS = 600;
const CROSSFADE_MS = 280;   // canon §06's reduced-motion beat — the navigation waits for it
const MINT_TIMEOUT_MS = 10000;  // past this the server isn't answering; fail loud, not blank

const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function QuestShelf() {
  const { status } = useAuth();
  const { breakpoint } = useViewMode();
  const [pickedId, setPickedId] = useState(null);
  const [seed, setSeed] = useState(null); // { id, dx, dy } — the picked thumb's ease to viewport center
  const [failed, setFailed] = useState(false);
  const [ghostSplit, setGhostSplit] = useState(false); // narrow ghost card, opened into its two doors
  const thumbRefs = useRef(new Map());
  const pickingRef = useRef(false);  // the plant guard — synchronous, unlike the state it mirrors

  // The two roads, mirroring the birth canvas's plantImported: the registry seeds
  // structure + legend from the post when signed in; the local soil bears it otherwise
  // or when the server can't answer. The root arrives crowned (icon like any birth).
  async function mintTree(quest) {
    const plan = {
      title: quest.title,
      nodes: [{ ...quest.nodes[0], icon: 'sparkles' }, ...quest.nodes.slice(1)],
      kinds: quest.kinds,
    };
    if (status === 'signed-in') {
      try {
        const { treeId } = await createTree({ title: plan.title, nodes: plan.nodes, kinds: plan.kinds });
        track('birth', { quest: quest.id, steps: plan.nodes.length });
        return treeId;
      } catch (err) {
        if (err.code !== 'unauthenticated' && err.code !== 'unreachable') throw err;
      }
    }
    const treeId = await bearImportedTree(plan);
    track('birth', { quest: quest.id, steps: plan.nodes.length, local: true });
    return treeId;
  }

  // Card → plant (canon §04, documented approximation): the shelf fades 150ms, the
  // thumbnail eases 600ms to center while the mint runs in PARALLEL, and we navigate
  // when both have landed — the arrival ceremony picks up the seed on the far side.
  // Reduced motion: one simultaneous 280ms cross-fade, navigate the moment the id exists.
  async function plant(quest) {
    if (pickingRef.current) return;  // a ref, not state: two clicks in one tick must never mint twice
    pickingRef.current = true;
    setFailed(false);
    // A mint that never answers would leave the shelf faded to nothing, forever: race it.
    const mint = Promise.race([
      mintTree(quest),
      new Promise((_, reject) => setTimeout(() => reject(new Error('mint timed out')), MINT_TIMEOUT_MS)),
    ]);
    const thumb = thumbRefs.current.get(quest.id);
    if (!reduced() && thumb) {
      const rect = thumb.getBoundingClientRect();
      setSeed({
        id: quest.id,
        dx: window.innerWidth / 2 - (rect.left + rect.width / 2),
        dy: window.innerHeight / 2 - (rect.top + rect.height / 2),
      });
    }
    setPickedId(quest.id);
    // Both beats are floors, not races: a local plant lands in ~20ms, and navigating on it
    // would cut the reduced-motion cross-fade off ~10% in — the hard cut §06 exists to prevent.
    const ease = new Promise((resolve) => setTimeout(resolve, reduced() ? CROSSFADE_MS : SEED_EASE_MS));
    try {
      const [treeId] = await Promise.all([mint, ease]);
      try { sessionStorage.setItem(PLANTED_QUEST_KEY, '1'); } catch { /* the toast just says Roadmap */ }
      stampBorn(treeId); // a quest's first open is the canvas — the arrival cascade plays there (X8 L1)
      window.location.hash = `#/app/${treeId}`;
    } catch {
      setSeed(null);
      setPickedId(null);
      pickingRef.current = false;
      setFailed(true); // both roads refused — the cards fade back and the quiet line speaks
    }
  }

  const dev = ROSTER.filter((quest) => quest.audience === 'dev');
  const life = ROSTER.filter((quest) => quest.audience !== 'dev');
  const planting = pickedId !== null;
  const shelfClass = [
    'quest-shelf',
    planting && (reduced() ? 'quest-shelf--crossfade' : 'quest-shelf--planting'),
  ].filter(Boolean).join(' ');

  const card = (quest) => {
    const rule = (NODE_COLORS[quest.kinds[0]?.hue] ?? NODE_COLORS[DEFAULT_NODE_COLOR]).base;
    const picked = pickedId === quest.id;
    const seeding = picked && seed?.id === quest.id;
    return (
      <button
        key={quest.id}
        type="button"
        className={`quest-card${picked ? ' quest-card--picked' : ''}`}
        onClick={() => plant(quest)}
        aria-label={`Plant ${quest.title}`}
      >
        <span className="quest-card-chrome quest-card-rule" style={{ background: rule }} />
        <span
          ref={(el) => { if (el) thumbRefs.current.set(quest.id, el); else thumbRefs.current.delete(quest.id); }}
          className={`quest-thumb-wrap${seeding ? ' quest-seed' : ''}`}
          style={seeding ? { transform: `translate(${seed.dx}px, ${seed.dy}px) scale(1.3)` } : undefined}
        >
          <QuestThumb quest={quest} />
        </span>
        <span className="quest-card-chrome quest-card-title">{quest.title}</span>
        <span className="quest-card-chrome quest-card-readout">{quest.nodes.length} steps · {quest.estimate}</span>
        <span className="quest-card-chrome quest-card-dots" aria-hidden="true">
          {quest.kinds.map((kind) => (
            <span key={kind.id} style={{ background: (NODE_COLORS[kind.hue] ?? NODE_COLORS[DEFAULT_NODE_COLOR]).base }} />
          ))}
        </span>
      </button>
    );
  };

  // The bring-your-own card (canon §05): dashed — the bud's not-yet-a-tree language —
  // last but full-size, a peer. Narrow racks collapse it to one door that splits on click.
  const ghost = (
    <div className="quest-card quest-card--ghost">
      <span className="quest-ghost-bud" aria-hidden="true" />
      {breakpoint === 'phone' && !ghostSplit ? (
        <button type="button" className="quest-ghost-door" onClick={() => setGhostSplit(true)}>Start your own</button>
      ) : (
        <>
          <button type="button" className="quest-ghost-door" onClick={() => { window.location.hash = '#/app/new'; }}>Blank tree</button>
          <button type="button" className="quest-ghost-door" onClick={() => { window.location.hash = '#/app/new?compose'; }}>Paste a plan</button>
        </>
      )}
    </div>
  );

  return (
    <div className={shelfClass}>
      <style>{CSS}</style>

      {/* The plaque is the way out: bare #/app resolves to your newest tree, or back to
          this shelf when you have none — so a visitor who lands here with trees (the
          landing page links straight in) is never stranded on a one-way door. */}
      <a className="quest-shelf-plaque" href="#/app" title="Your trees">
        <span className="quest-shelf-glyph">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 20v-8" /><path d="M12 12c0-3 2-5 6-5 0 3-2 5-6 5z" /><path d="M12 14c0-2.5-1.7-4-5-4 0 2.5 1.7 4 5 4z" /></svg>
        </span>
        <span className="quest-shelf-wordmark">Windmill</span>
      </a>

      <main className="quest-shelf-main">
        <h1 className="quest-shelf-title">Start a quest</h1>
        <p className="quest-shelf-sub">Pick a tree to plant — or bring your own plan.</p>
        {failed && <p className="quest-shelf-error">Couldn’t plant it just now</p>}

        <section className="quest-row">
          <div className="quest-row-label">For developers</div>
          <div className="quest-grid">{dev.map(card)}</div>
        </section>

        <section className="quest-row">
          <div className="quest-row-label">For everything else</div>
          <div className="quest-grid">{life.map(card)}{ghost}</div>
        </section>

        <footer className="quest-shelf-credit">
          Dev paths adapted from the roadmap.sh community maps (CC BY-SA).
        </footer>
      </main>
    </div>
  );
}

export default QuestShelf;

const CSS = `
  .quest-shelf { position:fixed; inset:0; overflow-y:auto; background:var(--surface-canvas);
                 font-family:var(--font-body); color:var(--text-primary); }
  .quest-shelf-plaque { position:sticky; top:var(--space-6); margin-left:var(--space-6); z-index:5;
                        display:inline-flex; align-items:center; gap:var(--space-2);
                        padding:var(--space-2) var(--space-3);
                        background:color-mix(in srgb, var(--surface-card) 88%, transparent);
                        border:1px solid var(--border-subtle); border-radius:var(--radius-full);
                        box-shadow:var(--shadow-sm); }
  .quest-shelf-glyph { display:inline-flex; align-items:center; justify-content:center;
                       width:26px; height:26px; border-radius:50%;
                       background:var(--color-brand-soft); color:var(--color-brand-hover); }
  .quest-shelf-wordmark { font-family:var(--font-display); font-weight:800; font-size:var(--text-base); }
  .quest-shelf-main { max-width:1080px; margin:0 auto; padding:var(--space-8) var(--space-6) var(--space-10); }
  .quest-shelf-title { font-family:var(--font-display); font-weight:700; font-size:clamp(26px, 3.4vw, 34px);
                       margin:var(--space-6) 0 var(--space-2); }
  .quest-shelf-sub { font-size:var(--text-base); color:var(--text-secondary); margin:0 0 var(--space-2); }
  .quest-shelf-error { font-size:var(--text-sm); color:var(--text-tertiary); margin:0; }
  .quest-row { margin-top:var(--space-8); }
  .quest-row-label { font-weight:700; font-size:var(--text-sm); color:var(--text-secondary);
                     margin-bottom:var(--space-3); }
  .quest-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(216px, 1fr)); gap:var(--space-4); }

  .quest-card { position:relative; display:flex; flex-direction:column; align-items:stretch; gap:6px;
                padding:0; text-align:left; cursor:pointer; font-family:inherit;
                background:var(--surface-card); border:1px solid var(--border-subtle);
                border-radius:var(--radius-xl); box-shadow:var(--shadow-sm); opacity:.82;
                transition:opacity 150ms var(--ease-standard),
                           transform var(--duration-base) var(--ease-soft),
                           box-shadow var(--duration-base) var(--ease-soft),
                           background 150ms var(--ease-standard),
                           border-color 150ms var(--ease-standard); }
  .quest-card:hover { opacity:1; transform:translateY(-2px); box-shadow:var(--shadow-md); }
  .quest-card-rule { height:3px; border-radius:var(--radius-xl) var(--radius-xl) 0 0; }
  .quest-thumb-wrap { display:block; height:148px; margin:8px 14px 0; }
  .quest-thumb { display:block; width:100%; height:100%; }
  .quest-card-title { font-family:var(--font-display); font-weight:700; font-size:var(--text-base);
                      padding:0 14px; }
  .quest-card-readout { font-family:var(--font-mono); font-size:11px; color:var(--text-tertiary);
                        padding:0 14px 14px; }
  .quest-card-dots { position:absolute; right:14px; bottom:14px; display:flex; gap:4px; }
  .quest-card-dots span { width:7px; height:7px; border-radius:50%; }
  .quest-card-chrome { transition:opacity 150ms var(--ease-standard); }

  /* The crown's one resting breath — the only thing on the shelf that moves at rest.
     hue.glow carries α .5, so opacity .56 reads as the canonical α .28 peak. */
  .quest-thumb-halo { opacity:.56; animation:quest-halo-breathe var(--duration-glow) var(--ease-glow) infinite; }
  @keyframes quest-halo-breathe { 0%,100% { opacity:.28; } 50% { opacity:.56; } }

  /* Ceremony §04: the shelf yields, the picked card sheds its chrome, the thumb is the seed. */
  .quest-shelf--planting .quest-card { pointer-events:none; }
  .quest-shelf--planting .quest-card:not(.quest-card--picked) { opacity:0; }
  .quest-card--picked { z-index:10; background:transparent; border-color:transparent; box-shadow:none; }
  .quest-card--picked .quest-card-chrome { opacity:0; }
  .quest-seed { position:relative; z-index:10; transition:transform ${SEED_EASE_MS}ms var(--ease-soft); }
  .quest-seed .quest-thumb-halo { animation:quest-crown-wake 180ms var(--ease-standard) ${Math.round(SEED_EASE_MS * 0.9)}ms forwards; }
  @keyframes quest-crown-wake { to { opacity:1; } }

  /* Reduced motion (canon §06): one simultaneous cross-fade; crown frozen at α .28. */
  .quest-shelf--crossfade .quest-card { pointer-events:none; animation:quest-fade-out var(--duration-base) var(--ease-standard) forwards; }
  @keyframes quest-fade-out { to { opacity:0; } }

  .quest-card--ghost { align-items:center; justify-content:center; gap:10px; cursor:default;
                       min-height:236px; background:transparent; box-shadow:none;
                       border:2px dashed var(--accent-terracotta-400); }
  .quest-card--ghost:hover { transform:none; box-shadow:none; }
  .quest-ghost-bud { width:28px; height:28px; border-radius:50%; box-sizing:border-box;
                     border:2px dashed var(--accent-terracotta-400); background:var(--color-brand-soft); }
  .quest-ghost-door { display:inline-flex; align-items:center; justify-content:center;
                      min-height:44px; border:none; background:none; padding:10px 16px; cursor:pointer;
                      font-family:var(--font-display); font-weight:700; font-size:var(--text-base);
                      color:var(--text-secondary); border-radius:var(--radius-md);
                      transition:color 150ms var(--ease-standard), background 150ms var(--ease-standard); }
  .quest-ghost-door:hover { color:var(--text-primary); }

  @media (max-width: 743px) {
    .quest-ghost-door { align-self:stretch; width:100%; background:var(--color-brand-soft);
                        color:var(--text-primary); }
  }

  .quest-shelf-credit { margin-top:var(--space-8); font-size:12px; color:var(--text-tertiary); }

  @media (prefers-reduced-motion: reduce) {
    .quest-card { transition:none; }
    .quest-card:hover { transform:none; box-shadow:var(--shadow-sm); }
    .quest-thumb-halo { animation:none !important; opacity:.56; }
    .quest-seed { transition:none; transform:none !important; }
  }
`;
