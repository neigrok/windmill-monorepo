// The gym landing at /gym — ported from the static public/gym/index.html the 2026-08-01
// landing-family build produced from canon (marketing/briefs-landings/03-gym-landing.md).
// Same sections, same copy, same numbers, same timings; what changed is the runtime. Nav,
// footer and the sign-in door now come from the family chrome, so a signed-in lifter is
// recognised on the first frame and Sign in opens the door in place instead of navigating to
// /?signin#/gym — the URL that rendered the dark GymApp under a black-on-black modal.
//
// Gym is pre-open, so canon's carve-out applies: no primary CTA verb, no resume verb. The
// hero points at what is already open rather than promising a log nobody can start.

import React from 'react';
import { Badge, Button } from '../../../design-system';
import { LandingPage, useScene } from '../../../shell/marketing/LandingChrome.jsx';
import { mountMoat, mountSetLogger, mountRemembered, mountE1rmLine } from './gymScenes.js';
import './gymLanding.css';

const SECTION_LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#proof', label: 'For the barbell' },
  { href: '/changelog.html', label: 'Changelog' },
];

const PANEL_LABEL = {
  fontSize: 11, fontWeight: 800, letterSpacing: '.09em',
  textTransform: 'uppercase', color: 'var(--text-tertiary)',
};

const LIFTS = [
  { name: 'Squat', e1rm: '140', d: 'M4,38 L20,36 L36,32 L52,33 L68,28 L84,25 L100,26 L116,21 L132,18 L148,19 L164,13 L176,10', cy: 10 },
  { name: 'Bench', e1rm: '100', d: 'M4,37 L20,35 L36,34 L52,30 L68,29 L84,25 L100,26 L116,22 L132,20 L148,17 L164,15 L176,12', cy: 12 },
  { name: 'Deadlift', e1rm: '170', d: 'M4,39 L20,35 L36,34 L52,29 L68,27 L84,27 L100,22 L116,20 L132,16 L148,15 L164,11 L176,8', cy: 8 },
  { name: 'Press', e1rm: '62.5', d: 'M4,36 L20,35 L36,35 L52,31 L68,31 L84,28 L100,28 L116,24 L132,24 L148,21 L164,20 L176,17', cy: 17 },
  { name: 'Rows', e1rm: '90', d: 'M4,37 L20,34 L36,33 L52,30 L68,29 L84,26 L100,25 L116,22 L132,21 L148,18 L164,16 L176,14', cy: 14 },
  { name: 'Chins', e1rm: 'BW+20', d: 'M4,38 L20,37 L36,33 L52,32 L68,30 L84,26 L100,27 L116,23 L132,22 L148,19 L164,17 L176,15', cy: 15 },
];

const MCP_CLIENTS = ['Claude Desktop', 'Claude Code', 'Cursor', 'Codex', 'any MCP client'];

const AGENT_CAN = [
  'Read your last twelve weeks of squats.',
  'Draft next block’s progression.',
  'Propose a routine change.',
];

const BRAND_DUO = [
  {
    title: 'One account, three rooms',
    copy: 'Roadmap and Journal are open today; Gym joins the same account and subscription when it opens.',
    glyph: <><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></>,
  },
  {
    title: 'Everywhere you are',
    copy: 'The phone in the gym, the desk between blocks. Same log.',
    glyph: (
      <>
        <path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" />
        <path d="M10 19v-3.96 3.15" />
        <path d="M7 19h5" />
        <rect width="6" height="10" x="16" y="12" rx="2" />
      </>
    ),
  },
];

function Check({ size = 13, strokeWidth = 2.6, className, style }) {
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 12.5l5 5 10-11" />
    </svg>
  );
}

function SetRow({ n, reps, done, gy, className, style }) {
  return (
    <div className={className ? `gyset ${className}` : 'gyset'} data-gy={gy} style={style}>
      <span style={{ width: 14 }}>{n}</span>
      <span>{reps}</span>
      {done && <Check className="gyck" />}
    </div>
  );
}

