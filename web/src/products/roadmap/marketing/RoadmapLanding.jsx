// The roadmap's landing at /roadmap. The live moat — a self-playing demo tree, three
// how-it-works beats, developer quest thumbnails — comes from treeScenes.js; the rest reuses the
// app's Button/Badge. The family chrome (nav, auth cluster, legal shelf, Feedback door) comes from
// the shell's LandingPage, so what lives here is the roadmap's own sections plus the verbs its nav
// wears. CTAs point at the app (Start → #/app/start, the quest shelf — never bare #/app, which
// RESUMES the newest tree; Try the demo → the read-only hosted demo tree).

import React, { useEffect, useRef, useState } from 'react';
import { Button, Badge } from '../../../design-system';
import { LandingPage, useScene } from '../../../shell/marketing/LandingChrome.jsx';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { listTrees } from '../persistence/TreeRegistry.js';
import { track } from '../../../telemetry/beacon.js';
import { mountHero, mountBeat, mountThumb } from './treeScenes.js';
import './roadmapLanding.css';

// This page's own anchors, which the chrome hangs left of the nav divider. The family cross-nav
// right of it is built from the product registry and is none of the roadmap's business.
const SECTION_LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#paths', label: 'Paths' },
  { href: '#/connect', label: 'Connect' },
  { href: '/changelog.html', label: 'Changelog' },
];

const START_CTA = { href: '#/app/start', label: 'Start your tree' };

// The six kind hues roadmapLanding.css bridges to :root — the fact line's dot reads them.
const KIND_DOT = {
  terracotta: 'var(--kind-terracotta)',
  olive: 'var(--kind-olive)',
  gold: 'var(--kind-gold)',
  brick: 'var(--kind-brick)',
  sky: 'var(--kind-sky)',
  plum: 'var(--kind-plum)',
};

function tendedAgo(updatedAt) {
  if (updatedAt == null) return null;
  const then = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  if (Number.isNaN(then)) return null;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
}

// The story-trio glyphs aren't in the app's Icon registry, so they ride as small
// inline lucide-style SVGs (git-fork, monitor-smartphone).
const ICONS = {
  'git-fork': <><circle cx="12" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" /><path d="M12 12v3" /></>,
  'monitor-smartphone': <><path d="M18 8V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h8" /><path d="M10 19v-3.96 3.15M7 19h5" /><rect width="6" height="10" x="16" y="12" rx="2" /></>,
};
function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

// useScene keeps the family's moat rule: the scene is built off the critical path and taken down
// again on the way out. Whether it may *play* is treeScenes' business — an IntersectionObserver
// and document.hidden gate the loop there.
function HeroBand() {
  const ref = useScene((el) => {
    const hero = mountHero(el);
    hero.setAutoplay(true);
    return hero.teardown;
  });
  return <div className="heroBleed" aria-hidden="true"><div ref={ref}></div></div>;
}

