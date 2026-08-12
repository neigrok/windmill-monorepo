// The gym landing at /gym — ported from the static public/gym/index.html the 2026-08-01
// landing-family build produced from canon (marketing/briefs-landings/03-gym-landing.md).
// Same sections, same copy, same numbers, same timings; what changed is the runtime. Nav,
// footer and the sign-in door now come from the family chrome, so a signed-in lifter is
// recognised on the first frame and Sign in opens the door in place instead of navigating to
// /?signin#/gym — the URL that rendered the dark GymApp under a black-on-black modal.
//
// The page describes the product and never dates itself against `shell.status` (products/gym/
// routes.js). It carried the pre-open carve-out until 2026-08-07 — an "In design" badge, a hero
// that pointed at what was already open, and a promise that gym "joins the same account when it
// opens" — and every one of those had stopped being true: the log, the logger, routines, the
// finish, statistics, the coach share, the CSV and the MCP tools are all built and reachable at
// #/gym, on the account this page names. The one verb is that same door, and it was the same door
// across the flip to 'open' on 2026-08-08: #/gym renders the log and now upgrades in place to
// /app/gym.
//
// The nav's verb is a RESUME and not a CTA, which is the one place the account shows through the
// copy: gym answers a visitor with no account with a sign-in pitch, so the nav offers the log to
// somebody it will open for and offers everyone else Sign in. The hero keeps its door for both and
// says the precondition in the line directly under it.

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

// The hero's verb, and the nav's for a lifter the door already opens for. One href in three places
// on this page, because it is one door.
const LOG_HREF = '#/gym';
const OPEN_LOG = 'Open your training log →';
const RESUME = { href: LOG_HREF, label: 'Open your log' };
const ACCOUNT_LINE = 'Your log lives on your Windmill account — one account and one subscription across Roadmap, Journal and Gym.';

const PANEL_LABEL = {
  fontSize: 11, fontWeight: 800, letterSpacing: '.09em',
  textTransform: 'uppercase', color: 'var(--text-tertiary)',
};

// The five lifts that have an honest one-rep estimate, and the one that does not. A chin-up at
// bodyweight logs a load of zero, and Epley has no answer at or below zero — so the statistics tab
// draws that movement on the reps of its top set and prints no estimate at all (products/gym/
// stats.js). This card says the same thing, because a landing that promised "chins · BW+20 e1RM"
// was promising a number the product had already decided it would not invent: bodyweight is stored
// nowhere in gym, so nothing here can be computed over it.
const LIFTS = [
  { name: 'Squat', value: '140', unit: 'e1RM', d: 'M4,38 L20,36 L36,32 L52,33 L68,28 L84,25 L100,26 L116,21 L132,18 L148,19 L164,13 L176,10', cy: 10 },
  { name: 'Bench', value: '100', unit: 'e1RM', d: 'M4,37 L20,35 L36,34 L52,30 L68,29 L84,25 L100,26 L116,22 L132,20 L148,17 L164,15 L176,12', cy: 12 },
  { name: 'Deadlift', value: '170', unit: 'e1RM', d: 'M4,39 L20,35 L36,34 L52,29 L68,27 L84,27 L100,22 L116,20 L132,16 L148,15 L164,11 L176,8', cy: 8 },
  { name: 'Press', value: '62.5', unit: 'e1RM', d: 'M4,36 L20,35 L36,35 L52,31 L68,31 L84,28 L100,28 L116,24 L132,24 L148,21 L164,20 L176,17', cy: 17 },
  { name: 'Rows', value: '90', unit: 'e1RM', d: 'M4,37 L20,34 L36,33 L52,30 L68,29 L84,26 L100,25 L116,22 L132,21 L148,18 L164,16 L176,14', cy: 14 },
  { name: 'Chins', value: '11', unit: 'top set', d: 'M4,38 L20,37 L36,33 L52,32 L68,30 L84,26 L100,27 L116,23 L132,22 L148,19 L164,17 L176,15', cy: 15 },
];

const MCP_CLIENTS = ['Claude Desktop', 'Claude Code', 'Cursor', 'Codex', 'any MCP client'];

const AGENT_CAN = [
  'Read your last twelve weeks of squats.',
  'Draft next block’s progression.',
  'Propose next week’s routine — you read the diff and tap Apply.',
];

