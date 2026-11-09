import React from 'react';
import { Badge, Button } from '../../../design-system';
import { LandingPage, useScene } from '../../../shell/marketing/LandingChrome.jsx';
import { t } from '../i18n/index.js';
import { KG, unitSymbol } from '../units.js';
import { mountMoat, mountSetLogger, mountRemembered, mountE1rmLine } from './gymScenes.js';
import './gymLanding.css';

const EXCHANGE = {
  askedLabel: t('gym.landing.exchange.askedLabel'),
  asked: t('gym.landing.exchange.asked'),
  landedLabel: t('gym.landing.exchange.landedLabel'),
  landed: t('gym.landing.exchange.landed'),
};

const PRECONDITION = t('gym.landing.connected.precondition');

const LEVEL_LINES = {
  read: t('gym.landing.connected.levelRead'),
  write: t('gym.landing.connected.levelWrite'),
  delete: t('gym.landing.connected.levelDelete'),
};

const SECTION_LINKS = [
  { href: '#how', label: t('gym.landing.links.how') },
  { href: '#proof', label: t('gym.landing.links.barbell') },
  { href: '/changelog.html', label: t('gym.landing.links.changelog') },
];

const LOG_HREF = '#/gym';
const OPEN_LOG = t('gym.landing.openLog');
const RESUME = { href: LOG_HREF, label: t('gym.landing.resume') };
const ACCOUNT_LINE = t('gym.landing.accountLine');

const PANEL_LABEL = {
  fontSize: 11, fontWeight: 800, letterSpacing: '.09em',
  textTransform: 'uppercase', color: 'var(--text-tertiary)',
};

const LIFTS = [
  { name: t('gym.landing.lift.squat'), value: '140', unit: t('gym.landing.lift.e1rm'), d: 'M4,38 L20,36 L36,32 L52,33 L68,28 L84,25 L100,26 L116,21 L132,18 L148,19 L164,13 L176,10', cy: 10 },
  { name: t('gym.landing.lift.bench'), value: '100', unit: t('gym.landing.lift.e1rm'), d: 'M4,37 L20,35 L36,34 L52,30 L68,29 L84,25 L100,26 L116,22 L132,20 L148,17 L164,15 L176,12', cy: 12 },
  { name: t('gym.landing.lift.deadlift'), value: '170', unit: t('gym.landing.lift.e1rm'), d: 'M4,39 L20,35 L36,34 L52,29 L68,27 L84,27 L100,22 L116,20 L132,16 L148,15 L164,11 L176,8', cy: 8 },
  { name: t('gym.landing.lift.press'), value: '62.5', unit: t('gym.landing.lift.e1rm'), d: 'M4,36 L20,35 L36,35 L52,31 L68,31 L84,28 L100,28 L116,24 L132,24 L148,21 L164,20 L176,17', cy: 17 },
  { name: t('gym.landing.lift.rows'), value: '90', unit: t('gym.landing.lift.e1rm'), d: 'M4,37 L20,34 L36,33 L52,30 L68,29 L84,26 L100,25 L116,22 L132,21 L148,18 L164,16 L176,14', cy: 14 },
  { name: t('gym.landing.lift.chins'), value: '11', unit: t('gym.landing.lift.topSet'), d: 'M4,38 L20,37 L36,33 L52,32 L68,30 L84,26 L100,27 L116,23 L132,22 L148,19 L164,17 L176,15', cy: 15 },
];

const MCP_CLIENTS = ['Claude Desktop', 'Claude Code', 'Cursor', 'Codex', t('gym.landing.connected.anyClient')];

const AGENT_CAN = [
  t('gym.landing.connected.canRead'),
  t('gym.landing.connected.canDraft'),
  t('gym.landing.connected.canPropose'),
];

const GRANT_LEVELS = [
  { scope: 'gym:read', line: LEVEL_LINES.read, granted: true },
  { scope: 'gym:write', line: LEVEL_LINES.write, granted: true },
  { scope: 'gym:delete', line: LEVEL_LINES.delete, granted: false },
];

