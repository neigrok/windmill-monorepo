// How a picture on the site moves, knowing nothing of what it draws. It writes two attributes on the frame's body, and
// the picture's own sheet moves the picture under them: `data-pointed` while a mouse or pen is on a seen picture, and
// `data-beat` while the beat the sheet starts under it runs. On a device without hover nothing is pointed at: a picture
// plays its beat once, when it has stayed seen for 400ms, one picture at a time across the page.

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
// On a device without hover, a picture seen this long without a break has been looked at, and plays its beat; a flick
// past it plays nothing.
const HOLD_MS = 400;

const told = new Set();
const played = new Set();
const reportedRoutes = new Set();

const hovering = () => window.matchMedia('(hover: hover)').matches;
const pointing = (event) => ['mouse', 'pen'].includes(event.pointerType) && hovering();
const endless = (animation) => animation.effect?.getTiming().iterations === Infinity;
const cut = (animation) => Boolean(animation.effect?.target?.closest('[data-cut]'));

// On a device without hover one beat plays at a time across the page. A picture that falls due while another plays
// waits its turn in the order it fell due; one no longer seen when its turn comes leaves the queue unplayed, free to
// fall due again.
class BeatQueue {
  #playing = false;
  #waiting = [];

  due(motion) {
    if (!this.#playing) {
      this.#play(motion);
      return;
    }
    if (!this.#waiting.includes(motion)) this.#waiting.push(motion);
  }

  #play(motion) {
    this.#playing = true;
    motion.playOnce().finally(() => {
      this.#playing = false;
      while (this.#waiting.length) {
        const next = this.#waiting.shift();
        if (next.due) {
          this.#play(next);
          return;
        }
      }
    });
  }
}

const pageBeats = new BeatQueue();

// With a mouse or pen, arrival is the pointer inside a seen picture, whichever of the two came last: it sets
// `data-pointed`, and `data-beat` while the beat is armed. Departure lets every endless animation finish its cycle, then
// lifts `data-pointed`. Without hover, a picture held in view falls due on the page's beats.
class PictureMotion {
  #body;
  #picture;
  #key;
  #inside = false;
  #seen = false;
  #armed = true;
  #beating = false;
  #leftAt = 0;
  #ending = null;
  #rearming = null;
  #dwelling = null;
  #holding = null;
  #stops = [];
  #off = false;

  constructor(body, picture) {
    this.#body = body;
    this.#picture = picture;
    this.#key = `${picture.page} ${picture.product} ${picture.picture}`;
  }

  // A picture still waiting its turn on the page's beats plays only if it is still seen and has not played.
  get due() {
    return !this.#off && this.#seen && !played.has(this.#key);
  }

  start() {
    this.#guarded(() => {
      this.#listen('pointerenter', (event) => { if (pointing(event)) this.#enter(); });
      this.#listen('pointerleave', () => { if (this.#inside) this.#leave(); });
      const observer = new IntersectionObserver(this.#guarded(([entry]) => {
        const seen = entry.intersectionRatio >= SEEN || entry.intersectionRect.height >= SEEN * entry.rootBounds.height;
        const changed = seen !== this.#seen;
        this.#seen = seen;
        if (hovering()) this.#arrive();
        else if (changed) this.#hold();
      }), { threshold: SEEN_STEPS });
      observer.observe(this.#body);
      this.#stops.push(() => observer.disconnect());
    })();
  }

  stop() {
    this.#off = true;
    this.#stops.forEach((stop) => stop());
    [this.#rearming, this.#dwelling, this.#holding].forEach(clearTimeout);
    this.#body.removeAttribute('data-pointed');
    this.#body.removeAttribute('data-beat');
  }

  // The page's beats call this when the picture's turn comes. It always settles, so the queue moves on.
  playOnce() {
    played.add(this.#key);
    return this.#guarded(() => this.#beat())() ?? Promise.resolve();
  }

  #listen(type, handle) {
    const guarded = this.#guarded(handle);
    this.#body.addEventListener(type, guarded);
    this.#stops.push(() => this.#body.removeEventListener(type, guarded));
  }

  // Seen, the picture falls due after it has stayed seen 400ms; unseen, the wait ends.
  #hold() {
    clearTimeout(this.#holding);
    if (!this.due) return;
    this.#holding = setTimeout(this.#guarded(() => pageBeats.due(this)), HOLD_MS);
  }

  #enter() {
    this.#inside = true;
    clearTimeout(this.#rearming);
    if (!told.has(this.#key)) {
      this.#dwelling = setTimeout(this.#guarded(() => {
        told.add(this.#key);
        const { page, product, picture } = this.#picture;
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
    return Promise.allSettled(beat.map((animation) => animation.finished)).then(this.#guarded(() => {
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

  // A loop plays to the end of the cycle it is in and stops there, where it rests; one on or inside an element marked
  // `data-cut` stops at once.
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
      if (this.#off) return undefined;
      try {
        return run(...args);
      } catch (error) {
        this.stop();
        const { route } = this.#picture;
        if (!reportedRoutes.has(route)) {
          reportedRoutes.add(route);
          captureError('render', 'front-picture-motion', error?.stack ?? '', route);
        }
        return undefined;
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