// THE GRANT IS THE REAL SAFETY MODEL, AND IT IS NOT THE WHOLE OF IT. Three separate levels,
// approved one at a time, and a level you did not approve is a tool the connection cannot even see
// in its own tool list. What no level buys is a change to a day of the program you ALREADY have: a
// mutation that takes nothing away lands immediately — a set, a session, a movement, a day that did
// not exist until now — and a mutation that rewrites or removes a day that already stands mints a
// proposal that does nothing until you tap Apply on the diff (backend §2.9, GymToolCatalog's own
// `create_routine` / `propose_routine_change` split). So `write` and `delete` are named here by what
// they actually do — creating a new day INCLUDED, because a level line that named only the
// proposing half would be selling a safety property this product does not have.
const GRANT_LEVELS = [
  { scope: 'gym:read', line: 'Read your log', granted: true },
  { scope: 'gym:write', line: 'Record what happened · add a new day · propose changes to the days you have', granted: true },
  { scope: 'gym:delete', line: 'Discard a workout · end a coach link · propose a removal', granted: false },
];

const BRAND_DUO = [
  {
    title: 'One account, three rooms',
    copy: 'Roadmap, Journal and Gym — one account, one subscription, one history.',
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
      <div ref={ref} className="gyw gyMoat" data-theme="dark" data-brand="gym" aria-hidden="true">

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
                <span data-gy="weight">97.5</span><span style={{ fontSize: 19, color: 'var(--gym-ink-faint)', marginLeft: 6 }}>kg</span>
              </div>
              <div data-gy="note" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--target-ink)', marginTop: 9 }}>last week · 97.5 × 5</div>
              <div data-gy="pr" className="gyFade" style={{ display: 'none', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--gym-ink-dim)', marginTop: 7 }}>100 × 5 — best yet.</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <span className="gychip">−10</span>
                <span className="gychip">−2.5</span>
                <span className="gychip" data-gy="fine">+2.5</span>
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
        <Badge tone="neutral">Barbell training log</Badge>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(36px, 5.2vw, 60px)', lineHeight: 1.07, color: 'var(--text-primary)', margin: '20px 0 16px', maxWidth: 820, textWrap: 'pretty' }}>
          It remembers what you lifted.
        </h1>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(16px, 2vw, 20px)', lineHeight: 1.5, color: 'var(--text-secondary)', maxWidth: 640, margin: 0, textWrap: 'pretty' }}>
          A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, a small jump when it’s time, and the next session opens with last time’s numbers already in the field.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href={LOG_HREF}><Button variant="primary" size="lg">{OPEN_LOG}</Button></a>
          <a href="#how"><Button variant="secondary" size="lg">See how it works</Button></a>
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--text-tertiary)', marginTop: 14 }}>
          {ACCOUNT_LINE}
        </div>
      </div>
      <Moat />
    </section>
  );
}

function LadderStage() {
  const ref = useScene(mountSetLogger);
  return (
    <div ref={ref} className="gyw gyStage" data-theme="dark" data-brand="gym" title="Click to replay" aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <span className="gychip gychip--sm">−10</span>
        <span className="gychip gychip--sm">−2.5</span>
        <span className="gychip gychip--sm" data-gy="s1fine">+2.5</span>
        <span className="gychip gychip--sm">+10</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 34, color: 'var(--weight-ink)' }}>
          <span data-gy="s1w">100</span><span style={{ fontSize: 13, color: 'var(--gym-ink-faint)', marginLeft: 4 }}>kg</span>
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--gym-ink-dim)' }}>× <span data-gy="s1r">5</span></span>
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--gym-ink-faint)', textAlign: 'center' }}>
        the small step is your program step · the big one is a plate change
      </div>
    </div>
  );
}

function RememberedStage() {
  const ref = useScene(mountRemembered);
  return (
    <div ref={ref} className="gyw gyStage" data-theme="dark" data-brand="gym" title="Click to replay" aria-hidden="true"
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
    <div ref={ref} className="gyw gyStage" data-theme="dark" data-brand="gym" title="Click to replay" aria-hidden="true"
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
            <p className="beatCopy">Two taps between sets. Big targets for one thumb and chalked hands — the small step is the 2.5 kg your program is written in, the big one is a plate change.</p>
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
        Squat, bench, deadlift, press, rows — e1RM per lift, week over week. e1RM is estimated one-rep max (Epley: weight × (1 + reps/30)).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 20, marginTop: 40 }}>
        {LIFTS.map((lift) => (
          <div key={lift.name} className="gyw gycard" data-theme="dark" data-brand="gym">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15.5, color: 'var(--gym-ink)' }}>{lift.name}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 17, color: 'var(--weight-ink)' }}>
                {lift.value}<span style={{ fontSize: 10, color: 'var(--gym-ink-faint)', marginLeft: 3 }}>{lift.unit}</span>
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
        Example: twelve weeks of a linear cycle. Chins here carry no added load, so Epley has no answer for them — they are drawn on the reps of the top set instead, and no estimate is invented over a bodyweight the log does not hold.
      </div>
    </section>
  );
}

