// How a picture on the site moves, knowing nothing of what it draws. Once the picture has drawn, the frame writes two
// attributes on its body and the picture's own sheet answers under them: `data-pointed` while a mouse or pen, on a
// device whose primary pointer hovers, is inside the picture (every part's hover response and every loop stand under
// it), and `data-beat` while the beat the sheet starts under it runs. On a device without hover nothing is pointed at:
// a picture plays its beat once, when it has stayed seen for 400ms, one picture at a time across the page.

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { track } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';

// A picture is seen while at least 60% of it is in view, or it covers at least 60% of the view's height.
const SEEN = 0.6;
const SEEN_STEPS = Array.from({ length: 101 }, (_, step) => step / 100);
// A beat plays again only once it has ended and the pointer has been out of the picture this long.
const REARM_MS = 2400;
// A pointer resting this long on a seen picture, with the page still, has looked at it, and the picture tells so once.
const DWELL_MS = 1000;
// On a device without hover, a picture seen this long without a break has been looked at, and plays its beat; a flick
// past it plays nothing.
const HOLD_MS = 400;
// A beat ends when the animations it started have finished, or at this ceiling, whichever comes first.
const BEAT_CEILING_MS = 10000;

const told = new Set();
const played = new Set();
const reportedRoutes = new Set();

const hovering = () => window.matchMedia('(hover: hover)').matches;
// The pointers the frame counts: a mouse or a pen on a device whose primary pointer hovers. A finger never counts.
const counted = (event) => ['mouse', 'pen'].includes(event.pointerType) && hovering();
const endless = (animation) => animation.effect?.getTiming().iterations === Infinity;
const cut = (animation) => Boolean(animation.effect?.target?.closest('[data-cut]'));

// On a device without hover one beat plays at a time across the page. A picture that falls due while another plays
// waits its turn in the order it fell due; one no longer due when its turn comes leaves the queue unplayed, free to
// fall due again after a fresh hold.
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

// Nothing moves before the picture has drawn. Pointed is a counted pointer inside; arrival is pointed and seen,
// whichever came last, and plays the beat while it is armed. Departure lets every endless animation finish its cycle,
// then lifts `data-pointed`. Without hover, a picture held in view falls due on the page's beats.
class PictureMotion {
  #body;
  #picture;
  #key;
  #pointers = new Set();
  #drawn = false;
  #seen = false;
  #held = false;
  #armed = true;
  #beating = false;
  #leftAt = 0;
  #ending = null;
  #rearming = null;
  #dwelling = null;
  #holding = null;
  #ceiling = null;
  #stops = [];
  #off = false;

  constructor(body, picture) {
    this.#body = body;
    this.#picture = picture;
    this.#key = `${picture.page} ${picture.product} ${picture.picture}`;
  }

  // A picture plays on the page's beats only if, at its turn, it is drawn, seen, has held for a full 400ms since it
  // last became seen, and has not played.
  get due() {
    return !this.#off && this.#drawn && this.#seen && this.#held && !played.has(this.#key);
  }

