// What every page of the site wears in the instrument look: the frame with its own head, the header, the footer
// as the sitemap, the arrow link and the frame a composed picture sits in. Sign in opens the door in place; a page
// never navigates to sign in. `page` names the page in every event it tells (`front` for the brand root, a
// product's id for its landing). A picture answers the pointer with its room's own motion and holds no control.

import React, { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ErrorBoundary, Icon, SegmentedControl } from '../../design-system';
import { useAuth } from '../auth/AuthProvider.jsx';
import { AccountSeat } from '../auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../auth/SignInDoor.jsx';
import { pendingMagicLink } from '../auth/AuthClient.js';
import { FeedbackDialog } from '../feedback/FeedbackDialog.jsx';
import { PageFrame } from '../PageFrame.jsx';
import { PRODUCTS, homeHash } from '../products.js';
import { useAppearance } from '../useAppearance.js';
import { paintBrowserChrome, restoreBrowserChrome } from '../appearance.js';
import { movedSinceArrival } from '../arrival.jsx';
import { track } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';
import { LANDING_HEADS, SITE_ORIGIN } from './landingHeads.js';
import { PictureDrawn, usePictureMotion } from './pictureMotion.js';
import { t } from '../i18n/entry/index.js';
import './site.css';

// The header and the footer name the rooms in the brand's order, whatever the registry's.
const ROOMS = ['roadmap', 'gym', 'journal'].map((id) => PRODUCTS.find((product) => product.id === id));

// The footer's columns. A static page in this look writes the same footer by hand, and test/public/pages.test.mjs holds
// it equal to this one.
export const SITEMAP = [
  { title: t('shell.brandLanding.rooms'), links: ROOMS.map((product) => ({ href: product.landing.href, label: product.label, to: 'landing', product: product.id })) },
  { title: t('shell.brandLanding.ownAssistant'), links: [{ href: '/connect.html', label: t('shell.site.connect'), to: 'connect' }] },
  { title: t('shell.brandLanding.windmill'), links: [
    { href: '/pricing.html', label: t('shell.site.pricing'), to: 'pricing' },
    { href: '/changelog.html', label: t('shell.site.changelog'), to: 'changelog' },
    { href: '/gallery', label: t('shell.site.gallery'), to: 'gallery' },
    { href: '/support.html', label: t('shell.site.support'), to: 'support' },
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

// One use of a link tells one event: the second click of a double click is the same use.
export const followed = (page, area, to, product) => (event) => {
  if (event?.detail > 1) return;
  track('front_link', { page, area, to, ...(product ? { product } : {}) });
};
const used = (page, control, props) => track('front_control', { page, control, ...props });

// A picture whose chunk fails reports once per page load for each page and picture, however often the page mounts.
const reportedPictures = new Set();
function reportPicture(id, route) {
  if (reportedPictures.has(`${route} ${id}`)) return;
  reportedPictures.add(`${route} ${id}`);
  captureError('render', `front-picture-${id}`, '', route);
}

// The frame every page of the site stands in: its own head while mounted, the night stamp on <html>, the skip link
// and the main landmark. `path` names its row in LANDING_HEADS; `header` and `footer` are its chrome.
export function SiteFrame({ path, header, footer, children }) {
  const lendDoorSkin = useSignInDoorHost();
  const { resolved: appearance } = useAppearance();

  // A page wears its own head while mounted and hands the brand root's back on the way out.
  useEffect(() => {
    const head = LANDING_HEADS.find((entry) => entry.path === path);
    if (!head) return undefined;
    const url = `${SITE_ORIGIN}${head.path}`;
    const swaps = [
      ['title', null, head.title],
      ['meta[name="description"]', 'content', head.description],
      ['link[rel="canonical"]', 'href', url],
      ['meta[property="og:title"]', 'content', head.ogTitle],
      ['meta[property="og:description"]', 'content', head.ogDescription],
      ['meta[property="og:url"]', 'content', url],
      ['meta[name="twitter:title"]', 'content', head.twitterTitle],
      ['meta[name="twitter:description"]', 'content', head.twitterDescription],
    ];
    const held = swaps.map(([selector, attribute, value]) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const was = attribute ? element.getAttribute(attribute) : element.textContent;
      if (attribute) element.setAttribute(attribute, value);
      else element.textContent = value;
      return { element, attribute, was };
    });
    return () => {
      held.forEach((slot) => {
        if (!slot) return;
        if (slot.attribute) slot.element.setAttribute(slot.attribute, slot.was);
        else slot.element.textContent = slot.was;
      });
    };
  }, [path]);

  // A page opened at one of its sections (a shared /gym#where) lands that section at the top of the view once the page
  // has drawn and again once its fonts have settled, unless the person has moved the page since it arrived: the browser
  // scrolled the first HTML, which this page replaced.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id || id.startsWith('/')) return;
    const land = () => {
      const section = document.getElementById(id);
      if (movedSinceArrival() || !section) return;
      window.scrollTo({ top: window.scrollY + section.getBoundingClientRect().top, behavior: 'instant' });
    };
    land();
    document.fonts?.ready.then(land);
  }, []);

  // At night <html> is stamped the way scripts/appBoot.js stamps it — theme, brand, the ground and the browser's two
  // metas — so a page reached from a room without a document load is not left with the cream the Shell handed back
  // on its way out. By day <html> is not touched at all.
  useLayoutEffect(() => {
    if (appearance !== 'dark') return undefined;
    const html = document.documentElement;
    html.setAttribute('data-theme', 'dark');
    html.setAttribute('data-brand', 'clay');
    const ground = paintBrowserChrome('dark');
    if (ground) html.style.setProperty('--wm-boot-ground', ground);
    return () => {
      html.removeAttribute('data-theme');
      html.removeAttribute('data-brand');
      html.style.removeProperty('--wm-boot-ground');
      restoreBrowserChrome();
    };
  }, [appearance]);

  return (
    <PageFrame flow className="landing" ref={lendDoorSkin} data-look="instrument" data-theme={appearance === 'dark' ? 'dark' : undefined} header={<>
      <a href="#content" className="skip-link">{t('shell.landing.skipToContent')}</a>
      {header}
      </>}>
      <main id="content">{children}</main>
      {footer}
    </PageFrame>
  );
}

