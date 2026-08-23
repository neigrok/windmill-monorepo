// The journal landing at /journal, on the family chrome.

import React from 'react';
import { Button } from '../../../design-system';
import { LandingPage, useScene } from '../../../shell/marketing/LandingChrome.jsx';
import {
  mountNightWindow,
  mountWriteBeat,
  mountLookBackBeat,
  mountHearBackBeat,
  mountSearchSheet,
} from './journalScenes.js';
import './journalLanding.css';

const SECTION_LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#onlyyou', label: 'Only you' },
  { href: '/changelog.html', label: 'Changelog' },
];
const CTA = { href: '#/journal', label: 'Start writing' };
const RESUME = { href: '#/journal', label: 'Open journal' };

const STAMP = { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' };
const CHECK = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M4.5 12.5l5 5 10-11" />
  </svg>
);

function Hero() {
  return (
    <section>
      <div className="wrap" style={{ paddingTop: 40, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--color-brand-soft)', color: 'var(--lamp-600)', borderRadius: 999, padding: '5px 13px', fontSize: 12.5, fontWeight: 800 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-brand)' }} />
          Now open
        </span>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(36px,5.2vw,60px)', lineHeight: 1.07, color: 'var(--text-primary)', margin: '20px 0 16px', maxWidth: 820, textWrap: 'pretty' }}>
          A place to notice what happened.
        </h1>
        <p style={{ fontSize: 'clamp(16px,2vw,20px)', lineHeight: 1.5, color: 'var(--text-secondary)', maxWidth: 620, margin: 0, textWrap: 'pretty' }}>
          One continuous canvas — oldest at the top, tonight at the bottom, the cursor already waiting. Write to understand yourself, not to score yourself.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href="#/journal"><Button variant="primary" size="lg">Start writing</Button></a>
          <a href="#how"><Button variant="secondary" size="lg">See how it works</Button></a>
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--text-tertiary)', marginTop: 14, maxWidth: 560 }}>
          And there is no share button — not switched off, just not there.
        </div>
      </div>
      <NightWindow />
    </section>
  );
}

// The moat — the one dark region on the landing, carrying the design system's journal dusk scope.
function NightWindow() {
  const ref = useScene(mountNightWindow);
  return (
    <div className="wrap" style={{ marginTop: 44, display: 'flex', justifyContent: 'center' }}>
      <div
        ref={ref}
        data-theme="dark"
        data-brand="journal"
        aria-hidden="true"
        style={{
          width: 'min(820px,100%)', background: 'var(--surface-canvas)', border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-2xl)', boxShadow: '0 24px 60px rgba(4,13,25,.4)',
          padding: 'clamp(24px,4vw,40px) clamp(22px,4.5vw,48px) clamp(28px,4vw,44px)', textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Thursday · 11:41pm</span>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--lamp-400)', boxShadow: '0 0 0 3px rgba(224,185,114,.16)' }} />
        </div>
        <p style={{ fontSize: 16, lineHeight: 1.75, color: 'var(--text-primary)', opacity: .42, margin: '18px 0 0', maxWidth: 600 }}>
          Rain stopped around eight; the street smelled like summer for a minute.
        </p>
        <p style={{ fontSize: 16, lineHeight: 1.75, color: 'var(--text-primary)', margin: '14px 0 0', maxWidth: 600, minHeight: 56 }}>
          <span data-typed>Took the long way home. The kitchen still smelled of coffee, and the light on the counter was worth the extra ten minutes.</span>
          <span className="jn-cursor" />
        </p>
        <div data-echo style={{ marginTop: 20, maxWidth: 600, background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '15px 17px' }}>
          <div style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-secondary)' }}>Walked back past the bakery for no reason except the light. Some detours are the point.</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--lamp-400)', marginTop: 9 }}>07 JAN 2026 · seven months ago</div>
        </div>
      </div>
    </div>
  );
}

