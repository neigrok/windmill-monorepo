// Two scales, one row each: [label][track][numeral]. Identity is carried three times over — the mono
// word, the hue, and the head shape (mood a circle, energy a capsule, the same two shapes DayMarker
// draws). The track is a snapping scrubber with eleven stops: tap anywhere or drag, 0 is a real answer,
// and the numeral is the clear affordance. Nothing here grades anything.
//
// Motion is a ladder governed by one number — k = |v-5|/5, zero in the middle and one at BOTH ends — so
// a 0 pays exactly what a 10 pays. On top of the baseline sit four named events at the four ends: the
// surge (energy 10), the flare (mood 10), the ground (energy 0), the hold (mood 0). Every animation is
// declarative CSS on a node that does not exist at rest; there is no requestAnimationFrame in this file
// and nothing here loops. Nothing here animates a layout property either: the head and the fill ride
// on transforms, so a commit and a drag both reflow zero times (scales.md §6.13).

import React, { useCallback, useEffect, useRef, useState } from 'react';

const STOPS = 10;
const KEY_SETTLE = 260;      // keyboard commits every keystroke; the bloom waits for the traffic to stop
const NUMERAL_SWAP = 140;    // the old numeral leaves before the new one arrives
const PLAYED_MIN = 50;       // ms — a timeline shorter than this did not play, whatever it declares

// The head is owned by one event at a time: a new extreme cancels the previous one's timeline the way
// clearFx cancels its overlay. Cascade order, not recency, decides which of two live classes paints.
const HEAD_EVENTS = ['is-blooming', 'is-ticking', 'is-surging', 'is-setting-down', 'is-holding'];

const TRACK_TITLE = {
  mood: 'Mood — tap or drag, 0 to 10. Optional.',
  energy: 'Energy — tap or drag, 0 to 10. Optional.',
};
const LABEL = { mood: 'MOOD', energy: 'ENERGY' };
const NAME = { mood: 'Mood', energy: 'Energy' };
const CLEAR_LABEL = { mood: 'Clear mood', energy: 'Clear energy' };

const PAIR_KEY = (day) => `journal.pair.${day}`;

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isNight(el) {
  return el?.closest('.journal-root')?.dataset?.theme !== 'light';
}

// Every timeline here is a timeout that must not outlive the row, and must not accumulate either:
// eighty events on one row used to leave eighty spent ids in an array that only unmount ever emptied.
function useTimers() {
  const ids = useRef(new Set());
  useEffect(() => () => { ids.current.forEach(clearTimeout); ids.current.clear(); }, []);
  return useCallback((ms, fn) => {
    const id = setTimeout(() => { ids.current.delete(id); fn(); }, ms);
    ids.current.add(id);
  }, []);
}

// ─── the strip ────────────────────────────────────────────────────────────────────────────────────