function Moat() {
  const ref = useScene(mountMoat);
  return (
    <div className="wrap" style={{ marginTop: 44, display: 'flex', justifyContent: 'center' }}>
      <div ref={ref} className="gyw gyMoat" data-theme="dark" aria-hidden="true">

        <div data-gy="still" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 20 }}>
          <div>
            <div className="gyLabel">Tuesday · week 6</div>
            <div style={{ marginTop: 12, background: 'var(--gym-sunken)', border: '1px solid var(--gym-line)', borderRadius: 'var(--radius-lg)', padding: '6px 14px' }}>
              <SetRow n="1" reps="60 × 8 · warm-up" style={{ borderBottom: '1px solid var(--gym-line)', color: 'var(--warmup-ink)' }} />
              <SetRow n="2" reps="90 × 5" done style={{ borderBottom: '1px solid var(--gym-line)', color: 'var(--gym-ink-dim)' }} />
              <SetRow n="3" reps="95 × 5" done style={{ borderBottom: '1px solid var(--gym-line)', color: 'var(--gym-ink-dim)' }} />
              <SetRow n="4" reps="100 × 5" done style={{ color: 'var(--gym-ink)' }} />
            </div>
          </div>
          <div>
            <div className="gyLabel">Next session · Tuesday · week 7</div>
            <div style={{ marginTop: 12 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 17, color: 'var(--gym-ink)' }}>Squat</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, fontSize: 56, lineHeight: .95, color: 'var(--weight-ink)', marginTop: 8 }}>
                100<span style={{ fontSize: 16, color: 'var(--gym-ink-faint)', marginLeft: 5 }}>kg</span>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--target-ink)', marginTop: 8 }}>last session · 100 × 5 — already in the field</div>
            </div>
          </div>
        </div>

        <div data-gy="live" style={{ display: 'none', transition: 'opacity 280ms var(--ease-standard)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 19, color: 'var(--gym-ink)' }}>Squat</div>
            <div data-gy="session" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gym-ink-faint)' }}>Tuesday · week 6</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, marginTop: 14, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, fontSize: 'clamp(48px,8vw,72px)', lineHeight: .92, color: 'var(--weight-ink)' }}>
                <span data-gy="weight">95</span><span style={{ fontSize: 19, color: 'var(--gym-ink-faint)', marginLeft: 6 }}>kg</span>
              </div>
              <div data-gy="note" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--target-ink)', marginTop: 9 }}>last week · 95 × 5</div>
              <div data-gy="pr" className="gyFade" style={{ display: 'none', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--gym-ink-dim)', marginTop: 7 }}>100 × 5 — best yet.</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <span className="gychip">−10</span>
                <span className="gychip">−5</span>
                <span className="gychip" data-gy="plus5">+5</span>
                <span className="gychip">+10</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="gyrep">−</span>
                <span data-gy="reps" style={{ fontFamily: 'var(--font-mono)', fontSize: 26, color: 'var(--gym-ink)', minWidth: 30, textAlign: 'center' }}>—</span>
                <span className="gyrep">+</span>
              </div>
              <span data-gy="log" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 44, padding: '0 22px', borderRadius: 'var(--radius-lg)', background: 'var(--color-brand)', color: 'var(--gym-on-accent)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 14.5, transition: 'opacity 150ms var(--ease-standard)' }}>Log set</span>
            </div>
          </div>
          <div style={{ marginTop: 18, background: 'var(--gym-sunken)', border: '1px solid var(--gym-line)', borderRadius: 'var(--radius-lg)', padding: '6px 14px' }}>
            <SetRow n="1" reps="60 × 8 · warm-up" style={{ borderBottom: '1px solid var(--gym-line)', color: 'var(--warmup-ink)' }} />
            <SetRow n="2" reps="90 × 5" done style={{ borderBottom: '1px solid var(--gym-line)', color: 'var(--gym-ink-dim)' }} />
            <SetRow n="3" reps="95 × 5" done style={{ color: 'var(--gym-ink-dim)' }} />
            <SetRow n="4" reps="100 × 5" done gy="row4" className="gyFade" style={{ display: 'none', borderTop: '1px solid var(--gym-line)', color: 'var(--gym-ink)' }} />
          </div>
        </div>

      </div>
    </div>
  );
}