// THE SECTION THAT PRICES THE PRODUCT, so it is the section a wave can most easily make lie. Until
// W7 it sold a coach panel under one finished workout, gated on Windmill One: that panel is deleted
// and Ask stands where it stood, over the WHOLE log rather than one workout, open to everyone with a
// daily cap the room states in words (backend AskService: no plan predicate, kAskPerDay = 10). So
// both halves of the old sentence had to go — the feature and the price — and what replaced them is
// the one honest reading: nothing in gym is behind a plan, because nothing in Windmill can be bought
// (shell/billing/checkout.js `paidPlansOpen()` is a hardcoded false).
//
// Ask can also PROPOSE, which the panel could not — its grant is the reads plus the two tools that
// mint a proposal — so a line calling it read-only would be a safety promise that is nearly true,
// which is worth less than none.
function ConnectedLog() {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">The connected log</div>
      <h2 className="sectionTitle">Your log is an endpoint your own AI tools can use.</h2>
      <p className="sectionSub">The log is free — all of it, and so are these tools. So is Ask, the room in the app for a lifter who hasn’t got an agent of their own — about ten questions a day, and nothing in Gym is on sale.</p>
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
            It reads, it proposes, and it never rewrites a day you already have. That routine changes when
            you tap Apply on the diff — all of it or none — and never a moment before. A brand-new day it
            adds lands right away: it takes nothing away, and you can edit or delete it yourself.
          </p>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, color: 'var(--text-secondary)', margin: 0 }}>
            You decide what a connection may do — read, write, delete — and it can only see the tools for the
            levels you approved. Delete is never implied by write.
          </p>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, color: 'var(--text-secondary)', margin: 0 }}>
            No agent of your own? Ask is a room in the app, over the same tools and the same rules — it reads
            your whole log and it proposes, and a change it writes is the same diff you tap Apply on. Every
            answer says what it read: which tools it called, and how many of your rows they served. It can’t
            log a set, correct one you lifted, or delete anything.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={PANEL_LABEL}>You approve each level</div>
          <div className="gyw gycard" data-theme="dark" data-brand="gym">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--gym-ink-faint)' }}>connect · Claude Code</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--gym-ink-faint)' }}>gym</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 12 }}>
              {GRANT_LEVELS.map((level) => (
                <div key={level.scope} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 17, height: 17, borderRadius: 5, border: `1px solid ${level.granted ? 'var(--color-brand)' : 'var(--gym-line-strong)'}`, background: level.granted ? 'var(--color-brand)' : 'transparent', color: 'var(--gym-on-accent)' }}>
                    {level.granted && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: level.granted ? 'var(--gym-ink)' : 'var(--gym-ink-faint)', minWidth: 82 }}>{level.scope}</span>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: level.granted ? 'var(--gym-ink-dim)' : 'var(--gym-ink-faint)' }}>{level.line}</span>
                </div>
              ))}
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: 1.5, color: 'var(--gym-ink-faint)', marginTop: 14 }}>
              This connection was never granted delete, so it cannot see the three tools that discard a workout,
              end a coach link, or ask to remove a routine.
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
        <h2 className="sectionTitle" style={{ margin: 0 }}>Log the next one</h2>
        <p className="sectionSub" style={{ maxWidth: 480 }}>{ACCOUNT_LINE}</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href={LOG_HREF}><Button variant="primary" size="lg">{OPEN_LOG}</Button></a>
        </div>
      </div>
    </section>
  );
}

export function GymLanding() {
  return (
    <LandingPage brand="gym" product="gym" links={SECTION_LINKS} cta={null} resume={RESUME}>
      <Hero />
      <HowItWorks />
      <ForTheBarbell />
      <ConnectedLog />
      <PartOfWindmill />
      <CtaBand />
    </LandingPage>
  );
}