const BRAND_DUO = [
  {
    title: t('gym.landing.windmill.accountTitle'),
    copy: t('gym.landing.windmill.accountCopy'),
    glyph: <><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></>,
  },
  {
    title: t('gym.landing.windmill.everywhereTitle'),
    copy: t('gym.landing.windmill.everywhereCopy'),
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
      <div ref={ref} className="gyw gym-skin gyMoat" data-theme="dark" data-brand="gym" aria-hidden="true">

        <div data-gy="still" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 20 }}>
          <div>
            <div className="gyLabel">{t('gym.landing.moat.session')}</div>
            <div className="gyWell" style={{ marginTop: 12, padding: '6px 14px' }}>
              <SetRow n="1" reps="60 × 8" done style={{ borderBottom: '1px solid var(--gym-line)', color: 'var(--gym-ink-dim)' }} />
              <SetRow n="2" reps="90 × 5" done style={{ borderBottom: '1px solid var(--gym-line)', color: 'var(--gym-ink-dim)' }} />
              <SetRow n="3" reps="95 × 5" done style={{ borderBottom: '1px solid var(--gym-line)', color: 'var(--gym-ink-dim)' }} />
              <SetRow n="4" reps="100 × 5" done style={{ color: 'var(--gym-ink)' }} />
            </div>
          </div>
          <div>
            <div className="gyLabel">{t('gym.landing.moat.nextSession')}</div>
            <div style={{ marginTop: 12 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 17, color: 'var(--gym-ink)' }}>{t('gym.landing.lift.squat')}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, fontSize: 56, lineHeight: .95, color: 'var(--weight-ink)', marginTop: 8 }}>
                100<span className="gyCaption" style={{ fontSize: 16, marginLeft: 5 }}>{unitSymbol(KG)}</span>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--target-ink)', marginTop: 8 }}>{t('gym.landing.moat.lastSession')}</div>
            </div>
          </div>
        </div>

        <div data-gy="live" style={{ display: 'none', transition: 'opacity 280ms var(--ease-standard)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 19, color: 'var(--gym-ink)' }}>{t('gym.landing.lift.squat')}</div>
            <div data-gy="session" className="gyCaption" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{t('gym.landing.moat.session')}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, marginTop: 14, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, fontSize: 'clamp(48px,8vw,72px)', lineHeight: .92, color: 'var(--weight-ink)' }}>
                <span data-gy="weight">97.5</span><span className="gyCaption" style={{ fontSize: 19, marginLeft: 6 }}>{unitSymbol(KG)}</span>
              </div>
              <div data-gy="note" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--target-ink)', marginTop: 9 }}>{t('gym.landing.moat.lastWeek')}</div>
              <div data-gy="pr" className="gyFade" style={{ display: 'none', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--gym-ink-dim)', marginTop: 7 }}>{t('gym.landing.moat.bestYet')}</div>
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
              <span data-gy="log" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 44, padding: '0 22px', borderRadius: 'var(--radius-lg)', background: 'var(--color-brand)', color: 'var(--gym-on-accent)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 14.5, transition: 'opacity 150ms var(--ease-standard)' }}>{t('gym.landing.logSet')}</span>
            </div>
          </div>
          <div className="gyWell" style={{ marginTop: 18, padding: '6px 14px' }}>
            <SetRow n="1" reps="60 × 8" done style={{ borderBottom: '1px solid var(--gym-line)', color: 'var(--gym-ink-dim)' }} />
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
        <Badge tone="neutral">{t('gym.landing.hero.badge')}</Badge>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(36px, 5.2vw, 60px)', lineHeight: 1.07, color: 'var(--text-primary)', margin: '20px 0 16px', maxWidth: 820, textWrap: 'pretty' }}>
          {t('gym.landing.hero.title')}
        </h1>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(16px, 2vw, 20px)', lineHeight: 1.5, color: 'var(--text-secondary)', maxWidth: 640, margin: 0, textWrap: 'pretty' }}>
          {t('gym.landing.hero.sub')}
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href={LOG_HREF}><Button variant="primary" size="lg">{OPEN_LOG}</Button></a>
          <a href="#how"><Button variant="secondary" size="lg">{t('gym.landing.seeHow')}</Button></a>
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
    <div ref={ref} className="gyw gym-skin gyStage" data-theme="dark" data-brand="gym" title={t('gym.landing.replay')} aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <span className="gychip gychip--sm">−10</span>
        <span className="gychip gychip--sm">−2.5</span>
        <span className="gychip gychip--sm" data-gy="s1fine">+2.5</span>
        <span className="gychip gychip--sm">+10</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 34, color: 'var(--weight-ink)' }}>
          <span data-gy="s1w">100</span><span className="gyCaption" style={{ fontSize: 13, marginLeft: 4 }}>{unitSymbol(KG)}</span>
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--gym-ink-dim)' }}>× <span data-gy="s1r">5</span></span>
      </div>
      <div className="gyCaption" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, textAlign: 'center' }}>
        {t('gym.landing.how.ladderCaption')}
      </div>
    </div>
  );
}

