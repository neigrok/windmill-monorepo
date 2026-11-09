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
import { t } from '../i18n/index.js';

const SECTION_LINKS = [
  { href: '#how', label: t('journal.landing.nav.howItWorks') },
  { href: '#onlyyou', label: t('journal.landing.nav.onlyYou') },
  { href: '/changelog.html', label: t('journal.landing.nav.changelog') },
];
const CTA = { href: '#/journal', label: t('journal.landing.startWriting') };
const RESUME = { href: '#/journal', label: t('journal.landing.openJournal') };

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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--color-brand-soft)', color: 'var(--color-brand)', borderRadius: 999, padding: '5px 13px', fontSize: 12.5, fontWeight: 800 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-brand)' }} />
          {t('journal.landing.hero.badge')}
        </span>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(36px,5.2vw,60px)', lineHeight: 1.07, color: 'var(--text-primary)', margin: '20px 0 16px', maxWidth: 820, textWrap: 'pretty' }}>
          {t('journal.landing.hero.title')}
        </h1>
        <p style={{ fontSize: 'clamp(16px,2vw,20px)', lineHeight: 1.5, color: 'var(--text-secondary)', maxWidth: 620, margin: 0, textWrap: 'pretty' }}>
          {t('journal.landing.hero.sub')}
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href="#/journal"><Button variant="primary" size="lg">{t('journal.landing.startWriting')}</Button></a>
          <a href="#how"><Button variant="secondary" size="lg">{t('journal.landing.seeHow')}</Button></a>
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--text-tertiary)', marginTop: 14, maxWidth: 560 }}>
          {t('journal.landing.hero.trust')}
        </div>
      </div>
      <NightWindow />
    </section>
  );
}

// The moat — the one dark region on the landing, carrying the design system's journal night scope.
function NightWindow() {
  const ref = useScene(mountNightWindow);
  return (
    <div className="wrap" style={{ marginTop: 44, display: 'flex', justifyContent: 'center' }}>
      <div ref={ref} className="jn-moat" data-theme="dark" data-brand="journal" aria-hidden="true">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="jn-moat-stamp" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase' }}>{t('journal.landing.night.stamp')}</span>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--lamp-400)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--lamp-400) 16%, transparent)' }} />
        </div>
        <p style={{ fontSize: 16, lineHeight: 1.75, color: 'var(--text-primary)', opacity: .42, margin: '18px 0 0', maxWidth: 600 }}>
          {t('journal.landing.night.earlier')}
        </p>
        <p style={{ fontSize: 16, lineHeight: 1.75, color: 'var(--text-primary)', margin: '14px 0 0', maxWidth: 600, minHeight: 56 }}>
          <span data-typed>{t('journal.landing.night.tonight')}</span>
          <span className="jn-cursor" />
        </p>
        <div data-echo className="jn-echo" style={{ marginTop: 20, maxWidth: 600, padding: '15px 17px' }}>
          <div style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{t('journal.landing.night.echo')}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--lamp-400)', marginTop: 9 }}>{t('journal.landing.night.echoDate')}</div>
        </div>
      </div>
    </div>
  );
}

function WriteScene() {
  const ref = useScene(mountWriteBeat);
  return (
    <div ref={ref} className="jn-scene" title={t('journal.landing.replay')} aria-hidden="true">
      <div style={STAMP}>{t('journal.landing.write.yesterday')}</div>
      <div style={{ fontSize: 13.5, lineHeight: '22px', color: 'var(--text-primary)', opacity: .45, marginTop: 4 }}>{t('journal.landing.write.yesterdayLine')}</div>
      <div className="jn-lamp-ink" style={{ ...STAMP, color: undefined, marginTop: 16 }}>{t('journal.landing.write.today')}</div>
      <div style={{ fontSize: 13.5, lineHeight: '22px', color: 'var(--text-primary)', marginTop: 4, minHeight: 44 }}>
        <span data-typed>{t('journal.landing.write.todayLine')}</span>
        <span className="jn-lamp-bar" style={{ display: 'inline-block', width: 2, height: 14, marginLeft: 2, verticalAlign: '-2px' }} />
      </div>
    </div>
  );
}

// Three days from the read view, then the canvas pinched down to a year. 0 is a day nobody wrote.
const READ_LINES = [
  { day: t('journal.landing.lookBack.jul22'), line: t('journal.landing.lookBack.jul22Line') },
  { day: t('journal.landing.lookBack.jul24'), line: t('journal.landing.lookBack.jul24Line') },
  { day: t('journal.landing.lookBack.jul25'), line: t('journal.landing.lookBack.jul25Line') },
];
const YEAR = [
  { month: t('journal.landing.lookBack.may'), days: [5, 4, 0, 6, 4, 0, 0, 4, 2, 5, 4, 0, 6, 5, 4, 2, 0, 4, 5, 4, 6] },
  { month: t('journal.landing.lookBack.jun'), days: [4, 0, 0, 0, 5, 4, 6, 4, 0, 2, 4, 5, 4, 0, 4, 6, 5, 4, 0, 4, 2] },
  { month: t('journal.landing.lookBack.jul'), days: [5, 4, 4, 0, 0, 6, 4, 5, 4, 0, 2, 4, 5, 4, 6, 0, 4, 4, 5, 2, 4] },
];