function Hero({ resume }) {
  const name = resume ? (resume.title?.trim() || 'Untitled roadmap') : null;
  // Cut by code points, not code units — a surrogate pair (emoji) must never split.
  const chars = name ? Array.from(name) : [];
  const shortName = chars.length > 18 ? `${chars.slice(0, 17).join('').trimEnd()}…` : name;
  const tended = resume ? tendedAgo(resume.updatedAt) : null;
  return (
    <section>
      <div className="wrap" style={{ paddingTop: 40, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Badge tone="brand" dot>Now in public beta</Badge>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(36px, 5.2vw, 60px)', lineHeight: 1.07, color: 'var(--text-primary)', margin: '20px 0 16px', maxWidth: 820, textWrap: 'pretty' }}>
          Any goal, as a skill tree
        </h1>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(16px, 2vw, 20px)', lineHeight: 1.5, color: 'var(--text-secondary)', maxWidth: 620, margin: 0, textWrap: 'pretty' }}>
          Redecorating a room, learning to bake, training for a 10k, or planning a side project — Windmill turns any plan into a living tree. Finish one step and watch the next branch unlock.
        </p>
        {resume ? (
          <>
            <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
              <a href={`#/app/${resume.id}`}><Button variant="primary" size="lg">Resume {shortName}</Button></a>
              <a href={`#/app/${resume.id}`}><Button variant="ghost" size="lg">My trees</Button></a>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8, fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--text-tertiary)', marginTop: 14 }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: KIND_DOT[resume.dominantKind] ?? KIND_DOT.terracotta }} />
              <span>
                {name}{' · '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>{`${resume.done ?? 0}/${resume.total ?? 0}`}</span>
                {' done'}{tended ? ` · last tended ${tended}` : ''}
              </span>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
              <a href="#/app/start"><Button variant="primary" size="lg">Start your tree</Button></a>
              <a href="#/demo"><Button variant="secondary" size="lg">Try the live demo</Button></a>
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--text-tertiary)', marginTop: 14 }}>
              No account needed — your first tree lives in your browser.
            </div>
          </>
        )}
      </div>
      <HeroBand />
    </section>
  );
}

function BeatStage({ kind }) {
  const ref = useScene((el) => mountBeat(el, kind), [kind]);
  return <div className="beatStage" title="Click to replay" aria-hidden="true"><div ref={ref}></div></div>;
}

function HowItWorks() {
  const beats = [
    { kind: 'plant', num: '01', title: 'Map your plan', copy: 'Plant steps by hand — your plan arrives as a tree. Starter quests and paste-a-list are growing in.' },
    { kind: 'finish', num: '02', title: 'Finish a step', copy: 'Mark it done and the fruit ripens — progress you can see from across the room.' },
    { kind: 'unlock', num: '03', title: 'Watch it unlock', copy: 'Light travels the branch. Whatever depended on that step wakes up, ready for you.' },
  ];
  return (
    <section id="how" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">How it works</div>
      <h2 className="sectionTitle">Three beats, over and over</h2>
      <p className="sectionSub">That’s the whole loop. The tree keeps score, so you never wonder what’s next.</p>
      <div className="beats">
        {beats.map(b => (
          <div key={b.kind} className="beat">
            <BeatStage kind={b.kind} />
            <div>
              <div className="beatNum">{b.num}</div>
              <h3 className="beatTitle">{b.title}</h3>
              <p className="beatCopy">{b.copy}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function QuestThumb({ quest }) {
  const ref = useScene((el) => mountThumb(el, quest), [quest]);
  return <div className="questThumb" aria-hidden="true"><div ref={ref}></div></div>;
}

function Paths() {
  const quests = [
    { id: 'frontend', title: 'Frontend path', readout: '24 steps · ~4-6 months', rule: 'var(--kind-terracotta)', dots: ['var(--kind-terracotta)', 'var(--kind-sky)', 'var(--kind-gold)'] },
    { id: 'rust', title: 'Rust from zero', readout: '21 steps · ~3 months', rule: 'var(--kind-brick)', dots: ['var(--kind-brick)', 'var(--kind-olive)', 'var(--kind-gold)'] },
    { id: 'ml', title: 'ML foundations', readout: '26 steps · ~6 months', rule: 'var(--kind-plum)', dots: ['var(--kind-plum)', 'var(--kind-sky)', 'var(--kind-olive)'] },
    { id: 'ship', title: 'Ship v1', readout: '14 steps · ~6 weeks', rule: 'var(--kind-terracotta)', dots: ['var(--kind-terracotta)', 'var(--kind-sky)', 'var(--kind-gold)'] },
  ];
  return (
    <section id="paths" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">For developers</div>
      <h2 className="sectionTitle">Start from a real path</h2>
      <p className="sectionSub">Authored learning trees with real prerequisite logic — ownership gates lifetimes, fundamentals gate frameworks. Pick one and it’s yours to grow.</p>
      <div className="paths">
        {quests.map(q => (
          <a key={q.id} className="questCard" href="#/app/start">
            <div className="questRule" style={{ background: q.rule }}></div>
            <QuestThumb quest={q.id} />
            <div className="questMeta">
              <div>
                <div className="questTitle">{q.title}</div>
                <div className="questReadout">{q.readout}</div>
              </div>
              <div className="questDots">
                {q.dots.map((d, i) => <span key={i} style={{ background: d }}></span>)}
              </div>
            </div>
          </a>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginTop: 20, flexWrap: 'wrap' }}>
        <a href="#/app/start" style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 15 }}>
          Browse all nine starter quests →
        </a>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Three of the dev paths adapted from the roadmap.sh community maps (CC BY-SA).
        </div>
      </div>
    </section>
  );
}

// The MCP surface as a first-class landing beat (F17). Client names — never invented logos —
// carry the identity; the five verbs each wear their node hue; the promise replaces any key,
// and the can't-line draws the trust boundary. Calm copy+layout, no WebGL. CTA → the workbench.
function AiTools() {
  const clients = ['Claude Desktop', 'Claude Code', 'Cursor', 'Codex', 'any MCP client'];
  const verbs = [
    { label: 'plant a roadmap', kind: 'terracotta' },
    { label: 'add & connect steps', kind: 'olive' },
    { label: 'paint with the legend', kind: 'gold' },
    { label: 'mark progress', kind: 'plum' },
    { label: 'read roadmaps', kind: 'sky' },
  ];
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">Build with your AI tools</div>
      <h2 className="sectionTitle">Your agent tends the tree with you</h2>
      <p className="sectionSub">Claude, Cursor, or Codex can plant and tend your roadmaps. Pick your tool, paste one snippet — your browser handles the rest.</p>
      <div className="aiPanel">
        <div className="aiCol">
          <div className="aiLabel">Works with</div>
          <div className="aiClients">
            {clients.map(c => <span key={c} className="aiClient">{c}</span>)}
          </div>
          <p className="aiPromise">First connect opens your browser to approve — no keys to paste.</p>
          <p className="aiCant">It can’t share roadmaps, delete them, or see your chats.</p>
          <div className="aiCta">
            <a href="#/connect"><Button variant="primary" size="lg">Connect your tools</Button></a>
          </div>
        </div>
        <div className="aiCol">
          <div className="aiLabel">Once connected it can</div>
          <div className="aiVerbs">
            {verbs.map(v => (
              <span key={v.label} className="aiVerb">
                <i style={{ background: KIND_DOT[v.kind] }} aria-hidden="true" />{v.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Story() {
  const items = [
    { icon: 'git-fork', title: 'Share a tree', copy: 'Every tree is a page. Send the link — anyone can fork a copy and grow their own.' },
    { icon: 'monitor-smartphone', title: 'Everywhere you are', copy: 'Sign in once and your trees follow — check a step off on your phone, tend the branches at your desk.' },
  ];
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">Why Windmill</div>
      <h2 className="sectionTitle">Made to share, and to sync</h2>
      <div className="trio" style={{ marginTop: 24, gridTemplateColumns: 'repeat(2, 1fr)' }}>
        {items.map(it => (
          <div key={it.title} className="trioItem">
            <div className="trioIcon"><Icon name={it.icon} size={22} /></div>
            <h3 className="trioTitle">{it.title}</h3>
            <p className="trioCopy">{it.copy}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function CtaBand({ planted }) {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="ctaBand">
        <h2 className="sectionTitle" style={{ margin: 0 }}>{planted ? 'Plant another tree' : 'Plant your first tree'}</h2>
        <p className="sectionSub" style={{ maxWidth: 460 }}>It takes about a minute, and the first branch unlocks tonight.</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href={planted ? '#/app/new' : '#/app/start'}><Button variant="primary" size="lg">Start your tree</Button></a>
          <a href="#/demo"><Button variant="ghost" size="lg">Try the live demo</Button></a>
        </div>
      </div>
    </section>
  );
}

// The last tree list this account saw, kept per-email so a returning signed-in tab paints its
// real hero and nav on the first frame instead of the signed-out ones — the registry still
// answers on boot and replaces this. Keyed by email so one device never shows another account's
// trees; a ghost (no email) reads nothing. Pure optimization: never trusted, always refreshed.
const TREES_CACHE_PREFIX = 'windmill:trees:';

function readTreesCache(email) {
  if (!email) return null;
  try {
    const rows = JSON.parse(localStorage.getItem(TREES_CACHE_PREFIX + email) || 'null');
    return Array.isArray(rows) ? rows : null;
  } catch { return null; }
}

function writeTreesCache(email, rows) {
  if (!email) return;
  try { localStorage.setItem(TREES_CACHE_PREFIX + email, JSON.stringify(rows)); }
  catch { /* storage unavailable — the cache is never load-bearing */ }
}

export function RoadmapLanding() {
  const { user, status } = useAuth();
  const [trees, setTrees] = useState(() => readTreesCache(user?.email)); // seeded from cache, then the registry corrects it
  const landed = useRef(false);

  useEffect(() => {
    if (status === 'loading' || landed.current) return;
    landed.current = true;
    track('land', { signedIn: status === 'signed-in' });
  }, [status]);

  // A fresh signed-in status is the one moment the registry gets asked who owns what; every other
  // flip — sign-out included — drops the page back to the verbs a stranger sees.
  useEffect(() => {
    if (status !== 'signed-in') { setTrees(null); return undefined; }
    let cancelled = false;
    listTrees().then((rows) => { if (!cancelled) { setTrees(rows); writeTreesCache(user?.email, rows); } });
    return () => { cancelled = true; };
  }, [status]);

  // Role 9, the roadmap's reading of it: the newest tree is what the nav resumes and what the hero
  // greets you with. No tree yet — signed in or not — and both fall back to Start your tree.
  const newest = status === 'signed-in' && trees?.length ? trees[0] : null;

  // Signed in with the registry still out: we do not yet know whether this account has trees, and
  // "Start your tree" would be claiming zero. The chrome keeps the cluster's box and waits.
  const resolving = status === 'signed-in' && trees === null;

  // The seat's count and its parting line are roadmap sentences — the chrome makes no claim about
  // anybody's trees — so this page says both, or a landing that has nothing true to say says none.
  const seat = { count: trees?.length ?? null, note: 'Signing out keeps your trees on this device.' };

  return (
    <LandingPage
      product="roadmap"
      links={SECTION_LINKS}
      cta={START_CTA}
      resume={newest ? { href: `#/app/${newest.id}`, label: 'My trees' } : null}
      resolving={resolving}
      seat={seat}
    >
      <Hero resume={newest} />
      <HowItWorks />
      <Paths />
      <AiTools />
      <Story />
      <CtaBand planted={Boolean(newest)} />
    </LandingPage>
  );
}
