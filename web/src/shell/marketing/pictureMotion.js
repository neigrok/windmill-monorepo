// How a picture on the site answers the pointer, knowing nothing of what it draws. It writes two attributes on the
// frame's body, `data-pointed` and `data-beat`, and the picture's own sheet moves the picture under them.

import { useEffect } from 'react';
import { track } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';

// A picture is seen while at least 60% of it is in view, or it covers at least 60% of the view's height.
const SEEN = 0.6;
const SEEN_STEPS = Array.from({ length: 101 }, (_, step) => step / 100);
// A beat plays again only once it has ended and the pointer has been out of the picture this long.
const REARM_MS = 2400;
// A pointer that stays this long on a picture has looked at it, and the picture tells so once.
const DWELL_MS = 1000;

const told = new Set();
const reportedRoutes = new Set();

const pointing = (event) => ['mouse', 'pen'].includes(event.pointerType) && window.matchMedia('(hover: hover)').matches;
const endless = (animation) => animation.effect?.getTiming().iterations === Infinity;
const cut = (animation) => Boolean(animation.effect?.target?.closest('[data-cut]'));

// Arrival is a mouse or pen inside a seen picture, whichever of the two came last: it sets `data-pointed`, and
// `data-beat` while the beat is armed. Departure lets every endless animation finish its cycle, then lifts `data-pointed`.
class PictureMotion {
  #body;
  #picture;
  #inside = false;
  #seen = false;
  #armed = true;
  #beating = false;
  #leftAt = 0;
  #ending = null;
  #rearming = null;
  #dwelling = null;
  #stops = [];
  #off = false;

  constructor(body, picture) {
    this.#body = body;
    this.#picture = picture;
  }

  start() {
    this.#guarded(() => {
      this.#listen('pointerenter', (event) => { if (pointing(event)) this.#enter(); });
      this.#listen('pointerleave', () => { if (this.#inside) this.#leave(); });
      const observer = new IntersectionObserver(this.#guarded(([entry]) => {
        this.#seen = entry.intersectionRatio >= SEEN || entry.intersectionRect.height >= SEEN * entry.rootBounds.height;
        this.#arrive();
      }), { threshold: SEEN_STEPS });
      observer.observe(this.#body);
      this.#stops.push(() => observer.disconnect());
    })();
  }

  stop() {
    this.#off = true;
    this.#stops.forEach((stop) => stop());
    [this.#rearming, this.#dwelling].forEach(clearTimeout);
    this.#body.removeAttribute('data-pointed');
    this.#body.removeAttribute('data-beat');
  }

  #listen(type, handle) {
    const guarded = this.#guarded(handle);
    this.#body.addEventListener(type, guarded);
    this.#stops.push(() => this.#body.removeEventListener(type, guarded));
  }

  #enter() {
    this.#inside = true;
    clearTimeout(this.#rearming);
    const { page, product, picture } = this.#picture;
    const key = `${page} ${product} ${picture}`;
    if (!told.has(key)) {
      this.#dwelling = setTimeout(this.#guarded(() => {
        told.add(key);
        track('front_picture', { page, product, picture });
      }), DWELL_MS);
    }
    this.#arrive();
  }

  #leave() {
    this.#inside = false;
    this.#leftAt = performance.now();
    clearTimeout(this.#dwelling);
    this.#rearm();
    this.#depart();
  }

  #arrive() {
    if (!this.#inside || !this.#seen) return;
    if (this.#ending) {
      this.#ending.loops.forEach((loop) => {
        loop.effect.updateTiming({ iterations: Infinity });
        if (loop.playState !== 'running') loop.play();
      });
      this.#ending = null;
    }
    this.#body.toggleAttribute('data-pointed', true);
    if (this.#armed) this.#beat();
  }

  // The beat is what the picture's sheet starts under `data-beat` and ends: the attribute stays until all of it has.
  #beat() {
    this.#armed = false;
    this.#beating = true;
    const before = new Set(this.#body.getAnimations({ subtree: true }));
    this.#body.setAttribute('data-beat', '');
    const beat = this.#body.getAnimations({ subtree: true }).filter((animation) => !before.has(animation) && !endless(animation));
    Promise.allSettled(beat.map((animation) => animation.finished)).then(this.#guarded(() => {
      this.#beating = false;
      this.#body.removeAttribute('data-beat');
      this.#rearm();
    }));
  }

  #rearm() {
    clearTimeout(this.#rearming);
    if (this.#inside || this.#beating || this.#armed) return;
    this.#rearming = setTimeout(this.#guarded(() => { this.#armed = true; }), Math.max(0, this.#leftAt + REARM_MS - performance.now()));
  }

  // A loop plays to the end of the cycle it is in and stops there, where it rests, unless it is marked to cut.
  #depart() {
    if (this.#ending || !this.#body.hasAttribute('data-pointed')) return;
    const loops = this.#body.getAnimations({ subtree: true }).filter(endless);
    const playing = loops.filter((loop) => !cut(loop));
    loops.filter(cut).forEach((loop) => loop.cancel());
    playing.forEach((loop) => loop.effect.updateTiming({ iterations: (loop.effect.getComputedTiming().currentIteration ?? 0) + 1 }));
    const ending = { loops };
    this.#ending = ending;
    Promise.allSettled(playing.map((loop) => loop.finished)).then(this.#guarded(() => {
      if (this.#ending !== ending) return;
      this.#ending = null;
      this.#body.removeAttribute('data-pointed');
    }));
  }

  // A failure in here leaves the still picture and reports once per page load for each page.
  #guarded(run) {
    return (...args) => {
      if (this.#off) return;
      try {
        run(...args);
      } catch (error) {
        this.stop();
        const { route } = this.#picture;
        if (reportedRoutes.has(route)) return;
        reportedRoutes.add(route);
        captureError('render', 'front-picture-motion', error?.stack ?? '', route);
      }
    };
  }
}

// `picture` names what the frame shows: the `page` it stands on, the `product` it belongs to, the `picture` itself
// and the `route` a failure reports under.
export function usePictureMotion(body, { page, product, picture, route }) {
  useEffect(() => {
    const motion = new PictureMotion(body.current, { page, product, picture, route });
    motion.start();
    return () => motion.stop();
  }, [body, page, product, picture, route]);
}