function LookBackScene() {
  const ref = useScene(mountLookBackBeat);
  return (
    <div ref={ref} className="jn-scene" title={t('journal.landing.replay')} aria-hidden="true">
      <div data-read style={{ display: 'none' }}>
        {READ_LINES.map((entry, index) => (
          <div key={entry.day} style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: index === 0 ? 0 : 9 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, textTransform: 'uppercase', color: 'var(--text-tertiary)', width: 44, flex: 'none' }}>{entry.day}</span>
            <span style={{ fontSize: 12.5, lineHeight: '20px', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.line}</span>
          </div>
        ))}
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 14 }}>{t('journal.landing.lookBack.pinching')}</div>
      </div>
      <div data-year>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{t('journal.landing.lookBack.year')}</div>
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
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 14 }}>{t('journal.landing.lookBack.legend')}</div>
      </div>
    </div>
  );
}

// A mood square and three energy ticks per day; a day with no writing gets a hollow square, no lit tick.
const WEEK = [
  { dow: t('journal.date.weekdayInitial.mon'), mood: 'var(--lamp-500)', energy: 2 },
  { dow: t('journal.date.weekdayInitial.tue'), mood: 'var(--lamp-400)', energy: 3 },
  { dow: t('journal.date.weekdayInitial.wed'), mood: null, energy: null },
  { dow: t('journal.date.weekdayInitial.thu'), mood: 'var(--lamp-600)', energy: 1 },
  { dow: t('journal.date.weekdayInitial.fri'), mood: 'var(--lamp-400)', energy: 2 },
  { dow: t('journal.date.weekdayInitial.sat'), mood: 'var(--lamp-200)', energy: 3 },
  { dow: t('journal.date.weekdayInitial.sun'), mood: 'var(--lamp-400)', energy: 2 },
];

function HearBackScene() {
  const ref = useScene(mountHearBackBeat);
  return (
    <div ref={ref} className="jn-scene" title={t('journal.landing.replay')} aria-hidden="true">
      <div style={STAMP}>{t('journal.landing.hearBack.week')}</div>
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
        <div style={{ fontSize: 13, lineHeight: '20px', color: 'var(--text-primary)', marginTop: 14 }}>{t('journal.landing.hearBack.count')}</div>
        <div className="jn-lamp-ink" style={{ fontSize: 12, fontWeight: 700, marginTop: 10 }}>{t('journal.landing.hearBack.action')}</div>
      </div>
    </div>
  );
}

