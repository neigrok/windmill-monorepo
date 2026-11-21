// The brand front door at the bare root, in the instrument look: what Windmill is, its three tools, a
// section per open product composed off the registry's `landing.root`, the two ways to bring an AI,
// where it runs, and the footer as the sitemap. A product still holding itself shut brings no row and
// no section but keeps its place in the header and the footer. Every link and control tells one
// event, and nothing inside a picture frame is live.

import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Icon, SegmentedControl } from '../../design-system';
import { useAuth } from '../auth/AuthProvider.jsx';
import { AccountSeat } from '../auth/AccountSeat.jsx';
import { useSignInDoor } from '../auth/SignInDoor.jsx';
import { pendingMagicLink } from '../auth/AuthClient.js';
import { FeedbackDialog } from '../feedback/FeedbackDialog.jsx';
import { PRODUCTS, homeHash } from '../products.js';
import { useAppearance } from '../useAppearance.js';
import { track } from '../../telemetry/beacon.js';
import { LandingFrame, usePendingMagicLink } from './LandingChrome.jsx';
import { t } from '../i18n/entry/index.js';
import './brandLanding.css';

// The header and the footer name the rooms in the brand's order; the page below keeps the registry's.
const ROOMS = ['roadmap', 'gym', 'journal'].map((id) => PRODUCTS.find((product) => product.id === id));

const SITEMAP = [
  { title: t('shell.brandLanding.rooms'), links: ROOMS.map((product) => ({ href: product.landing.href, label: product.label, to: 'landing', product: product.id })) },
  { title: t('shell.brandLanding.ownAssistant'), links: [{ href: '/connect.html', label: t('shell.site.connect'), to: 'connect' }] },
  { title: t('shell.brandLanding.windmill'), links: [
    { href: '/pricing.html', label: t('shell.site.pricing'), to: 'pricing' },
    { href: '/changelog.html', label: t('shell.site.changelog'), to: 'changelog' },
    { href: '/gallery', label: t('shell.site.gallery'), to: 'gallery' },
  ] },
  { title: t('shell.brandLanding.legal'), links: [
    { href: '/privacy.html', label: t('shell.site.privacy'), to: 'privacy' },
    { href: '/terms.html', label: t('shell.site.terms'), to: 'terms' },
    { href: '/refunds.html', label: t('shell.site.refunds'), to: 'refunds' },
  ] },
];

// Auto is the store's `system`: it follows the device and is what a first visit reads.
const APPEARANCES = [
  { value: 'system', label: t('shell.brandLanding.auto'), icon: 'monitor' },
  { value: 'light', label: t('shell.appearance.light'), icon: 'sun' },
  { value: 'dark', label: t('shell.appearance.dark'), icon: 'moon' },
];
const APPEARANCE_LABEL = { system: 'auto', light: 'light', dark: 'dark' };

const followed = (area, to, product) => () => track('front_link', { area, to, ...(product ? { product } : {}) });
const used = (control, props) => track('front_control', { control, ...props });

function Brand({ night }) {
  return (
    <>
      <img src={night ? '/brand-mark-night.svg' : '/brand-mark.svg'} alt="" width={24} height={24} />
      <span>Windmill</span>
    </>
  );
}

function ArrowLink({ href, onFollow, children }) {
  return (
    <a className="front-link" href={href} onClick={onFollow}>
      {children}
      <Icon name="arrow-right" size={14} strokeWidth={2.4} />
    </a>
  );
}

function Header({ night }) {
  const { user, status, signOut } = useAuth();
  const openSignInDoor = useSignInDoor();
  const [pendingLink, noteLinkSent] = usePendingMagicLink(status);
  const signedIn = status === 'signed-in' && Boolean(user);

  return (
    <header className="front-header">
      <div className="front-wrap front-header-row">
        <a className="front-brand" href="/" aria-label={t('shell.brandLanding.home')} onClick={followed('header', 'home')}><Brand night={night} /></a>
        <nav className="front-nav" aria-label={t('shell.landing.primaryNav')}>
          {ROOMS.map((product) => <a key={product.id} href={product.landing.href} onClick={followed('header', 'landing', product.id)}>{product.label}</a>)}
          <a href="/pricing.html" onClick={followed('header', 'pricing')}>{t('shell.site.pricing')}</a>
        </nav>
        {/* While auth is unanswered the cluster keeps its box and shows nothing, so neither state flashes. */}
        <div className="front-cluster" style={status === 'loading' ? { visibility: 'hidden' } : undefined}>
          {signedIn ? (
            <AccountSeat
              user={user}
              status={status}
              size={28}
              appearance={false}
              onSettings={() => { used('settings'); window.location.hash = '#/settings'; }}
              onSignOut={() => { used('sign_out'); signOut(); }}
            />
          ) : pendingLink ? (
            <button type="button" className="front-signin" onClick={() => { used('link_sent'); openSignInDoor({ resume: pendingMagicLink(), onSent: noteLinkSent }); }}>
              {t('shell.landing.linkSent')}
            </button>
          ) : (
            <button type="button" className="front-signin" onClick={() => { used('sign_in'); openSignInDoor({ onSent: noteLinkSent }); }}>
              {t('shell.auth.signIn')}
            </button>
          )}
          <a className="front-pill" href={signedIn ? homeHash() : '/app'} onClick={followed('header', 'app')}>{t('shell.brandLanding.open')}</a>
        </div>
      </div>
    </header>
  );
}

