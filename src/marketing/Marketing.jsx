// The marketing landing page (ported from the design system's ui_kits/marketing/index.html).
// The live moat — a self-playing demo tree, three how-it-works beats, developer quest
// thumbnails — comes from treeScenes.js; the rest reuses the app's Button/Badge. The
// design-time tweaks panel is dropped; the "Any goal" headline is fixed. The landing is the
// site root; CTAs point at the app (Start → #/app, Try the demo → the read-only #/t/demo) and
// the X6 sign-in door.

import React, { useEffect, useRef, useState } from 'react';
import { Button, Badge } from '../components';
import { SignInDialog } from '../skilltree/auth/SignInDialog.jsx';
import { requestMagicLink } from '../skilltree/auth/AuthClient.js';
import { mountHero, mountBeat, mountThumb } from './treeScenes.js';
import './marketing.css';

// The three story-trio glyphs aren't in the app's Icon registry, so they ride as small
// inline lucide-style SVGs (git-fork, bot, monitor-smartphone).
const ICONS = {
  'git-fork': <><circle cx="12" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" /><path d="M12 12v3" /></>,
  bot: <><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2M20 14h2M15 13v2M9 13v2" /></>,
  'monitor-smartphone': <><path d="M18 8V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h8" /><path d="M10 19v-3.96 3.15M7 19h5" /><rect width="6" height="10" x="16" y="12" rx="2" /></>,
};
function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

function Nav({ onLogin }) {
  return (
    <header className="wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 24, paddingBottom: 24 }}>
      <a href="#/" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22, color: 'var(--text-primary)' }}>Windmill</a>
      <nav className="navlinks">
        <a href="#how">How it works</a>
        <a href="#paths">Paths</a>
        <a href="#">Changelog</a>
      </nav>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button variant="ghost" size="sm" onClick={onLogin}>Log in</Button>
        <a href="#/app"><Button variant="primary" size="sm">Start your tree</Button></a>
      </div>
    </header>
  );
}

function HeroBand() {
  const ref = useRef(null);
  useEffect(() => {
    const ctrl = mountHero(ref.current);
    ctrl.setAutoplay(true);
    return undefined;
  }, []);
  return <div className="heroBleed"><div ref={ref}></div></div>;
}

function Hero() {
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
        <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href="#/app"><Button variant="primary" size="lg">Start your tree</Button></a>
          <a href="#/t/demo"><Button variant="secondary" size="lg">Try the live demo</Button></a>
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--text-tertiary)', marginTop: 14 }}>
          No account needed — your first tree lives in your browser.
        </div>
      </div>
      <HeroBand />
    </section>
  );
}

function BeatStage({ kind }) {
  const ref = useRef(null);
  useEffect(() => { mountBeat(ref.current, kind); }, [kind]);
  return <div className="beatStage" title="Click to replay"><div ref={ref}></div></div>;
}

function HowItWorks() {
  const beats = [
    { kind: 'plant', num: '01', title: 'Map your plan', copy: 'Paste a list, pick a starter quest, or plant steps by hand. Depth becomes dependency — your plan arrives as a tree.' },
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
              <div className="beatTitle">{b.title}</div>
              <p className="beatCopy">{b.copy}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function QuestThumb({ quest }) {
  const ref = useRef(null);
  useEffect(() => { mountThumb(ref.current, quest); }, [quest]);
  return <div className="questThumb"><div ref={ref}></div></div>;
}

function Paths() {
  const quests = [
    { id: 'frontend', title: 'Frontend path', readout: '24 steps · ~4 months', rule: 'var(--kind-terracotta)', dots: ['var(--kind-terracotta)', 'var(--kind-sky)', 'var(--kind-gold)'] },
    { id: 'rust', title: 'Rust from zero', readout: '21 steps · ~3 months', rule: 'var(--kind-brick)', dots: ['var(--kind-brick)', 'var(--kind-olive)', 'var(--kind-gold)'] },
    { id: 'ml', title: 'ML foundations', readout: '26 steps · ~4 months', rule: 'var(--kind-plum)', dots: ['var(--kind-plum)', 'var(--kind-sky)', 'var(--kind-olive)'] },
    { id: 'ship', title: 'Ship v1.0', readout: '14 steps · ~6 weeks', rule: 'var(--kind-terracotta)', dots: ['var(--kind-terracotta)', 'var(--kind-sky)', 'var(--kind-gold)'] },
  ];
  return (
    <section id="paths" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">For developers</div>
      <h2 className="sectionTitle">Start from a real path</h2>
      <p className="sectionSub">Authored learning trees with real prerequisite logic — ownership gates lifetimes, fundamentals gate frameworks. Pick one and it’s yours to grow.</p>
      <div className="paths">
        {quests.map(q => (
          <a key={q.id} className="questCard" href="#/app">
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
        <a href="#/app" style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 15 }}>
          Browse all nine starter quests →
        </a>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Dev paths adapted from the roadmap.sh community maps (CC BY-SA).
        </div>
      </div>
    </section>
  );
}

function Story() {
  const items = [
    { icon: 'git-fork', title: 'Share a tree', copy: 'Every tree is a page. Send the link or post the picture — anyone can fork a copy and grow their own.' },
    { icon: 'bot', title: 'Build it with your tools', copy: 'Windmill speaks MCP, so Claude, Cursor, or any agent can plant and tend a tree with you.' },
    { icon: 'monitor-smartphone', title: 'Everywhere you are', copy: 'Sign in once and your trees follow — check a step off on your phone, tend the branches at your desk.' },
  ];
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="trio" style={{ marginTop: 0 }}>
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

function CtaBand() {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="ctaBand">
        <h2 className="sectionTitle" style={{ margin: 0 }}>Plant your first tree</h2>
        <p className="sectionSub" style={{ maxWidth: 460 }}>It takes about a minute, and the first branch unlocks tonight.</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href="#/app"><Button variant="primary" size="lg">Start your tree</Button></a>
          <a href="#/t/demo"><Button variant="ghost" size="lg">Try the live demo</Button></a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="wrap" style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 80, paddingTop: 32, paddingBottom: 32, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, color: 'var(--text-tertiary)', fontSize: 14, fontFamily: 'var(--font-body)' }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text-secondary)' }}>Windmill</span>
        © 2026
      </div>
      <div style={{ display: 'flex', gap: 24, fontSize: 14, fontFamily: 'var(--font-body)' }}>
        <a href="#" style={{ color: 'var(--text-tertiary)' }}>Privacy</a>
        <a href="#" style={{ color: 'var(--text-tertiary)' }}>Terms</a>
        <a href="#" style={{ color: 'var(--text-tertiary)' }}>Twitter</a>
      </div>
    </footer>
  );
}

export default function Marketing() {
  const [signInOpen, setSignInOpen] = useState(false);
  return (
    <div className="wm-landing" style={{ fontFamily: 'var(--font-body)' }}>
      <Nav onLogin={() => setSignInOpen(true)} />
      <Hero />
      <HowItWorks />
      <Paths />
      <Story />
      <CtaBand />
      <Footer />
      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} onSend={requestMagicLink} />
    </div>
  );
}
