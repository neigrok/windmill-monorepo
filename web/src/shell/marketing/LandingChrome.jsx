// The chrome every landing wears: wordmark, cross-nav, auth cluster, legal shelf and head. Sign in
// opens the door in place; a landing never navigates to sign in.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BrandWordmark, Button } from '../../design-system';
import { useAuth } from '../auth/AuthProvider.jsx';
import { AccountSeat } from '../auth/AccountSeat.jsx';
import { AppearanceToggle } from './AppearanceToggle.jsx';
import { useSignInDoor, useSignInDoorHost } from '../auth/SignInDoor.jsx';
import { pendingMagicLink } from '../auth/AuthClient.js';
import { FeedbackDialog } from '../feedback/FeedbackDialog.jsx';
import { PRODUCTS } from '../products.js';
import { useAppearance } from '../useAppearance.js';
import { paintBrowserChrome, restoreBrowserChrome } from '../appearance.js';
import { LANDING_HEADS, SITE_ORIGIN } from './landingHeads.js';
import { LEGAL_LINKS, SURFACE_LINKS } from './siteIdentity.js';
import './landing.css';

// `anchored` is the brand root's: its product links scroll to that product's section on the same page.
export function LandingPage({ brand = null, product = null, links = [], cta = null, resume = null, resolving = false, seat = null, anchored = false, children }) {
  const lendDoorSkin = useSignInDoorHost();
  const { resolved: appearance } = useAppearance();
  const path = product ? PRODUCTS.find((entry) => entry.id === product).landing.href : '/';

  // A landing wears its own head while mounted and hands the brand root's back on the way out.
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

  // At night <html> is stamped the way scripts/appBoot.js stamps it — theme, brand, the ground and
  // the browser's two metas — so a landing reached from a room without a document load is not left
  // with the cream the Shell handed back on its way out. By day <html> is not touched at all.
  useLayoutEffect(() => {
    if (appearance !== 'dark') return undefined;
    const html = document.documentElement;
    html.setAttribute('data-theme', 'dark');
    html.setAttribute('data-brand', brand ?? 'clay');
    const ground = paintBrowserChrome('dark');
    if (ground) html.style.setProperty('--wm-boot-ground', ground);
    return () => {
      html.removeAttribute('data-theme');
      html.removeAttribute('data-brand');
      html.style.removeProperty('--wm-boot-ground');
      restoreBrowserChrome();
    };
  }, [appearance, brand]);

  // By day the frame carries data-brand alone and takes the hue onto the family cream; at night it adds
  // data-theme, and palettes.css keys the room's ground on the pair.
  return (
    <div className="landing" ref={lendDoorSkin} data-brand={brand ?? undefined} data-theme={appearance === 'dark' ? 'dark' : undefined}>
      <a href="#content" className="skip-link">Skip to content</a>
      <LandingNav product={product} links={links} cta={cta} resume={resume} resolving={resolving} seat={seat} anchored={anchored} />
      <main id="content">{children}</main>
      <LandingFooter />
    </div>
  );
}

function LandingNav({ product = null, links = [], cta = null, resume = null, resolving = false, seat = null, anchored = false }) {
  return (
    <header className="landing-header">
      <a className="landing-wordmark" href="/"><BrandWordmark /></a>
      <nav className="navlinks" aria-label="Primary">
        {links.map((link) => <a key={link.href} className="navlinks-page" href={link.href}>{link.label}</a>)}
        {links.length > 0 && <span className="navlinks-divider" aria-hidden="true" />}
        {/* The anchored root draws a band only for an open product, so only an open product has an
            anchor to reach; a closed one keeps its own landing as its destination. */}
        {PRODUCTS.map((entry) => (
          <a
            key={entry.id}
            href={anchored && entry.shell.status === 'open' ? `#${entry.id}` : entry.landing.href}
            aria-current={entry.id === product ? 'page' : undefined}
          >
            {entry.label}
          </a>
        ))}
        <a href="/pricing.html">Pricing</a>
      </nav>
      <NavCluster cta={cta} resume={resume} resolving={resolving} seat={seat} />
    </header>
  );
}