function HowItWorks() {
  const beats = [
    { num: '01', title: t('journal.landing.how.writeTitle'), Scene: WriteScene, copy: t('journal.landing.how.writeCopy') },
    { num: '02', title: t('journal.landing.how.lookBackTitle'), Scene: LookBackScene, copy: t('journal.landing.how.lookBackCopy') },
    { num: '03', title: t('journal.landing.how.hearBackTitle'), Scene: HearBackScene, copy: t('journal.landing.how.hearBackCopy') },
  ];
  return (
    <section id="how" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('journal.landing.how.eyebrow')}</div>
      <h2 className="sectionTitle">{t('journal.landing.how.title')}</h2>
      <p className="sectionSub">{t('journal.landing.how.sub')}</p>
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
      title={t('journal.landing.replay')}
      aria-hidden="true"
      style={{ position: 'relative', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-md)', overflow: 'hidden', cursor: 'pointer', textAlign: 'left' }}
    >
      <span style={{ position: 'absolute', top: 12, right: 14, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 5, padding: '3px 7px', background: 'var(--surface-canvas)' }}>{t('journal.landing.searchSheet.example')}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ color: 'var(--color-brand)', display: 'flex' }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </span>
        <span data-typed style={{ fontSize: 16, color: 'var(--text-primary)', minHeight: 22 }}>{t('journal.landing.searchSheet.query')}</span>
      </div>
      <div style={{ padding: '16px 18px 18px' }}>
        <div style={{ display: 'flex', gap: 14, opacity: .38 }}>
          <span style={{ width: 56, flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', color: 'var(--text-tertiary)', paddingTop: 2 }}>{t('journal.landing.searchSheet.thu')}</span>
          <span style={{ fontSize: 13.5, lineHeight: '21px', color: 'var(--text-primary)' }}>{t('journal.landing.searchSheet.thuLine')}</span>
        </div>
        <div data-hit style={{ display: 'flex', gap: 14, marginTop: 12 }}>
          <span className="jn-lamp-ink" style={{ width: 56, flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', paddingTop: 2 }}>{t('journal.landing.searchSheet.fri')}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14.5, lineHeight: '23px', color: 'var(--text-primary)' }}>{t('journal.landing.searchSheet.friLine')}</span>
            <span className="jn-lamp-ink" style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 11, marginTop: 6 }}>{t('journal.landing.searchSheet.why')}</span>
          </span>
        </div>
        <div style={{ display: 'flex', gap: 14, marginTop: 12, opacity: .38 }}>
          <span style={{ width: 56, flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', color: 'var(--text-tertiary)', paddingTop: 2 }}>{t('journal.landing.searchSheet.sat')}</span>
          <span style={{ fontSize: 13.5, lineHeight: '21px', color: 'var(--text-primary)' }}>{t('journal.landing.searchSheet.satLine')}</span>
        </div>
      </div>
      <div style={{ padding: '11px 18px', borderTop: '1px solid var(--border-subtle)', fontSize: 12, color: 'var(--text-tertiary)' }}>
        {t('journal.landing.searchSheet.foot')}
      </div>
    </div>
  );
}

function Search() {
  return (
    <section id="proof" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('journal.landing.search.eyebrow')}</div>
      <h2 className="sectionTitle">{t('journal.landing.search.title')}</h2>
      <p className="sectionSub">{t('journal.landing.search.sub')}</p>
      <div style={{ maxWidth: 720, margin: '40px auto 0' }}>
        <SearchSheet />
        <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-tertiary)', marginTop: 14 }}>{t('journal.landing.search.note')}</div>
      </div>
    </section>
  );
}

const CAN = [
  t('journal.landing.onlyYou.canAnywhere'),
  t('journal.landing.onlyYou.canSearch'),
];
const CANT = [
  { lead: t('journal.landing.onlyYou.shareLead'), copy: t('journal.landing.onlyYou.shareCopy') },
  { lead: t('journal.landing.onlyYou.voiceLead'), copy: t('journal.landing.onlyYou.voiceCopy') },
  { lead: t('journal.landing.onlyYou.treeLead'), copy: t('journal.landing.onlyYou.treeCopy') },
  { lead: t('journal.landing.onlyYou.trainLead'), copy: t('journal.landing.onlyYou.trainCopy') },
];

function OnlyYou() {
  return (
    <section id="onlyyou" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('journal.landing.onlyYou.eyebrow')}</div>
      <h2 className="sectionTitle">{t('journal.landing.onlyYou.title')}</h2>
      <p className="sectionSub">{t('journal.landing.onlyYou.sub')}</p>
      <div style={{ background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-2xl)', boxShadow: 'var(--shadow-sm)', padding: 'clamp(24px,3vw,36px)', marginTop: 40, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 'clamp(24px,3vw,40px)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{t('journal.landing.onlyYou.can')}</div>
          {CAN.map((line) => (
            <div key={line} style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--accent-olive-500)', display: 'flex', marginTop: 3 }}>{CHECK}</span>
              <span style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{line}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{t('journal.landing.onlyYou.cant')}</div>
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
      <div className="eyebrow">{t('journal.landing.echoes.eyebrow')}</div>
      <h2 className="sectionTitle">{t('journal.landing.echoes.title')}</h2>
      <div style={{ maxWidth: 620 }}>
        <p style={{ fontSize: 17, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0, textWrap: 'pretty' }}>
          {t('journal.landing.echoes.body')}
        </p>
        <p style={{ fontSize: 15.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '14px 0 0', textWrap: 'pretty' }}>
          {t('journal.landing.echoes.free')}
        </p>
      </div>
    </section>
  );
}

const ROOMS = [
  {
    title: t('journal.landing.why.accountTitle'),
    copy: t('journal.landing.why.accountCopy'),
    glyph: <><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></>,
  },
  {
    title: t('journal.landing.why.everywhereTitle'),
    copy: t('journal.landing.why.everywhereCopy'),
    glyph: <><path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" /><path d="M10 19v-3.96 3.15" /><path d="M7 19h5" /><rect width="6" height="10" x="16" y="12" rx="2" /></>,
  },
];

function WhyWindmill() {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('journal.landing.why.eyebrow')}</div>
      <h2 className="sectionTitle">{t('journal.landing.why.title')}</h2>
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
        <h2 className="sectionTitle" style={{ margin: 0 }}>{t('journal.landing.writeTonight.title')}</h2>
        <p className="sectionSub" style={{ maxWidth: 460 }}>{t('journal.landing.writeTonight.sub')}</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href="#/journal"><Button variant="primary" size="lg">{t('journal.landing.startWriting')}</Button></a>
          <a href="#how"><Button variant="ghost" size="lg">{t('journal.landing.seeHow')}</Button></a>
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