function RememberedStage() {
  const ref = useScene(mountRemembered);
  return (
    <div ref={ref} className="gyw gym-skin gyStage" data-theme="dark" data-brand="gym" title={t('gym.landing.replay')} aria-hidden="true"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div data-gy="s2card" className="gyRise gyInnerCard" style={{ width: '100%', maxWidth: 240 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--gym-ink)' }}>{t('gym.landing.lift.squat')}</span>
          <span className="gyCaption" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{t('gym.landing.how.rememberedDay')}</span>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 34, color: 'var(--weight-ink)', marginTop: 8 }}>
          100<span className="gyCaption" style={{ fontSize: 13, marginLeft: 4 }}>{unitSymbol(KG)}</span>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--target-ink)', marginTop: 6 }}>{t('gym.landing.how.rememberedNote')}</div>
      </div>
    </div>
  );
}

function LineStage() {
  const ref = useScene(mountE1rmLine);
  return (
    <div ref={ref} className="gyw gym-skin gyStage" data-theme="dark" data-brand="gym" title={t('gym.landing.replay')} aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span className="gyCaption" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase' }}>{t('gym.landing.how.lineLift')}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gym-ink-dim)' }}>{t('gym.landing.how.lineWindow')}</span>
      </div>
      <svg viewBox="0 0 240 90" width="100%" height="90" style={{ display: 'block' }}>
        <path data-gy="s3line" d="M8,74 L28,71 L48,66 L68,67 L88,60 L108,55 L128,56 L148,48 L168,43 L188,44 L208,36 L232,28"
          fill="none" stroke="var(--color-brand)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <circle data-gy="s3dot" cx="232" cy="28" r="3.4" fill="var(--color-brand)" />
      </svg>
      <div data-gy="s3cap" className="gyCaption" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{t('gym.landing.how.lineCaption')}</div>
    </div>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('gym.landing.how.eyebrow')}</div>
      <h2 className="sectionTitle">{t('gym.landing.how.title')}</h2>
      <p className="sectionSub">{t('gym.landing.how.sub')}</p>
      <div className="beats">
        <div className="beat">
          <LadderStage />
          <div>
            <div className="beatNum">01</div>
            <h3 className="beatTitle">{t('gym.landing.how.logTitle')}</h3>
            <p className="beatCopy">{t('gym.landing.how.logCopy')}</p>
          </div>
        </div>
        <div className="beat">
          <RememberedStage />
          <div>
            <div className="beatNum">02</div>
            <h3 className="beatTitle">{t('gym.landing.how.rememberTitle')}</h3>
            <p className="beatCopy">{t('gym.landing.how.rememberCopy')}</p>
          </div>
        </div>
        <div className="beat">
          <LineStage />
          <div>
            <div className="beatNum">03</div>
            <h3 className="beatTitle">{t('gym.landing.how.lineTitle')}</h3>
            <p className="beatCopy">{t('gym.landing.how.lineCopy')}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function ForTheBarbell() {
  return (
    <section id="proof" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('gym.landing.barbell.eyebrow')}</div>
      <h2 className="sectionTitle">{t('gym.landing.barbell.title')}</h2>
      <p className="sectionSub" style={{ maxWidth: 600 }}>
        {t('gym.landing.barbell.sub')}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 20, marginTop: 40 }}>
        {LIFTS.map((lift) => (
          <div key={lift.name} className="gyw gym-skin gycard" data-theme="dark" data-brand="gym">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15.5, color: 'var(--gym-ink)' }}>{lift.name}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 17, color: 'var(--weight-ink)' }}>
                {lift.value}<span className="gyCaption" style={{ fontSize: 10, marginLeft: 3 }}>{lift.unit}</span>
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
        {t('gym.landing.barbell.example')}
      </div>
    </section>
  );
}