function WriteScene() {
  const ref = useScene(mountWriteBeat);
  return (
    <div ref={ref} className="jn-scene" title="Click to replay" aria-hidden="true">
      <div style={STAMP}>Yesterday</div>
      <div style={{ fontSize: 13.5, lineHeight: '22px', color: 'var(--text-primary)', opacity: .45, marginTop: 4 }}>…I could hear what I’d been chewing on all week.</div>
      <div style={{ ...STAMP, color: 'var(--lamp-600)', marginTop: 16 }}>Today</div>
      <div style={{ fontSize: 13.5, lineHeight: '22px', color: 'var(--text-primary)', marginTop: 4, minHeight: 44 }}>
        <span data-typed>Woke early without the alarm.</span>
        <span style={{ display: 'inline-block', width: 2, height: 14, background: 'var(--lamp-600)', marginLeft: 2, verticalAlign: '-2px' }} />
      </div>
    </div>
  );
}

// Three days from the read view, then the canvas pinched down to a year. 0 is a day nobody wrote.
const READ_LINES = [
  { day: 'Jul 22', line: 'Clearest day in weeks. I suspect the answer is boring.' },
  { day: 'Jul 24', line: 'Everyone else seems further along, and I can’t tell.' },
  { day: 'Jul 25', line: 'Long walk with no podcast. The noise dropped a level.' },
];
const YEAR = [
  { month: 'May', days: [5, 4, 0, 6, 4, 0, 0, 4, 2, 5, 4, 0, 6, 5, 4, 2, 0, 4, 5, 4, 6] },
  { month: 'Jun', days: [4, 0, 0, 0, 5, 4, 6, 4, 0, 2, 4, 5, 4, 0, 4, 6, 5, 4, 0, 4, 2] },
  { month: 'Jul', days: [5, 4, 4, 0, 0, 6, 4, 5, 4, 0, 2, 4, 5, 4, 6, 0, 4, 4, 5, 2, 4] },
];

function LookBackScene() {
  const ref = useScene(mountLookBackBeat);
  return (
    <div ref={ref} className="jn-scene" title="Click to replay" aria-hidden="true">
      <div data-read style={{ display: 'none' }}>
        {READ_LINES.map((entry, index) => (
          <div key={entry.day} style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: index === 0 ? 0 : 9 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, textTransform: 'uppercase', color: 'var(--text-tertiary)', width: 44, flex: 'none' }}>{entry.day}</span>
            <span style={{ fontSize: 12.5, lineHeight: '20px', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.line}</span>
          </div>
        ))}
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 14 }}>pinching down…</div>
      </div>
      <div data-year>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>2026 · a year at arm’s length</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 12 }}>
          {YEAR.map((row) => (
            <div key={row.month} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', color: 'var(--text-tertiary)', width: 26, flex: 'none' }}>{row.month}</span>
              <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(21,1fr)', gap: 5 }}>
                {row.days.map((step, index) => (
                  <span key={index} className={step === 0 ? 'jn-day jn-day--empty' : `jn-day jn-day--lamp${step}`} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 14 }}>Hollow means nothing written. Counted at nobody.</div>
      </div>
    </div>
  );
}

// A mood square and three energy ticks per day; a day with no writing gets a hollow square, no lit tick.
const WEEK = [
  { dow: 'M', mood: 'var(--lamp-500)', energy: 2 },
  { dow: 'T', mood: 'var(--lamp-400)', energy: 3 },
  { dow: 'W', mood: null, energy: null },
  { dow: 'T', mood: 'var(--lamp-600)', energy: 1 },
  { dow: 'F', mood: 'var(--lamp-400)', energy: 2 },
  { dow: 'S', mood: 'var(--lamp-200)', energy: 3 },
  { dow: 'S', mood: 'var(--lamp-400)', energy: 2 },
];

function HearBackScene() {
  const ref = useScene(mountHearBackBeat);
  return (
    <div ref={ref} className="jn-scene" title="Click to replay" aria-hidden="true">
      <div style={STAMP}>The week</div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        {WEEK.map((day, index) => (
          <div key={index} className="jn-weekday">
            <span style={{ width: 15, height: 15, borderRadius: 4, background: day.mood ?? undefined, border: day.mood ? undefined : '1px solid var(--neutral-300)' }} />
            <span style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 9 }}>
              {[1, 2, 3].map((step) => (
                <span key={step} style={{ width: 3, height: '100%', borderRadius: 1, background: day.energy && step <= day.energy ? 'var(--accent-olive-500)' : 'var(--neutral-300)' }} />
              ))}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-tertiary)' }}>{day.dow}</span>
          </div>
        ))}
      </div>
      <div data-word>
        <div style={{ fontSize: 13, lineHeight: '20px', color: 'var(--text-primary)', marginTop: 14 }}>6 of 7 days · 812 words</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--lamp-600)', marginTop: 10 }}>Close and write</div>
      </div>
    </div>
  );
}