export function ScaleStrip({ day = null, mood = null, energy = null, onMood, onEnergy, why = null }) {
  const bloomRef = useRef(null);
  const after = useTimers();

  // The pair bloom is the one capped moment on the strip, and it is capped because completion happens
  // once — not to ration anything. Both scales set today, and not both set earlier in this local day.
  // A completion that lands on a mood 10 arrives in the same beat as the flare, and neither bloom may
  // erase the other.
  const onCommit = useCallback((field, value) => {
    const other = field === 'mood' ? energy : mood;
    if (value == null || other == null || !day) return;
    const layer = bloomRef.current;
    if (!layer) return;
    const key = PAIR_KEY(day);
    try {
      if (localStorage.getItem(key) === 'shown') return;
    } catch {
      return;   // no storage — the strip would rather never bloom than bloom on every commit
    }
    const bloom = bloomInto(layer, 'is-pair');

    // NEVER SPEND A ONCE-A-DAY KEY ON AN ANIMATION THAT DID NOT PLAY. The key is written on
    // animationstart, and a computed duration under PLAYED_MIN counts as never played — a global
    // reduced-motion clamp, a hidden ancestor, a mount cut short, a tab backgrounded on the beat.
    // The bloom being invisible is a bug; the moment being spent while it is invisible is a loss.
    bloom.addEventListener('animationstart', () => {
      const declared = getComputedStyle(bloom).animationDuration;
      const ms = declared.endsWith('ms') ? parseFloat(declared) : parseFloat(declared) * 1000;
      if (!(ms >= PLAYED_MIN)) return;
      try { localStorage.setItem(key, 'shown'); } catch { /* unwritable storage: the moment is still owed */ }
    }, { once: true });
    after(1400, () => bloom.remove());

    if (reducedMotion()) return;   // the row fills do not breathe; the layer's fade is the whole event
    // Staggered by ROW, never by the fills that happen to exist: a row resting at 0 draws no fill, and
    // indexing the fills would hand the second row's delay to the first.
    const rows = layer.parentElement?.querySelectorAll('.journal-track') ?? [];
    rows.forEach((row, index) => {
      const fill = row.querySelector('.journal-track-fill');
      if (!fill) return;
      fill.classList.add('is-breathing');
      fill.style.animationDelay = `${index * 90}ms`;
      after(1100, () => {
        fill.classList.remove('is-breathing');
        fill.style.removeProperty('animation-delay');
        tidy(fill);
      });
    });
  }, [day, mood, energy, after]);

  return (
    <>
      <div className="journal-controls" role="group" aria-label="How the day felt">
        <span className="journal-strip-fx" aria-hidden="true" ref={bloomRef} />
        <ScaleRow field="mood" value={mood} onChange={onMood} onCommit={onCommit} bloomRef={bloomRef} />
        <ScaleRow field="energy" value={energy} onChange={onEnergy} onCommit={onCommit} bloomRef={bloomRef} />
        <svg className="journal-fx-defs" aria-hidden="true" focusable="false">
          <defs>
            <filter id="journal-surge-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.2" />
            </filter>
          </defs>
        </svg>
      </div>
      {why && <p className="journal-scale-why">{why}</p>}
    </>
  );
}

// ─── one scale ────────────────────────────────────────────────────────────────────────────────────