function ConnectedLog() {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('gym.landing.connected.eyebrow')}</div>
      <h2 className="sectionTitle">{t('gym.landing.connected.title')}</h2>
      <p className="sectionSub">{t('gym.landing.connected.sub')}</p>
      <Exchange />
      <div style={{ background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-2xl)', boxShadow: 'var(--shadow-sm)', padding: 'clamp(24px,3vw,36px)', marginTop: 40, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 'clamp(24px,3vw,40px)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
          <div style={PANEL_LABEL}>{t('gym.landing.connected.worksWith')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {MCP_CLIENTS.map((client) => (
              <span key={client} style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '7px 14px', fontSize: 13.5, fontWeight: 700, color: 'var(--text-secondary)', background: 'var(--surface-canvas)' }}>{client}</span>
            ))}
          </div>
          <div style={{ ...PANEL_LABEL, marginTop: 6 }}>{t('gym.landing.connected.itCan')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {AGENT_CAN.map((line) => (
              <div key={line} style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--accent-olive-500)', display: 'flex', marginTop: 3 }}><Check size={15} strokeWidth={2.4} /></span>
                <span style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{line}</span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 15, lineHeight: 1.55, fontWeight: 700, color: 'var(--text-primary)', margin: '6px 0 0' }}>
            {t('gym.landing.connected.never')}
          </p>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, color: 'var(--text-secondary)', margin: 0 }}>
            {t('gym.landing.connected.levels')}
          </p>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, color: 'var(--text-secondary)', margin: 0 }}>
            {t('gym.landing.connected.coach')}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={PANEL_LABEL}>{t('gym.landing.connected.approve')}</div>
          <div className="gyw gym-skin gycard" data-theme="dark" data-brand="gym">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span className="gyCaption" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t('gym.landing.connected.cardTitle')}</span>
              <span className="gyCaption" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t('gym.landing.connected.cardProduct')}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 12 }}>
              {GRANT_LEVELS.map((level) => (
                <div key={level.scope} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 17, height: 17, borderRadius: 5, border: `1px solid ${level.granted ? 'var(--color-brand)' : 'var(--gym-line-strong)'}`, background: level.granted ? 'var(--color-brand)' : 'transparent', color: 'var(--gym-on-accent)' }}>
                    {level.granted && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className={level.granted ? undefined : 'gyCaption'} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: level.granted ? 'var(--gym-ink)' : undefined, minWidth: 82 }}>{level.scope}</span>
                  <span className={level.granted ? undefined : 'gyCaption'} style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: level.granted ? 'var(--gym-ink-dim)' : undefined }}>{level.line}</span>
                </div>
              ))}
            </div>
            <div className="gyCaption" style={{ fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: 1.5, marginTop: 14 }}>
              {t('gym.landing.connected.neverGranted')}
            </div>
          </div>
        </div>
      </div>
      <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-tertiary)', maxWidth: 720, marginTop: 20 }}>
        {PRECONDITION}
      </p>
    </section>
  );
}

function Exchange() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 18, marginTop: 36 }}>
      <div className="gyw gym-skin gycard" data-theme="dark" data-brand="gym">
        <div className="gyCaption" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase' }}>
          {EXCHANGE.askedLabel}
        </div>
        <p style={{ margin: '9px 0 0', fontSize: 15, lineHeight: 1.5, color: 'var(--gym-ink)' }}>{EXCHANGE.asked}</p>
      </div>
      <div className="gyw gym-skin gycard" data-theme="dark" data-brand="gym" style={{ borderColor: 'var(--color-brand)', background: 'var(--color-brand-soft)' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--color-brand)' }}>
          {EXCHANGE.landedLabel}
        </div>
        <p style={{ margin: '9px 0 0', fontSize: 15, lineHeight: 1.5, color: 'var(--gym-ink)' }}>{EXCHANGE.landed}</p>
      </div>
    </div>
  );
}

function PartOfWindmill() {
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('gym.landing.windmill.eyebrow')}</div>
      <h2 className="sectionTitle">{t('gym.landing.windmill.title')}</h2>
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
        <h2 className="sectionTitle" style={{ margin: 0 }}>{t('gym.landing.cta.title')}</h2>
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
