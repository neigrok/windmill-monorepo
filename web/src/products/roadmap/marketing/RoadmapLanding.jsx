import React, { useEffect, useRef, useState } from 'react';
import { Button, Badge } from '../../../design-system';
import { LandingPage, useScene } from '../../../shell/marketing/LandingChrome.jsx';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { listTrees } from '../persistence/TreeRegistry.js';
import { track } from '../../../telemetry/beacon.js';
import { KIND_CSS } from '../theme.js';
import { mountHero, mountBeat, mountThumb } from './treeScenes.js';
import { resumeOf, resumeSummary } from '../resume.js';
import { t } from '../i18n/landing/index.js';
import './roadmapLanding.css';

const SECTION_LINKS = [
  { href: '#how', label: t('roadmap.landing.linkHow') },
  { href: '#paths', label: t('roadmap.landing.linkPaths') },
  { href: '#/connect', label: t('roadmap.landing.linkConnect') },
  { href: '/changelog.html', label: t('roadmap.landing.linkChangelog') },
];

const START_CTA = { href: '#/app/start', label: t('roadmap.landing.start') };

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

function HeroBand() {
  const ref = useScene((el) => {
    const hero = mountHero(el);
    hero.setAutoplay(true);
    return hero.teardown;
  });
  return <div className="heroBleed" aria-hidden="true"><div ref={ref}></div></div>;
}