// The magic link this browser is waiting on, or null: re-read when auth answers and dropped the moment it expires.
// The second value is what a door's `onSent` calls.
function usePendingMagicLink(status) {
  const [pendingLink, setPendingLink] = useState(pendingMagicLink);

  useEffect(() => { setPendingLink(pendingMagicLink()); }, [status]);

  useEffect(() => {
    if (!pendingLink) return undefined;
    const timer = setTimeout(() => setPendingLink(pendingMagicLink()), Math.max(0, pendingLink.expiresAt - Date.now()) + 250);
    return () => clearTimeout(timer);
  }, [pendingLink]);

  return [pendingLink, () => setPendingLink(pendingMagicLink())];
}

// The night mark that does not load gives way to the day mark, so the word never stands beside an empty box.
function Brand({ night }) {
  const [nightMissing, setNightMissing] = useState(false);
  const mark = night && !nightMissing ? '/brand-mark-night.svg' : '/brand-mark.svg';
  return (
    <>
      <img src={mark} alt="" width={24} height={24} onError={night ? () => setNightMissing(true) : undefined} />
      <span>Windmill</span>
    </>
  );
}

export function ArrowLink({ href, onFollow, className, children }) {
  return (
    <a className={className ? `front-link ${className}` : 'front-link'} href={href} onClick={onFollow}>
      {children}
      <Icon name="arrow-right" size={14} strokeWidth={2.4} />
    </a>
  );
}