function Tool({ product }) {
  const { kind, line, link } = product.landing.root;
  return (
    <li className="front-tool">
      <h2 className="front-tool-name">{t('shell.brandLanding.toolName', { product: product.label })}</h2>
      <p className="front-tool-kind">{kind}</p>
      <p className="front-tool-line">{line}</p>
      <ArrowLink href={link.href} onFollow={followed('tools', link.to, product.id)}>{link.label}</ArrowLink>
    </li>
  );
}

function Room({ product, theme }) {
  const { title, paragraph, link, features, picture } = product.landing.root;
  const { Picture } = picture;
  return (
    <section className="front-room" aria-labelledby={`front-${product.id}`}>
      <div className="front-wrap front-rule">
        <div className="front-room-head">
          <h2 className="front-title" id={`front-${product.id}`}>{title}</h2>
          <div>
            <p className="front-text">{paragraph}</p>
            <ArrowLink href={link.href} onFollow={followed('room', link.to, product.id)}>{link.label}</ArrowLink>
          </div>
        </div>
        <figure className="front-picture">
          <figcaption className="front-picture-bar">{picture.label}</figcaption>
          {/* The composed picture is spared a screen reader and the keyboard; its label above is what is said of it. */}
          <div className="front-picture-body" aria-hidden="true" inert="" data-brand={product.id} data-theme={theme}
            style={{ '--front-picture-wide': picture.reserve.wide, '--front-picture-narrow': picture.reserve.narrow }}>
            <Suspense fallback={null}><Picture /></Suspense>
          </div>
        </figure>
        <ul className="front-features">
          {features.map((feature) => (
            <li key={feature.title}>
              <h3 className="front-feature-title">{feature.title}</h3>
              <p className="front-text">{feature.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Footer({ night }) {
  const { choice, set } = useAppearance();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const choose = (next) => { used('appearance', { choice: APPEARANCE_LABEL[next] }); set(next); };

  return (
    <>
      <footer className="front-footer">
        <div className="front-wrap front-sitemap front-rule">
          <div className="front-brand"><Brand night={night} /></div>
          <nav className="front-sitemap-columns" aria-label={t('shell.brandLanding.footerNav')}>
            {SITEMAP.map((column) => (
              <div key={column.title}>
                <h2 className="front-sitemap-title">{column.title}</h2>
                <ul>
                  {column.links.map((link) => <li key={link.href}><a href={link.href} onClick={followed('sitemap', link.to, link.product)}>{link.label}</a></li>)}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <div className="front-wrap front-foot">
          <button type="button" className="front-feedback" onClick={() => { used('feedback'); setFeedbackOpen(true); }}>{t('shell.feedback.label')}</button>
          <div className="front-switch">
            <SegmentedControl label={t('shell.appearance.label')} options={APPEARANCES} value={choice} onChange={choose} />
          </div>
        </div>
      </footer>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}

export function BrandLanding() {
  const { resolved: theme } = useAppearance();
  const { status } = useAuth();
  const opened = useRef(false);
  const night = theme === 'dark';
  const open = PRODUCTS.filter((product) => product.shell.status === 'open');

  useEffect(() => {
    if (status === 'loading' || opened.current) return;
    opened.current = true;
    track('front_open', { signedIn: status === 'signed-in' });
  }, [status]);

  return (
    <LandingFrame path="/" look="instrument" header={<Header night={night} />} footer={<Footer night={night} />}>
      <section className="front-first">
        <div className="front-wrap">
          <h1 className="front-heading">{t('shell.landingHead.heading', { break: <br /> })}</h1>
          <p className="front-what">{t('shell.landingHead.what')}</p>
          <p className="front-stance">{t('shell.landingHead.stance')}</p>
        </div>
      </section>

      <section className="front-tools" aria-label={t('shell.brandLanding.tools')}>
        <ul className="front-wrap front-tools-row front-rule">
          {open.map((product) => <Tool key={product.id} product={product} />)}
        </ul>
      </section>

      {open.map((product) => <Room key={product.id} product={product} theme={theme} />)}

      <section className="front-ai" aria-labelledby="front-ai">
        <div className="front-wrap front-ai-row front-rule">
          <div>
            <h2 className="front-title" id="front-ai">{t('shell.brandLanding.aiTitle', { break: <br /> })}</h2>
            <p className="front-text">{t('shell.brandLanding.aiLine')}</p>
          </div>
          <div className="front-ai-way">
            <h3 className="front-ai-name">{t('shell.brandLanding.yoursTitle')}</h3>
            <p className="front-text">{t('shell.brandLanding.yoursText')}</p>
            <ArrowLink href="/connect.html" onFollow={followed('ai', 'connect')}>{t('shell.brandLanding.yoursLink')}</ArrowLink>
          </div>
          <div className="front-ai-way">
            <h3 className="front-ai-name">{t('shell.brandLanding.oursTitle')}</h3>
            <p className="front-text">{t('shell.brandLanding.oursText')}</p>
            <ArrowLink href="/pricing.html" onFollow={followed('ai', 'pricing')}>{t('shell.brandLanding.oursLink')}</ArrowLink>
          </div>
        </div>
      </section>

      <section className="front-runs">
        <p className="front-wrap front-rule">{t('shell.brandLanding.runs')}</p>
      </section>
    </LandingFrame>
  );
}