function Hero({ resume }) {
  const offer = resume ? resumeOf(resume) : null;
  const progress = resume && <span style={{ fontFamily: 'var(--font-mono)' }}>{`${resume.done ?? 0}/${resume.total ?? 0}`}</span>;
  return (
    <section>
      <div className="wrap" style={{ paddingTop: 40, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Badge tone="brand" dot>{t('roadmap.landing.badge')}</Badge>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(36px, 5.2vw, 60px)', lineHeight: 1.07, color: 'var(--text-primary)', margin: '20px 0 16px', maxWidth: 820, textWrap: 'pretty' }}>
          {t('roadmap.landing.title')}
        </h1>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(16px, 2vw, 20px)', lineHeight: 1.5, color: 'var(--text-secondary)', maxWidth: 620, margin: 0, textWrap: 'pretty' }}>
          {t('roadmap.landing.sub')}
        </p>
        {resume ? (
          <>
            <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
              <a href={`#/app/${resume.id}`}><Button variant="primary" size="lg">{t('roadmap.landing.resume', { name: offer.shortName })}</Button></a>
              <a href={`#/app/${resume.id}`}><Button variant="ghost" size="lg">{t('roadmap.landing.myTrees')}</Button></a>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8, fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--text-tertiary)', marginTop: 14 }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: (KIND_CSS[resume.dominantKind] ?? KIND_CSS.terracotta).base }} />
              <span>
                {resumeSummary(offer, progress)}
              </span>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
              <a href="#/app/start"><Button variant="primary" size="lg">{t('roadmap.landing.start')}</Button></a>
              <a href="#/demo"><Button variant="secondary" size="lg">{t('roadmap.landing.tryDemo')}</Button></a>
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--text-tertiary)', marginTop: 14 }}>
              {t('roadmap.landing.firstTreeInBrowser')}
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
  return <div className="beatStage" title={t('roadmap.landing.replay')} aria-hidden="true"><div ref={ref}></div></div>;
}

function HowItWorks() {
  const beats = [
    { kind: 'plant', num: '01', title: t('roadmap.landing.beatPlantTitle'), copy: t('roadmap.landing.beatPlantCopy') },
    { kind: 'finish', num: '02', title: t('roadmap.landing.beatFinishTitle'), copy: t('roadmap.landing.beatFinishCopy') },
    { kind: 'unlock', num: '03', title: t('roadmap.landing.beatUnlockTitle'), copy: t('roadmap.landing.beatUnlockCopy') },
  ];
  return (
    <section id="how" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('roadmap.landing.howEyebrow')}</div>
      <h2 className="sectionTitle">{t('roadmap.landing.howTitle')}</h2>
      <p className="sectionSub">{t('roadmap.landing.howSub')}</p>
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
    { id: 'frontend', title: t('roadmap.landing.pathFrontendTitle'), readout: t('roadmap.landing.pathFrontendReadout'), rule: 'var(--kind-terracotta)', dots: ['var(--kind-terracotta)', 'var(--kind-sky)', 'var(--kind-gold)'] },
    { id: 'rust', title: t('roadmap.landing.pathRustTitle'), readout: t('roadmap.landing.pathRustReadout'), rule: 'var(--kind-brick)', dots: ['var(--kind-brick)', 'var(--kind-olive)', 'var(--kind-gold)'] },
    { id: 'ml', title: t('roadmap.landing.pathMlTitle'), readout: t('roadmap.landing.pathMlReadout'), rule: 'var(--kind-plum)', dots: ['var(--kind-plum)', 'var(--kind-sky)', 'var(--kind-olive)'] },
    { id: 'ship', title: t('roadmap.landing.pathShipTitle'), readout: t('roadmap.landing.pathShipReadout'), rule: 'var(--kind-terracotta)', dots: ['var(--kind-terracotta)', 'var(--kind-sky)', 'var(--kind-gold)'] },
  ];
  return (
    <section id="paths" className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('roadmap.landing.pathsEyebrow')}</div>
      <h2 className="sectionTitle">{t('roadmap.landing.pathsTitle')}</h2>
      <p className="sectionSub">{t('roadmap.landing.pathsSub')}</p>
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
          {t('roadmap.landing.browseQuests')}
        </a>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {t('roadmap.quests.attribution')}
        </div>
      </div>
    </section>
  );
}

function AiTools() {
  const clients = ['Claude Desktop', 'Claude Code', 'Cursor', 'Codex', t('roadmap.landing.anyMcpClient')];
  const verbs = [
    { label: t('roadmap.landing.verbPlant'), kind: 'terracotta' },
    { label: t('roadmap.landing.verbConnect'), kind: 'olive' },
    { label: t('roadmap.landing.verbPaint'), kind: 'gold' },
    { label: t('roadmap.landing.verbMark'), kind: 'plum' },
    { label: t('roadmap.landing.verbRead'), kind: 'sky' },
  ];
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('roadmap.landing.aiEyebrow')}</div>
      <h2 className="sectionTitle">{t('roadmap.landing.aiTitle')}</h2>
      <p className="sectionSub">{t('roadmap.landing.aiSub')}</p>
      <div className="aiPanel">
        <div className="aiCol">
          <div className="aiLabel">{t('roadmap.landing.aiWorksWith')}</div>
          <div className="aiClients">
            {clients.map(c => <span key={c} className="aiClient">{c}</span>)}
          </div>
          <p className="aiPromise">{t('roadmap.landing.aiPromise')}</p>
          <p className="aiCant">{t('roadmap.landing.aiCant')}</p>
          <div className="aiCta">
            <a href="#/connect"><Button variant="primary" size="lg">{t('roadmap.landing.aiConnect')}</Button></a>
          </div>
        </div>
        <div className="aiCol">
          <div className="aiLabel">{t('roadmap.landing.aiOnceConnected')}</div>
          <div className="aiVerbs">
            {verbs.map(v => (
              <span key={v.label} className="aiVerb">
                <i style={{ background: KIND_CSS[v.kind].base }} aria-hidden="true" />{v.label}
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
    { icon: 'git-fork', title: t('roadmap.landing.storyShareTitle'), copy: t('roadmap.landing.storyShareCopy') },
    { icon: 'monitor-smartphone', title: t('roadmap.landing.storySyncTitle'), copy: t('roadmap.landing.storySyncCopy') },
  ];
  return (
    <section className="wrap" style={{ paddingTop: 96 }}>
      <div className="eyebrow">{t('roadmap.landing.storyEyebrow')}</div>
      <h2 className="sectionTitle">{t('roadmap.landing.storyTitle')}</h2>
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
        <h2 className="sectionTitle" style={{ margin: 0 }}>{planted ? t('roadmap.landing.ctaPlantAnother') : t('roadmap.landing.ctaPlantFirst')}</h2>
        <p className="sectionSub" style={{ maxWidth: 460 }}>{t('roadmap.landing.ctaSub')}</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href={planted ? '#/app/new' : '#/app/start'}><Button variant="primary" size="lg">{t('roadmap.landing.start')}</Button></a>
          <a href="#/demo"><Button variant="ghost" size="lg">{t('roadmap.landing.tryDemo')}</Button></a>
        </div>
      </div>
    </section>
  );
}

// Cached per email so one device never shows another account's trees; never trusted, always refreshed.
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
  catch { /* the cache is never load-bearing */ }
}

export function RoadmapLanding() {
  const { user, status } = useAuth();
  const [trees, setTrees] = useState(() => readTreesCache(user?.email)); // seeded from cache, corrected by the registry
  const landed = useRef(false);

  useEffect(() => {
    if (status === 'loading' || landed.current) return;
    landed.current = true;
    track('land', { signedIn: status === 'signed-in' });
  }, [status]);

  useEffect(() => {
    if (status !== 'signed-in') { setTrees(null); return undefined; }
    let cancelled = false;
    listTrees().then((rows) => { if (!cancelled) { setTrees(rows); writeTreesCache(user?.email, rows); } });
    return () => { cancelled = true; };
  }, [status]);

  const newest = status === 'signed-in' && trees?.length ? trees[0] : null;

  // Signed in with the registry still out: the tree count is unknown, so the chrome waits.
  const resolving = status === 'signed-in' && trees === null;

  const seat = { label: t('roadmap.landing.myTrees'), count: trees?.length ?? null, note: t('roadmap.landing.seatNote') };

  return (
    <LandingPage
      brand="roadmap"
      product="roadmap"
      links={SECTION_LINKS}
      cta={START_CTA}
      resume={newest ? { href: `#/app/${newest.id}`, label: t('roadmap.landing.myTrees') } : null}
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