function ScaleRow({ field, value, onChange, onCommit, bloomRef }) {
  const trackRef = useRef(null);
  const labelRef = useRef(null);
  const numeralRef = useRef(null);
  const fxRef = useRef(null);
  const dragRef = useRef(null);          // { pointerId, from } while a gesture is live
  const keyRef = useRef(null);           // { timer, from } while keyboard traffic is settling
  const lagRef = useRef(false);          // the next numeral change waits for the old one to leave
  const liveRef = useRef(null);          // the drag's current stop, readable inside the same task
  const [live, setLive] = useState(null);
  const [pressed, setPressed] = useState(false);
  const [shown, setShown] = useState(value);
  const after = useTimers();

  const display = live ?? value;

  useEffect(() => () => { if (keyRef.current) clearTimeout(keyRef.current.timer); }, []);

  useEffect(() => {
    if (!lagRef.current) { setShown(display); return undefined; }
    lagRef.current = false;
    const timer = setTimeout(() => setShown(display), NUMERAL_SWAP);
    return () => clearTimeout(timer);
  }, [display]);

  // ── the commit animation ──
  // Deferred by one turn on purpose: the value's own classes (is-floor, is-ceiling, is-set) and the
  // numeral button arrive with React's render, and every timeline below is drawn on top of them.
  const commit = useCallback((next, from) => {
    if (next == null || next === from) return;   // the change-guard: re-committing buys nothing
    onCommit(field, next);
    after(0, () => {
      const track = trackRef.current;
      if (!track) return;
      const k = Math.abs(next - 5) / 5;
      track.style.setProperty('--k', String(k));
      labelRef.current?.style.setProperty('--k', String(k));
      const soft = reducedMotion();
      const fx = fxRef.current;
      track.querySelector('.journal-head')?.classList.remove(...HEAD_EVENTS);

      // The events that own the head take it over; the rest of the baseline still plays under them.
      const owned = next === 0 || (next === 10 && field === 'energy');
      playEmberSettle({ track, label: labelRef.current, numeral: numeralRef.current, owned, soft, after });
      if (next === 10 && field === 'energy') playSurge({ track, fx, soft, after });
      if (next === 10 && field === 'mood') playFlare({ track, fx, bloom: bloomRef.current, soft, after });
      if (next === 0 && field === 'energy') playGround({ track, fx, soft, after });
      if (next === 0 && field === 'mood') playHold({ track, fx, soft, after });

      // Every timeline that reads --k has closed by now; the track's own style attribute is React's,
      // so only the property is withdrawn there.
      after(1400, () => {
        track.style.removeProperty('--k');
        labelRef.current?.style.removeProperty('--k');
        tidy(labelRef.current);
      });
    });
  }, [field, onCommit, bloomRef, after]);

  const send = (next, from) => {
    lagRef.current = true;
    onChange(next);
    commit(next, from);
  };

  // ── pointer: tap anywhere, or drag ──
  const onPointerDown = (event) => {
    if (event.button != null && event.button !== 0) return;
    const track = trackRef.current;
    track.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, from: value };
    hideGhost(track);
    setPressed(true);
    liveRef.current = stopAt(track, event.clientX);
    setLive(liveRef.current);
  };

  const onPointerMove = (event) => {
    const track = trackRef.current;
    if (!dragRef.current) {
      if (event.pointerType === 'mouse') moveGhost(track, event.clientX, display);
      return;
    }
    const next = stopAt(track, event.clientX);
    if (next === liveRef.current) return;
    liveRef.current = next;
    playStopTick(track, after);
    setLive(next);
  };

  // The drag's stop is read from the ref, never from the render closure: a pointerdown and a pointerup
  // delivered in ONE task would otherwise commit the value the gesture started from.
  const endDrag = (event) => {
    const track = trackRef.current;
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setPressed(false);
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    const next = liveRef.current ?? drag.from;
    liveRef.current = null;
    setLive(null);
    if (next != null) send(next, drag.from);
  };

  // ── keyboard ──
  const onKeyDown = (event) => {
    const step = (delta) => (value == null ? 5 : clamp(value + delta));
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = step(+1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = step(-1);
    else if (event.key === 'PageUp') next = step(+2);
    else if (event.key === 'PageDown') next = step(-2);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 10;
    else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); clear(); return; }
    else return;
    event.preventDefault();
    if (next === value) return;

    // The value lands on every keystroke; the bloom waits, so holding a key does not strobe.
    const from = keyRef.current ? keyRef.current.from : value;
    if (keyRef.current) clearTimeout(keyRef.current.timer);
    lagRef.current = true;
    onChange(next);
    keyRef.current = {
      from,
      timer: setTimeout(() => { keyRef.current = null; commit(next, from); }, KEY_SETTLE),
    };
  };

  const clear = () => {
    if (value == null) return;
    if (keyRef.current) { clearTimeout(keyRef.current.timer); keyRef.current = null; }
    lagRef.current = true;
    clearFx(fxRef.current);
    onChange(null);
  };

  // The head, the fill and the numeral follow the DISPLAYED value, so a pointerdown on an unset track
  // shows a value at once rather than making the writer commit before seeing one. The two PERMANENT
  // marks follow the COMMITTED one: a mark is a statement about an answer, and one that flashed while
  // a drag crossed an end would be both false and a reward per scrub (scales.md §6.3.1).
  const marks = value === 10 ? ' is-ceiling' : value === 0 ? ' is-floor' : '';
  const state = display == null ? ' is-unset' : ' is-set';
  const empty = display == null || display === 0 ? ' is-empty' : '';   // nothing to fill at 0
  const headFill = field === 'mood' ? `var(--mood-${display ?? 0})` : 'var(--journal-energy)';

  return (
    <>
      <span className="journal-scale-label" aria-hidden="true" ref={labelRef}>{LABEL[field]}</span>
      <div
        ref={trackRef}
        className={`journal-track journal-track-${field}${state}${marks}${empty}${pressed ? ' is-pressed' : ''}`}
        style={{ '--pos': display ?? 0, '--head-fill': headFill }}
        role="slider"
        tabIndex={0}
        aria-label={NAME[field]}
        aria-valuemin={0}
        aria-valuemax={10}
        {...(display == null ? {} : { 'aria-valuenow': display })}
        aria-valuetext={display == null ? 'not set' : `${display} of 10`}
        aria-orientation="horizontal"
        title={TRACK_TITLE[field]}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={(event) => { if (!dragRef.current) hideGhost(event.currentTarget); }}
        onKeyDown={onKeyDown}
      >
        <span className="journal-track-bed" />
        <span className="journal-track-ticks" aria-hidden="true">
          {Array.from({ length: STOPS + 1 }, (unused, i) => (
            <span key={i} className="journal-tick-dot" style={{ '--i': i }} />
          ))}
        </span>
        <span className="journal-track-fill"><span className="journal-track-fill-bar" /></span>
        <span className="journal-stop-rail journal-ghost-rail" aria-hidden="true">
          <span className="journal-ghost" />
        </span>
        <span className="journal-stop-rail journal-head-rail" aria-hidden="true">
          <span className="journal-head" />
        </span>
        <span className="journal-track-fx" aria-hidden="true" ref={fxRef} />
      </div>
      {value == null
        ? <span className="journal-numeral is-unset" aria-hidden="true">—</span>
        : (
          <button
            type="button"
            ref={numeralRef}
            className="journal-numeral"
            title="clear"
            aria-label={CLEAR_LABEL[field]}
            onClick={clear}
          >
            {shown ?? value}
          </button>
        )}
    </>
  );
}