export function SiteHeader({ page, night }) {
  const { user, status, signOut } = useAuth();
  const openSignInDoor = useSignInDoor();
  const [pendingLink, noteLinkSent] = usePendingMagicLink(status);
  // Sign in and the pill stand from the first paint; the seat takes Sign in's place once auth answers for an account.
  const signedIn = status === 'signed-in' && Boolean(user);

  return (
    <header className="front-header">
      <div className="front-wrap front-header-row">
        <a className="front-brand" href="/" aria-label={t('shell.brandLanding.home')} onClick={followed(page, 'header', 'home')}><Brand night={night} /></a>
        <nav className="front-nav" aria-label={t('shell.landing.primaryNav')}>
          {ROOMS.map((product) => (
            <a key={product.id} href={product.landing.href} aria-current={product.id === page ? 'page' : undefined}
              onClick={followed(page, 'header', 'landing', product.id)}>{product.label}</a>
          ))}
          <a href="/pricing.html" onClick={followed(page, 'header', 'pricing')}>{t('shell.site.pricing')}</a>
        </nav>
        <div className="front-cluster">
          {signedIn ? (
            <span className="front-seat">
              <AccountSeat
                user={user}
                status={status}
                size={28}
                display="glyph"
                appearance={false}
                onSettings={() => { used(page, 'settings'); window.location.hash = '#/settings'; }}
                onSignOut={() => { used(page, 'sign_out'); signOut(); }}
              />
            </span>
          ) : pendingLink ? (
            <button type="button" className="front-signin" onClick={() => { used(page, 'link_sent'); openSignInDoor({ resume: pendingMagicLink(), onSent: noteLinkSent }); }}>
              <span className="front-signin-long">{t('shell.landing.linkSent')}</span>
              <span className="front-signin-short">{t('shell.brandLanding.linkSentShort')}</span>
            </button>
          ) : (
            <button type="button" className="front-signin" onClick={() => { used(page, 'sign_in'); openSignInDoor({ onSent: noteLinkSent }); }}>
              {t('shell.auth.signIn')}
            </button>
          )}
          <a className="front-pill" href={signedIn ? homeHash() : '/app'} onClick={followed(page, 'header', 'app')}>{t('shell.brandLanding.open')}</a>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ page, night }) {
  const { choice, set } = useAppearance();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const choose = (next) => {
    if (next === choice) return;
    used(page, 'appearance', { choice: APPEARANCE_LABEL[next] });
    set(next);
  };

  return (
    <>
      <footer>
        <div className="front-wrap front-sitemap front-rule">
          <div className="front-brand"><Brand night={night} /></div>
          <nav className="front-sitemap-columns" aria-label={t('shell.brandLanding.footerNav')}>
            {SITEMAP.map((column) => (
              <div key={column.title}>
                <h2 className="front-sitemap-title">{column.title}</h2>
                <ul>
                  {column.links.map((link) => <li key={link.href}><a href={link.href} onClick={followed(page, 'sitemap', link.to, link.product)}>{link.label}</a></li>)}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <div className="front-wrap front-foot">
          <button type="button" className="front-feedback" onClick={() => { used(page, 'feedback'); setFeedbackOpen(true); }}>{t('shell.feedback.label')}</button>
          <div className="front-switch">
            <SegmentedControl label={t('shell.appearance.label')} options={APPEARANCES} value={choice} onChange={choose} />
          </div>
        </div>
      </footer>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}

// The widest stage the frame holds, or the narrowest scaled down to it: the frame's height needs no picture chunk.
function stageFor(stages, width) {
  const stage = [...stages].reverse().find((each) => each.width <= width) ?? stages[0];
  return { stage, width, scale: width ? Math.min(1, width / stage.width) : 1 };
}

// `id` is the product the picture belongs to, `page` the page it stands on as its events name it, and `route` that
// page's path, for the report a crash sends.
export function PictureFrame({ id, picture, theme, page, route, className }) {
  const body = useRef(null);
  const [fit, setFit] = useState(null);
  const drawn = usePictureMotion(body, { page, product: id, picture: picture.name, route });

  useLayoutEffect(() => {
    const measure = () => setFit((was) => {
      const next = stageFor(picture.stages, body.current.clientWidth);
      return was && was.width === next.width ? was : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body.current);
    return () => observer.disconnect();
  }, [picture.stages]);

  return (
    <figure className={className ? `front-picture ${className}` : 'front-picture'}>
      <figcaption className="front-picture-bar">{picture.label}</figcaption>
      {/* The composed picture is spared a screen reader and holds nothing to focus; its label above is what is said of it. */}
      <div ref={body} className="front-picture-body" aria-hidden="true" data-brand={id} data-theme={theme}
        style={fit ? { height: fit.stage.height * fit.scale } : undefined}>
        {fit && (
          <div className="front-picture-stage"
            style={{ width: fit.width / fit.scale, height: fit.stage.height, transform: fit.scale < 1 ? `scale(${fit.scale})` : undefined }}>
            <ErrorBoundary fallback={null} onCrash={() => reportPicture(id, route)}>
              <Suspense fallback={null}><picture.Picture stage={fit.stage.name} /><PictureDrawn onChange={drawn} /></Suspense>
            </ErrorBoundary>
          </div>
        )}
      </div>
    </figure>
  );
}