// The Light · Dark toggle opens the cluster in every state — it does not wait on auth — and on a
// landing it is the one place appearance is chosen, so the seat's pop-up draws no Appearance row
// here. While auth (or the product's `resolving`) is unanswered the buttons keep their box but stay
// invisible, so nothing flashes signed-out; only the seat is absent until the answer comes. Signed
// out, the ghost seat still stands beside the buttons.
function NavCluster({ cta, resume, resolving, seat }) {
  const { user, status, signOut } = useAuth();
  const openSignInDoor = useSignInDoor();
  const [pendingLink, setPendingLink] = useState(pendingMagicLink);

  useEffect(() => { setPendingLink(pendingMagicLink()); }, [status]);

  useEffect(() => {
    if (!pendingLink) return undefined;
    const timer = setTimeout(() => setPendingLink(pendingMagicLink()), Math.max(0, pendingLink.expiresAt - Date.now()) + 250);
    return () => clearTimeout(timer);
  }, [pendingLink]);

  const noteLinkSent = () => setPendingLink(pendingMagicLink());

  if (status === 'loading' || resolving) {
    return (
      <div className="landing-cluster">
        <AppearanceToggle />
        <span style={{ display: 'contents', visibility: 'hidden' }} aria-hidden="true">
          <Button variant="ghost" size="sm">Sign in</Button>
          {cta && <Button variant="primary" size="sm">{cta.label}</Button>}
        </span>
      </div>
    );
  }

  if (status === 'signed-in' && user) {
    const verb = resume ?? cta;
    return (
      <div className="landing-cluster">
        <AppearanceToggle />
        {verb && <a href={verb.href}><Button variant="primary" size="sm">{verb.label}</Button></a>}
        <AccountSeat
          user={user}
          status={status}
          size={28}
          appearance={false}
          footer={seat?.note}
          mine={seat && verb ? { label: seat.label, count: seat.count ?? null, onSelect: () => { window.location.href = verb.href; } } : undefined}
          onSettings={() => { window.location.hash = '#/settings'; }}
          onSignOut={signOut}
        />
      </div>
    );
  }

  return (
    <div className="landing-cluster">
      <AppearanceToggle />
      {pendingLink ? (
        <button
          type="button"
          className="landing-linksent"
          onClick={() => openSignInDoor({ resume: pendingMagicLink(), onSent: noteLinkSent })}
        >
          <i aria-hidden="true" />
          Link sent — check your email
        </button>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => openSignInDoor({ onSent: noteLinkSent })}>Sign in</Button>
      )}
      {cta && <Button variant="primary" size="sm" href={cta.href}>{cta.label}</Button>}
      <AccountSeat
        status={status}
        size={28}
        appearance={false}
        onSignIn={() => openSignInDoor({ onSent: noteLinkSent })}
        onSettings={() => { window.location.hash = '#/settings'; }}
      />
    </div>
  );
}

function LandingFooter() {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <>
      <footer className="landing-footer">
        <div className="landing-footer-brand">
          <BrandWordmark className="landing-footer-mark" size={22} />
          © 2026
        </div>
        <div className="landing-footer-shelf">
          <div className="landing-footer-row">
            {LEGAL_LINKS.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)}
            <button type="button" onClick={() => setFeedbackOpen(true)}>Feedback</button>
          </div>
          <div className="landing-footer-row">
            {PRODUCTS.map((entry) => <a key={entry.id} href={entry.landing.href}>{entry.label}</a>)}
            {SURFACE_LINKS.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)}
          </div>
        </div>
      </footer>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}

// `mount` takes the container element and returns its teardown, or nothing.
export function useScene(mount, deps = []) {
  const ref = useRef(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let teardown = null;
    const start = () => { teardown = mount(element); };
    const canIdle = 'requestIdleCallback' in window;
    const pending = canIdle ? requestIdleCallback(start, { timeout: 500 }) : setTimeout(start, 200);
    return () => {
      if (canIdle) cancelIdleCallback(pending);
      else clearTimeout(pending);
      teardown?.();
    };
  }, deps);

  return ref;
}