// ─── geometry ─────────────────────────────────────────────────────────────────────────────────────

function clamp(value) {
  return Math.max(0, Math.min(STOPS, value));
}

// The head's centre runs between the insets, so the stops are spaced across the travel, not the bed.
function stopAt(track, clientX) {
  const box = track.getBoundingClientRect();
  const inset = parseFloat(getComputedStyle(track).getPropertyValue('--journal-inset')) || 7;
  const travel = Math.max(1, box.width - inset * 2);
  return clamp(Math.round(((clientX - box.left - inset) / travel) * STOPS));
}

// The ghost previews where a tap would land: pointer only, suppressed under a live drag and at the
// stop the real head already occupies. It follows the cursor without transition.
function moveGhost(track, clientX, current) {
  const stop = stopAt(track, clientX);
  if (stop === current) { hideGhost(track); return; }
  track.style.setProperty('--ghost', String(stop));
  track.classList.add('is-previewing');
  const lit = track.querySelector('.journal-tick-dot.is-lit');
  if (lit) lit.classList.remove('is-lit');
  track.querySelectorAll('.journal-tick-dot')[stop]?.classList.add('is-lit');
}

function hideGhost(track) {
  track.classList.remove('is-previewing');
  track.querySelector('.journal-tick-dot.is-lit')?.classList.remove('is-lit');
}

// ─── the motion ladder ────────────────────────────────────────────────────────────────────────────

// Restart a declarative timeline from zero, and take will-change away again when it is over. A newer
// event that took the element over owns the cleanup too, so an older timer never cuts it short.
function play(el, className, ms, after, willChange = null) {
  if (!el) return;
  el.classList.remove(className);
  getComputedStyle(el).animationName;   // flush STYLE to restart the timeline; offsetWidth would reflow
  if (willChange) el.style.willChange = willChange;
  el.classList.add(className);
  after(ms + 40, () => {
    if (!el.classList.contains(className)) return;
    el.classList.remove(className);
    el.style.removeProperty('will-change');
    tidy(el);
  });
}

// An element left carrying `style=""` is not identical to one that never carried the attribute, and
// "identical to rest" is the whole leak check. React writes its own style attribute on the track; on
// everything else here the attribute is ours alone and goes when it is empty.
function tidy(el) {
  if (el && el.getAttribute('style') === '') el.removeAttribute('style');
}

// Firing a new extreme event cancels and synchronously removes the previous one.
function clearFx(fx) {
  if (fx) fx.replaceChildren();
}

function layer(fx, className) {
  clearFx(fx);
  const node = document.createElement('span');
  node.className = className;
  fx.appendChild(node);
  return node;
}

// The pair bloom and the flare's underlight share one layer and one implementation at different
// colours and origins. Only a bloom of the SAME kind is replaced: completing the pair ON a mood 10
// fires both within a turn of each other, and either wiping the other spends a once-a-day moment on
// a bloom nobody sees.
function bloomInto(host, className, x = null) {
  host.querySelectorAll(`.journal-bloom.${className}`).forEach((old) => old.remove());
  const node = document.createElement('span');
  node.className = `journal-bloom ${className}`;
  if (x != null) node.style.setProperty('--bloom-x', `${x}px`);
  host.appendChild(node);
  node.addEventListener('animationend', () => node.remove(), { once: true });
  return node;
}