function HowItWorks() {
  const beats = [
    { num: '01', title: 'Write', Scene: WriteScene, copy: 'The cursor is already waiting. No prompts, no blank-page ritual — yesterday sits just above, in the same ink, and you keep going from where you are.' },
    { num: '02', title: 'Look back', Scene: LookBackScene, copy: 'The same canvas, pinched down to a year. Mood is what survives at that height. The days you didn’t write stay gaps — drawn as gaps, counted at nobody.' },
    { num: '03', title: 'Hear it back', Scene: HearBackScene, copy: 'An echo, or the week, says something true — with the count visible. Six of seven days, and the mood and energy of each. It never interprets. It never advises.' },
  ];
  return (
    <section id="how" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">How it works</div>
      <h2 className="sectionTitle">Write. Look back. Hear it back.</h2>
      <p className="sectionSub">That’s the whole of it — one canvas, and what it gives back.</p>
      <div className="beats">
        {beats.map(({ num, title, Scene, copy }) => (
          <div key={num} className="beat">
            <Scene />
            <div>
              <div className="beatNum">{num}</div>
              <h3 className="beatTitle">{title}</h3>
              <p className="beatCopy">{copy}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SearchSheet() {
  const ref = useScene(mountSearchSheet);
  return (
    <div
      ref={ref}
      title="Click to replay"
      aria-hidden="true"
      style={{ position: 'relative', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-md)', overflow: 'hidden', cursor: 'pointer', textAlign: 'left' }}
    >
      <span style={{ position: 'absolute', top: 12, right: 14, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 5, padding: '3px 7px', background: 'var(--surface-canvas)' }}>Example</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ color: 'var(--color-brand)', display: 'flex' }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </span>
        <span data-typed style={{ fontSize: 16, color: 'var(--text-primary)', minHeight: 22 }}>felt behind</span>
      </div>
      <div style={{ padding: '16px 18px 18px' }}>
        <div style={{ display: 'flex', gap: 14, opacity: .38 }}>
          <span style={{ width: 56, flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', color: 'var(--text-tertiary)', paddingTop: 2 }}>Thu 23</span>
          <span style={{ fontSize: 13.5, lineHeight: '21px', color: 'var(--text-primary)' }}>Made the good soup for no occasion.</span>
        </div>
        <div data-hit style={{ display: 'flex', gap: 14, marginTop: 12 }}>
          <span style={{ width: 56, flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', color: 'var(--lamp-600)', paddingTop: 2 }}>Fri 24</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14.5, lineHeight: '23px', color: 'var(--text-primary)' }}>Everyone at dinner seemed further along. I kept comparing timelines instead of tasting anything.</span>
            <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--lamp-600)', marginTop: 6 }}>close to · everyone</span>
          </span>
        </div>
        <div style={{ display: 'flex', gap: 14, marginTop: 12, opacity: .38 }}>
          <span style={{ width: 56, flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', color: 'var(--text-tertiary)', paddingTop: 2 }}>Sat 25</span>
          <span style={{ fontSize: 13.5, lineHeight: '21px', color: 'var(--text-primary)' }}>Slow morning. The crossword won.</span>
        </div>
      </div>
      <div style={{ padding: '11px 18px', borderTop: '1px solid var(--border-subtle)', fontSize: 12, color: 'var(--text-tertiary)' }}>
        Opening a hit flies the canvas to the spot — neighbours intact, never a detail view.
      </div>
    </div>
  );
}

function Search() {
  return (
    <section id="proof" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">Search</div>
      <h2 className="sectionTitle">Find the feeling, not the word.</h2>
      <p className="sectionSub">Search by meaning — a feeling finds the passage that never used those words.</p>
      <div style={{ maxWidth: 720, margin: '40px auto 0' }}>
        <SearchSheet />
        <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-tertiary)', marginTop: 14 }}>Search runs on your device — the model, the index and your query. Nothing you write is sent anywhere to answer it.</div>
      </div>
    </section>
  );
}

const CAN = [
  'Write on anything with a browser — install it as an app on your phone.',
  'Search by meaning — it runs on your device, and nothing you wrote is sent to answer a query.',
];
const CANT = [
  { lead: 'Share a page.', copy: 'There is no share button — not hidden, not disabled. The data model has no share in it.' },
  { lead: 'Keep your voice.', copy: 'Talk audio is discarded the moment the text lands.' },
  { lead: 'Feed the tree.', copy: 'The agent that helps with your roadmap does not read this room.' },
  { lead: 'Train on your writing.', copy: 'Nothing you write teaches anything.' },
];

function OnlyYou() {
  return (
    <section id="onlyyou" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">Trust</div>
      <h2 className="sectionTitle">Only you</h2>
      <p className="sectionSub">Journal is not a feeder for the tree — the agent does not read your pages. What this room can and can’t do is structure, not policy.</p>
      <div style={{ background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-2xl)', boxShadow: 'var(--shadow-sm)', padding: 'clamp(24px,3vw,36px)', marginTop: 40, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 'clamp(24px,3vw,40px)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Journal can</div>
          {CAN.map((line) => (
            <div key={line} style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--accent-olive-500)', display: 'flex', marginTop: 3 }}>{CHECK}</span>
              <span style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{line}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Journal can’t</div>
          {CANT.map((item) => (
            <div key={item.lead} style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              <b style={{ color: 'var(--text-primary)' }}>{item.lead}</b> {item.copy}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Echoes() {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">The paid layer</div>
      <h2 className="sectionTitle">Echoes</h2>
      <div style={{ maxWidth: 620 }}>
        <p style={{ fontSize: 17, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0, textWrap: 'pretty' }}>
          When tonight rhymes with something you wrote months ago, Journal says it back — the older line itself, its date, and how far back it was: “07 JAN 2026 · seven months ago”. It never interprets. It just remembers with you.
        </p>
        <p style={{ fontSize: 15.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '14px 0 0', textWrap: 'pretty' }}>
          The mark on the page is the same for everyone, and so is the reading that found it — every echo is computed across everything you have ever written, subscribed or not. What One buys is the passage whole: without it the nearest one stops after eight words and the rest are counted out loud, and that older page is still yours to scroll to, free. Talk comes with One too. One is not on sale yet, so there is nothing to buy here today. If One lapses, nothing you wrote is touched — every page and every date stays, and the passages go back to their opening words, as they were before it.
        </p>
      </div>
    </section>
  );
}

const ROOMS = [
  {
    title: 'One account, three rooms',
    copy: 'Roadmap, Journal and Gym — one account across all three, one sign-in, one settings page. No separate sign-ups, no bundle math.',
    glyph: <><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></>,
  },
  {
    title: 'Everywhere you are',
    copy: 'Phone on the nightstand at 11:40pm, desk on Sunday morning. The canvas is the same canvas wherever you open it.',
    glyph: <><path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" /><path d="M10 19v-3.96 3.15" /><path d="M7 19h5" /><rect width="6" height="10" x="16" y="12" rx="2" /></>,
  },
];

function WhyWindmill() {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">Why Windmill</div>
      <h2 className="sectionTitle">Journal is a room, not an app.</h2>
      {/* Two rooms, not three: the family's trio widened to a duo, and phones flatten it. */}
      <div className="trio" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', maxWidth: 900 }}>
        {ROOMS.map((room) => (
          <div key={room.title} className="trioItem">
            <div className="trioIcon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                {room.glyph}
              </svg>
            </div>
            <h3 className="trioTitle">{room.title}</h3>
            <p className="trioCopy">{room.copy}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function WriteTonight() {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="ctaBand">
        <h2 className="sectionTitle" style={{ margin: 0 }}>Write tonight</h2>
        <p className="sectionSub" style={{ maxWidth: 460 }}>The cursor is already waiting. Tonight’s page can be three lines.</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href="#/journal"><Button variant="primary" size="lg">Start writing</Button></a>
          <a href="#how"><Button variant="ghost" size="lg">See how it works</Button></a>
        </div>
      </div>
    </section>
  );
}

export function JournalLanding() {
  return (
    <LandingPage brand="journal" product="journal" links={SECTION_LINKS} cta={CTA} resume={RESUME}>
      <Hero />
      <HowItWorks />
      <Search />
      <OnlyYou />
      <Echoes />
      <WhyWindmill />
      <WriteTonight />
    </LandingPage>
  );
}