function Hero() {
  return (
    <section>
      <div className="wrap" style={{ paddingTop: 40, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Badge tone="neutral" dot>In design</Badge>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(36px, 5.2vw, 60px)', lineHeight: 1.07, color: 'var(--text-primary)', margin: '20px 0 16px', maxWidth: 820, textWrap: 'pretty' }}>
          It remembers what you lifted.
        </h1>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(16px, 2vw, 20px)', lineHeight: 1.5, color: 'var(--text-secondary)', maxWidth: 640, margin: 0, textWrap: 'pretty' }}>
          A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, a small jump when it’s time, and next session opens with last week’s numbers already in the field.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href="/"><Button variant="primary" size="lg">See what’s already open →</Button></a>
          <a href="#how"><Button variant="secondary" size="lg">See how it works</Button></a>
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--text-tertiary)', marginTop: 14 }}>
          Gym joins the same account and subscription when it opens.
        </div>
      </div>
      <Moat />
    </section>
  );
}

function LadderStage() {
  const ref = useScene(mountSetLogger);
  return (
    <div ref={ref} className="gyw gyStage" data-theme="dark" title="Click to replay" aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <span className="gychip gychip--sm">−10</span>
        <span className="gychip gychip--sm">−5</span>
        <span className="gychip gychip--sm" data-gy="s1plus">+5</span>
        <span className="gychip gychip--sm">+10</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 34, color: 'var(--weight-ink)' }}>
          <span data-gy="s1w">100</span><span style={{ fontSize: 13, color: 'var(--gym-ink-faint)', marginLeft: 4 }}>kg</span>
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--gym-ink-dim)' }}>× <span data-gy="s1r">5</span></span>
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--gym-ink-faint)', textAlign: 'center' }}>
        the ladder steps with the load · −10 −5 +5 +10 at this weight
      </div>
    </div>
  );
}

function RememberedStage() {
  const ref = useScene(mountRemembered);
  return (
    <div ref={ref} className="gyw gyStage" data-theme="dark" title="Click to replay" aria-hidden="true"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div data-gy="s2card" className="gyRise" style={{ width: '100%', maxWidth: 240, background: 'var(--gym-surface)', border: '1px solid var(--gym-line)', borderRadius: 'var(--radius-lg)', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--gym-ink)' }}>Squat</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--gym-ink-faint)' }}>Tue · week 7</span>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 34, color: 'var(--weight-ink)', marginTop: 8 }}>
          100<span style={{ fontSize: 13, color: 'var(--gym-ink-faint)', marginLeft: 4 }}>kg</span>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--target-ink)', marginTop: 6 }}>already in the field</div>
      </div>
    </div>
  );
}

function LineStage() {
  const ref = useScene(mountE1rmLine);
  return (
    <div ref={ref} className="gyw gyStage" data-theme="dark" title="Click to replay" aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--gym-ink-faint)' }}>Squat · e1RM</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gym-ink-dim)' }}>12 weeks</span>
      </div>
      <svg viewBox="0 0 240 90" width="100%" height="90" style={{ display: 'block' }}>
        <path data-gy="s3line" d="M8,74 L28,71 L48,66 L68,67 L88,60 L108,55 L128,56 L148,48 L168,43 L188,44 L208,36 L232,28"
          fill="none" stroke="var(--color-brand)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <circle data-gy="s3dot" cx="232" cy="28" r="3.4" fill="var(--color-brand)" />
      </svg>
      <div data-gy="s3cap" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--gym-ink-faint)' }}>137.5 → 140 · one quiet line for a PR</div>
    </div>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">How it works</div>
      <h2 className="sectionTitle">Log the set. The rest is remembered.</h2>
      <p className="sectionSub">Three beats, in the order they happen at the rack.</p>
      <div className="beats">
        <div className="beat">
          <LadderStage />
          <div>
            <div className="beatNum">01</div>
            <h3 className="beatTitle">Log the set</h3>
            <p className="beatCopy">Two taps between sets. Big targets for one thumb and chalked hands — the ladder steps at the size the load calls for.</p>
          </div>
        </div>
        <div className="beat">
          <RememberedStage />
          <div>
            <div className="beatNum">02</div>
            <h3 className="beatTitle">It remembers</h3>
            <p className="beatCopy">Next session opens with last time’s numbers already in the field. You never scroll back to find what you lifted.</p>
          </div>
        </div>
        <div className="beat">
          <LineStage />
          <div>
            <div className="beatNum">03</div>
            <h3 className="beatTitle">See the line</h3>
            <p className="beatCopy">e1RM per lift, week over week — the long line of showing up. A PR gets one line.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function ForTheBarbell() {
  return (
    <section id="proof" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">For lifters</div>
      <h2 className="sectionTitle">Built for the barbell</h2>
      <p className="sectionSub" style={{ maxWidth: 600 }}>
        Squat, bench, deadlift, press, rows, chins — e1RM per lift, week over week. e1RM is estimated one-rep max (Epley: weight × (1 + reps/30)).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 20, marginTop: 40 }}>
        {LIFTS.map((lift) => (
          <div key={lift.name} className="gyw gycard" data-theme="dark">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15.5, color: 'var(--gym-ink)' }}>{lift.name}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 17, color: 'var(--weight-ink)' }}>
                {lift.e1rm}<span style={{ fontSize: 10, color: 'var(--gym-ink-faint)', marginLeft: 3 }}>e1RM</span>
              </span>
            </div>
            <svg aria-hidden="true" viewBox="0 0 180 44" width="100%" height="44" style={{ display: 'block', marginTop: 10 }}>
              <path d={lift.d} fill="none" stroke="var(--color-brand)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="176" cy={lift.cy} r="2.6" fill="var(--color-brand)" />
            </svg>
          </div>
        ))}
      </div>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--text-tertiary)', marginTop: 16 }}>
        Example: twelve weeks of a linear cycle. Chins are added load over bodyweight; their e1RM is computed over bodyweight plus the load.
      </div>
    </section>
  );
}