// The ember settle — the baseline, and the substrate under every event. Never during a drag.
function playEmberSettle({ track, label, numeral, owned, soft, after }) {
  const head = track.querySelector('.journal-head');
  const fill = track.querySelector('.journal-track-fill');
  if (!soft) {
    if (!owned) play(head, 'is-blooming', 320, after, 'transform');
    play(fill, 'is-washing', 600, after, 'background-position');
  }
  play(numeral, 'is-rising', 280, after);
  play(label, 'is-answering', 700, after);   // kept in full under reduced motion: colour, no motion
}

function playStopTick(track, after) {
  if (reducedMotion()) return;
  play(track.querySelector('.journal-head'), 'is-ticking', 90, after, 'transform');
}

// ── the surge, energy 10 ──
// An SVG overlay built once per fire, animated entirely by CSS, removed on the last animationend.
// Night layers a blurred halo under a hot core; day is one struck pass over a sparser composition,
// because density adds light on dark and ink on paper.
function playSurge({ track, fx, soft, after }) {
  const box = track.getBoundingClientRect();
  const night = isNight(track);
  const phone = box.height > 32;
  const inset = parseFloat(getComputedStyle(track).getPropertyValue('--journal-inset')) || 7;
  const width = box.width;
  const svg = buildSurge({ width, height: box.height, inset, night, phone, still: soft });
  clearFx(fx);
  fx.appendChild(svg);

  const last = svg.querySelector('.journal-surge-last');
  last.addEventListener('animationend', () => svg.remove(), { once: true });
  after(soft ? 560 : 320, () => svg.remove());

  if (soft) return;
  play(track.querySelector('.journal-track-fill'), 'is-hot', 260, after, 'filter');
  play(track.querySelector('.journal-head'), 'is-surging', 1320, after, 'transform');
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD_X = 12;
const PAD_Y = 24;

function buildSurge({ width, height, inset, night, phone, still }) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'journal-surge');
  svg.setAttribute('width', String(width + PAD_X * 2));
  svg.setAttribute('height', String(height + PAD_Y * 2));
  svg.setAttribute('viewBox', `0 0 ${width + PAD_X * 2} ${height + PAD_Y * 2}`);

  const x0 = PAD_X;
  const x1 = PAD_X + width - inset;   // the arc spans the lit part of the track; at 10 that is all of it
  const y = PAD_Y + height / 2;
  const span = x1 - x0;
  const amps = phone ? [11, 17, 7] : [9, 14, 6];

  const beats = still
    ? [{ mains: dayOrNight(night, amps), branches: 2, className: 'journal-surge-still journal-surge-last' }]
    : [
      { mains: dayOrNight(night, amps), branches: 2, className: 'journal-surge-beat beat-a' },
      { mains: dayOrNight(night, amps), branches: 2, className: 'journal-surge-beat beat-b' },
      { mains: [amps[1]], branches: 2, className: 'journal-surge-beat beat-c journal-surge-last' },
    ];

  for (const beat of beats) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', beat.className + (night ? ' is-night' : ' is-day'));
    const mains = beat.mains.map((amp) => arcPoints(x0, x1, y, amp, 9));
    const branches = Array.from({ length: beat.branches }, () => branchPoints(mains[randomIndex(mains.length)], span));
    const strokes = [
      ...mains.map((points) => ({ points, main: true })),
      ...branches.map((points) => ({ points, main: false })),
    ];
    if (night) for (const stroke of strokes) group.appendChild(polyline(stroke, 'halo'));
    for (const stroke of strokes) group.appendChild(polyline(stroke, 'core'));
    svg.appendChild(group);
  }
  return svg;
}

// Day takes beat C's composition at every beat: fewer, heavier strokes, no halo.
function dayOrNight(night, amps) {
  return night ? amps : [amps[1]];
}

