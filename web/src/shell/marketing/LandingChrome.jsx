// The landing family's chrome — roles 1, 8 and 9 of the canon contract, written once for all
// four landings. A landing brings its own sections, its own CTA verb and its own moat; the
// wordmark, the cross-nav, the auth cluster, the legal shelf and the head this page wears are
// the family's. Nothing product-shaped lives here: the cross-nav is read off the registry, so a
// fourth product gets its link the day it registers one.
//
// The rule that made this file necessary: Sign in is a BUTTON that opens the door in place. The
// static journal and gym landings could only hand over a URL — /?signin#/journal — which the
// router read as a door into the journal room, and a signed-out visitor met the night canvas.
// A landing never navigates to sign in.
//
// useScene lives here for the same reason the cross-nav does: the moat rule is a family rule, so
// the way a scene is mounted and torn down is written once, at the bottom of this file.

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../design-system';
import { useAuth } from '../auth/AuthProvider.jsx';
import { AccountSeat } from '../auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../auth/SignInDoor.jsx';
import { pendingMagicLink } from '../auth/AuthClient.js';
import { FeedbackDialog } from '../feedback/FeedbackDialog.jsx';
import { PRODUCTS } from '../products.js';
import { LANDING_HEADS, SITE_ORIGIN } from './landingHeads.js';
import { LEGAL_LINKS, SURFACE_LINKS } from './siteIdentity.js';
import './landing.css';

export function LandingPage({ brand = null, product = null, links = [], cta = null, resume = null, resolving = false, seat = null, children }) {
  const lendDoorSkin = useSignInDoorHost();
  const path = product ? PRODUCTS.find((entry) => entry.id === product).landing.href : '/';

  // The SPA boots from one shell that carries the brand root's head, so whichever landing is
  // mounted wears its own while it is mounted, and hands the head back on the way out. Best
  // effort for crawlers that run JS; the per-path shells the build emits are the honest answer.
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

  // The frame lends the sign-in door its skin, so the modal opens inside this page's own light
  // frame and its brand scope — never inheriting whatever room happens to be mounted elsewhere.
  return (
    <div className="landing" ref={lendDoorSkin} data-brand={brand ?? undefined}>
      <a href="#content" className="skip-link">Skip to content</a>
      <LandingNav product={product} links={links} cta={cta} resume={resume} resolving={resolving} seat={seat} />
      <main id="content">{children}</main>
      <LandingFooter />
    </div>
  );
}

function LandingNav({ product = null, links = [], cta = null, resume = null, resolving = false, seat = null }) {
  return (
    <header className="landing-header">
      <a className="landing-wordmark" href="/">Windmill</a>
      <nav className="navlinks" aria-label="Primary">
        {links.map((link) => <a key={link.href} className="navlinks-page" href={link.href}>{link.label}</a>)}
        {links.length > 0 && <span className="navlinks-divider" aria-hidden="true" />}
        {PRODUCTS.map((entry) => (
          <a
            key={entry.id}
            href={entry.landing.href}
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

// The nav's right cluster — the only place a landing's front door changes, and the reason the
// four landings had to become one runtime. Three faces, and the fourth is deliberately no face
// at all: while auth resolves the slot keeps its exact box but stays invisible, so nothing
// flashes signed-out at somebody who is signed in and nothing jumps when the answer lands.
// Auth is not the only thing that can still be resolving: a product whose own registry has yet
// to answer passes `resolving`, because a stranger's verb shown to a signed-in visitor is the
// same lie as a signed-out cluster — role 9 never claims zero while it is still counting.
function NavCluster({ cta, resume, resolving, seat }) {
  const { user, status, signOut } = useAuth();
  const openSignInDoor = useSignInDoor();
  const [pendingLink, setPendingLink] = useState(pendingMagicLink);

  // Every status flip re-reads the link-sent record — signing out clears it.
  useEffect(() => { setPendingLink(pendingMagicLink()); }, [status]);

  // The chip expires with the link: when the record's fifteen minutes lapse, quietly re-read.
  useEffect(() => {
    if (!pendingLink) return undefined;
    const timer = setTimeout(() => setPendingLink(pendingMagicLink()), Math.max(0, pendingLink.expiresAt - Date.now()) + 250);
    return () => clearTimeout(timer);
  }, [pendingLink]);

  const noteLinkSent = () => setPendingLink(pendingMagicLink());

  if (status === 'loading' || resolving) {
    return (
      <div className="landing-cluster" style={{ visibility: 'hidden' }} aria-hidden="true">
        <Button variant="ghost" size="sm">Sign in</Button>
        {cta && <Button variant="primary" size="sm">{cta.label}</Button>}
      </div>
    );
  }

  // Role 9 — a signed-in visitor is met by the verb that returns them to their own work, and
  // the seat that proves the page knows them. The product decides what resuming means, and
  // `status` decides nothing about it: a pre-open product can still pass a resume, when the work a
  // signed-in visitor would return to is real and reachable. A landing with nothing true to offer
  // passes none and falls back to its CTA, or to nothing at all.
  // The seat's noun, its count and its parting line are the product's to say — the shell owns no
  // sentence about somebody's data — so a landing with nothing true to report passes no `seat` and
  // gets a seat that stays quiet rather than one that guesses.
  if (status === 'signed-in' && user) {
    const verb = resume ?? cta;
    return (
      <div className="landing-cluster">
        {verb && <a href={verb.href}><Button variant="primary" size="sm">{verb.label}</Button></a>}
        <AccountSeat
          user={user}
          status={status}
          size={28}
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
      {cta && <a href={cta.href}><Button variant="primary" size="sm">{cta.label}</Button></a>}
    </div>
  );
}

function LandingFooter() {
  const [feedbackOpen, setFeedbackOpen] = useState(false); // the one contact door — posts anon, no account needed

  return (
    <>
      <footer className="landing-footer">
        <div className="landing-footer-brand">
          <span className="landing-footer-mark">Windmill</span>
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

// Every live vignette on every landing mounts through here — the moat rule's two mechanical
// halves. It is deferred, so building a WebGL world never competes with the visitor's first
// input; and it is torn down, always: on StrictMode's second mount, on a route change, and on a
// visitor who leaves before the idle callback ever fired. `mount` receives the container element
// and hands back its teardown, or nothing at all if it has nothing to undo.
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