function ConnectedLog() {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">The connected log</div>
      <h2 className="sectionTitle">Your log is an endpoint your own AI tools can read.</h2>
      <p className="sectionSub">The log is free — all of it. The connected log comes with the paid layer.</p>
      <div style={{ background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-2xl)', boxShadow: 'var(--shadow-sm)', padding: 'clamp(24px,3vw,36px)', marginTop: 40, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 'clamp(24px,3vw,40px)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
          <div style={PANEL_LABEL}>Works with</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {MCP_CLIENTS.map((client) => (
              <span key={client} style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '7px 14px', fontSize: 13.5, fontWeight: 700, color: 'var(--text-secondary)', background: 'var(--surface-canvas)' }}>{client}</span>
            ))}
          </div>
          <div style={{ ...PANEL_LABEL, marginTop: 6 }}>It can</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {AGENT_CAN.map((line) => (
              <div key={line} style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--accent-olive-500)', display: 'flex', marginTop: 3 }}><Check size={15} strokeWidth={2.4} /></span>
                <span style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{line}</span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 15, lineHeight: 1.55, fontWeight: 700, color: 'var(--text-primary)', margin: '6px 0 0' }}>
            Nothing an agent suggests touches your program until you tap Apply. And there is no chatbot in here.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={PANEL_LABEL}>Propose → approve → apply</div>
          <div className="gyw gycard" data-theme="dark">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--gym-ink-faint)' }}>proposed · Claude Code</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--gym-ink-faint)' }}>week 8</span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.9, marginTop: 10 }}>
              <div style={{ color: 'var(--gym-ink-dim)' }}>~ Tuesday · squat</div>
              <div style={{ color: 'var(--alarm-ink)' }}>− 5 × 5 @ 100</div>
              <div style={{ color: 'var(--set-done)' }}>+ 3 × 5 @ 105</div>
              <div style={{ color: 'var(--gym-ink-dim)' }}>~ note: deload Friday holds</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 38, padding: '0 20px', borderRadius: 'var(--radius-lg)', background: 'var(--color-brand)', color: 'var(--gym-on-accent)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13.5 }}>Apply</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--gym-ink-faint)' }}>Nothing changes until you tap it.</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function PartOfWindmill() {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">Why Windmill</div>
      <h2 className="sectionTitle">Part of Windmill</h2>
      <div className="trio" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', maxWidth: 900 }}>
        {BRAND_DUO.map((item) => (
          <div key={item.title} className="trioItem">
            <div className="trioIcon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {item.glyph}
              </svg>
            </div>
            <h3 className="trioTitle">{item.title}</h3>
            <p className="trioCopy">{item.copy}</p>
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
        <h2 className="sectionTitle" style={{ margin: 0 }}>See what’s already open</h2>
        <p className="sectionSub" style={{ maxWidth: 480 }}>Gym joins the same account and subscription when it opens.</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href="/"><Button variant="primary" size="lg">See what’s already open →</Button></a>
        </div>
      </div>
    </section>
  );
}

export function GymLanding() {
  return (
    <LandingPage brand="gym" product="gym" links={SECTION_LINKS} cta={null} resume={null}>
      <Hero />
      <HowItWorks />
      <ForTheBarbell />
      <ConnectedLog />
      <PartOfWindmill />
      <CtaBand />
    </LandingPage>
  );
}