function polyline(stroke, pass) {
  const node = document.createElementNS(SVG_NS, 'polyline');
  node.setAttribute('class', `journal-arc is-${pass}` + (stroke.main ? ' is-main' : ' is-branch'));
  node.setAttribute('points', stroke.points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
  if (pass === 'halo') node.setAttribute('filter', 'url(#journal-surge-glow)');
  return node;
}

// Lightning is not a random walk. The sign alternates, so every fire is a zig-zag; the magnitude is
// floored, so no fire is a straight line. Deterministic amplitude, random detail.
function arcPoints(x0, x1, y, amplitude, segments) {
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const env = Math.sin(Math.PI * t);
    const sign = i % 2 === 0 ? 1 : -1;
    const mag = 0.55 + 0.45 * Math.random();
    points.push([x0 + (x1 - x0) * t, y + sign * mag * amplitude * env]);
  }
  return points;
}

function branchPoints(main, span) {
  const vertex = main[1 + randomIndex(main.length - 2)];
  const reach = span * (0.22 + 0.12 * Math.random()) * (Math.random() < 0.5 ? -1 : 1);
  return arcPoints(vertex[0], vertex[0] + reach, vertex[1], 7, 4);
}

function randomIndex(length) {
  return Math.floor(Math.random() * Math.max(1, length));
}

// ── the flare, mood 10 ──
// The lamp opens: two rings expand, light runs the track backwards out of the head, six motes rise,
// the strip is warmly underlit.
function playFlare({ track, fx, bloom, soft, after }) {
  const host = layer(fx, 'journal-flare-layer');
  [0, 1].forEach((index) => {
    const ring = document.createElement('span');
    ring.className = 'journal-flare-ring';
    ring.style.setProperty('--d', `${index * 120}ms`);
    ring.style.setProperty('--dur', index === 0 ? '720ms' : '860ms');
    host.appendChild(ring);
  });

  if (!soft) {
    for (let i = 0; i < 6; i++) {
      const mote = document.createElement('span');
      mote.className = 'journal-mote';
      mote.style.setProperty('--mx', `${(Math.random() * 20 - 10).toFixed(1)}px`);
      mote.style.setProperty('--my', `${(-(18 + Math.random() * 16)).toFixed(1)}px`);
      mote.style.setProperty('--mo', (0.6 + Math.random() * 0.4).toFixed(2));
      mote.style.setProperty('--mdur', `${Math.round(900 + Math.random() * 400)}ms`);
      mote.style.animationDelay = `${Math.round(Math.random() * 160)}ms`;
      host.appendChild(mote);
    }
    play(track.querySelector('.journal-track-fill'), 'is-wicking', 620, after, 'background-position');
  }
  if (bloom) {
    const head = track.querySelector('.journal-head');
    const stripBox = bloom.parentElement.getBoundingClientRect();
    const headBox = head.getBoundingClientRect();
    const node = bloomInto(bloom, 'is-flare', headBox.left + headBox.width / 2 - stripBox.left);
    after(1400, () => node.remove());
  }
  after(soft ? 460 : 1400, () => host.remove());
}

// ── the ground, energy 0 ──
// The charge leaves, the track shows its whole empty range once, the head sets down, and a ground rule
// strikes and stays. A floor that crackled would be a lie; a floor with no event would be worse.
function playGround({ track, fx, soft, after }) {
  clearFx(fx);
  if (soft) {
    play(track.querySelector('.journal-track-bed'), 'is-dipping', 360, after);
    return;
  }
  play(track.querySelector('.journal-track-bed'), 'is-sweeping', 540, after, 'background-position');
  play(track.querySelector('.journal-head'), 'is-setting-down', 380, after, 'transform');
  play(track, 'is-grounding', 480, after);
  const mote = document.createElement('span');
  mote.className = 'journal-mote is-falling';
  const host = layer(fx, 'journal-ground-layer');
  host.appendChild(mote);
  after(760, () => host.remove());
}

// ── the hold, mood 0 ──
// The ember dims almost to nothing and comes back; one ring contracts inward and lands as the mark.
function playHold({ track, fx, soft, after }) {
  clearFx(fx);
  play(track.querySelector('.journal-head'), 'is-holding', soft ? 500 : 900, after);
  if (soft) return;
  play(track.querySelector('.journal-track-bed'), 'is-sweeping', 540, after, 'background-position');
  const host = layer(fx, 'journal-hold-layer');
  const ring = document.createElement('span');
  ring.className = 'journal-hold-ring';
  host.appendChild(ring);
  after(1060, () => host.remove());
}