  get #inside() {
    return this.#pointers.size > 0;
  }

  start() {
    this.#guarded(() => {
      this.#listen(this.#body, 'pointerenter', (event) => { if (counted(event)) this.#enter(event.pointerId); });
      this.#listen(this.#body, 'pointerleave', (event) => { if (this.#pointers.has(event.pointerId)) this.#leave(event.pointerId); });
      this.#listen(window, 'scroll', () => { if (this.#dwelling) this.#dwell(); });
      const observer = new IntersectionObserver(this.#guarded(([entry]) => {
        this.#see(entry.intersectionRatio >= SEEN || entry.intersectionRect.height >= SEEN * entry.rootBounds.height);
      }), { threshold: SEEN_STEPS });
      observer.observe(this.#body);
      this.#stops.push(() => observer.disconnect());
    })();
  }

  // The picture has committed inside the frame, or left it.
  draw(drawn) {
    this.#guarded(() => {
      this.#drawn = drawn;
      if (!drawn) {
        [this.#dwelling, this.#holding].forEach(clearTimeout);
        this.#body.removeAttribute('data-pointed');
        this.#body.removeAttribute('data-beat');
        return;
      }
      this.#point();
      this.#hold();
      this.#dwell();
    })();
  }

  // Stopping never throws: a failed picture is left wholly still, and React's unmount is never interrupted.
  stop() {
    this.#off = true;
    const steps = [...this.#stops, () => [this.#rearming, this.#dwelling, this.#holding, this.#ceiling].forEach(clearTimeout),
      () => this.#body.removeAttribute('data-pointed'), () => this.#body.removeAttribute('data-beat')];
    for (const step of steps) {
      try {
        step();
      } catch {
        // A step that cannot run has nothing left to undo.
      }
    }
  }

  // The page's beats call this when the picture's turn comes. It always settles, so the queue moves on.
  playOnce() {
    played.add(this.#key);
    return this.#guarded(() => this.#beat())() ?? Promise.resolve();
  }

  #listen(target, type, handle) {
    const guarded = this.#guarded(handle);
    target.addEventListener(type, guarded, { passive: true });
    this.#stops.push(() => target.removeEventListener(type, guarded));
  }

  #see(seen) {
    const changed = seen !== this.#seen;
    this.#seen = seen;
    if (hovering()) this.#point();
    else if (changed) this.#hold();
    if (changed) this.#dwell();
  }

  #enter(pointer) {
    this.#pointers.add(pointer);
    clearTimeout(this.#rearming);
    this.#point();
    this.#dwell();
  }

  #leave(pointer) {
    this.#pointers.delete(pointer);
    this.#dwell();
    if (this.#inside) return;
    this.#leftAt = performance.now();
    this.#rearm();
    this.#depart();
  }

  #point() {
    if (!this.#inside || !this.#drawn) return;
    if (this.#ending) {
      this.#ending.loops.forEach((loop) => {
        loop.effect.updateTiming({ iterations: Infinity });
        if (loop.playState !== 'running') loop.play();
      });
      this.#ending = null;
    }
    this.#body.toggleAttribute('data-pointed', true);
    if (this.#seen && this.#armed) this.#beat();
  }

  // Without hover a drawn picture falls due once it has stayed seen for 400ms; becoming unseen starts its hold over.
  #hold() {
    clearTimeout(this.#holding);
    this.#held = false;
    if (hovering() || !this.#drawn || !this.#seen || played.has(this.#key)) return;
    this.#holding = setTimeout(this.#guarded(() => {
      this.#held = true;
      pageBeats.due(this);
    }), HOLD_MS);
  }

  // A counted pointer resting on a drawn, seen picture for a second, with the page still, has looked at it. Entering,
  // leaving, a scroll and becoming seen or unseen each start the second over.
  #dwell() {
    clearTimeout(this.#dwelling);
    this.#dwelling = null;
    if (told.has(this.#key) || !this.#inside || !this.#drawn || !this.#seen) return;
    this.#dwelling = setTimeout(this.#guarded(() => {
      this.#dwelling = null;
      if (told.has(this.#key)) return;
      told.add(this.#key);
      const { page, product, picture } = this.#picture;
      track('front_picture', { page, product, picture });
    }), DWELL_MS);
  }

  // The beat is what the picture's sheet starts under `data-beat`: the attribute stays until all of it has finished, or
  // until the ceiling, so no beat can hold the page.
  #beat() {
    this.#armed = false;
    this.#beating = true;
    const before = new Set(this.#body.getAnimations({ subtree: true }));
    this.#body.setAttribute('data-beat', '');
    const beat = this.#body.getAnimations({ subtree: true }).filter((animation) => !before.has(animation) && !endless(animation));
    const ceiling = new Promise((resolve) => { this.#ceiling = setTimeout(resolve, BEAT_CEILING_MS); });
    return Promise.race([Promise.allSettled(beat.map((animation) => animation.finished)), ceiling]).then(this.#guarded(() => {
      clearTimeout(this.#ceiling);
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

  // A failure in here leaves the picture wholly still, ends its front_picture, and reports once per page load for each
  // page, naming the picture.
  #guarded(run) {
    return (...args) => {
      if (this.#off) return undefined;
      try {
        return run(...args);
      } catch (error) {
        this.stop();
        const { route, product, picture } = this.#picture;
        if (!reportedRoutes.has(route)) {
          reportedRoutes.add(route);
          captureError('render', 'front-picture-motion', error?.stack ?? '', route, { product, picture });
        }
        return undefined;
      }
    };
  }
}

// `picture` names what the frame shows: the `page` it stands on, the `product` it belongs to, the `picture` itself and
// the `route` a failure reports under. It returns what PictureDrawn calls as the picture commits and leaves.
export function usePictureMotion(body, { page, product, picture, route }) {
  const motion = useRef(null);
  const drawn = useRef(false);
  useEffect(() => {
    const started = new PictureMotion(body.current, { page, product, picture, route });
    motion.current = started;
    started.start();
    if (drawn.current) started.draw(true);
    return () => {
      started.stop();
      motion.current = null;
    };
  }, [body, page, product, picture, route]);
  return useCallback((isDrawn) => {
    drawn.current = isDrawn;
    motion.current?.draw(isDrawn);
  }, []);
}

// Placed beside the picture inside its Suspense boundary, it commits only with the picture's content: a picture still
// loading, or one whose chunk failed, never tells the frame it has drawn.
export function PictureDrawn({ onChange }) {
  useLayoutEffect(() => {
    onChange(true);
    return () => onChange(false);
  }, [onChange]);
  return null;
}
