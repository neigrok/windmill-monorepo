// THE ADDRESSED PAGE. On a wide screen the canvas is a vertical scroll of dated pages, several on
// screen at once, and the margin describes exactly ONE of them. Which one used to be invisible: the
// panel picked its page by a scroll waterline and then drew that page's echoes with nothing tying the
// two together — an unattributed assertion, in a feature whose whole rule is that an echo may only
// assert something the reader can check from what is on screen.
//
// The tie is three parts of one mark and they all read ONE day. What is tested here is what is a rule
// rather than a pixel: which day each part names, when the aiming half may not be drawn at all, the
// two faces the panel's mode puts on it, and the ordering of the swap that carries the whole mark from
// one page to the next without ever showing two.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { findByClass, loadScreen, renderHook, settle } from '../../gym/harness.mjs';
import { stampWeekday } from '../../../../src/products/journal/echoes/echoDates.js';

const { EchoMargin, aimMark, bandTop, tieAim, trailBottom } = await loadScreen('products/journal/echoes/EchoMargin.jsx');

const CSS = readFileSync(new URL('../../../../src/products/journal/journal.css', import.meta.url), 'utf8');
const MARGIN_SOURCE = readFileSync(new URL('../../../../src/products/journal/echoes/EchoMargin.jsx', import.meta.url), 'utf8');
// The claims below are about code, not prose — and this file's prose names the very APIs it moved off.
const MARGIN = MARGIN_SOURCE.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const CANVAS = readFileSync(new URL('../../../../src/products/journal/Canvas.jsx', import.meta.url), 'utf8');
const MARKER = readFileSync(new URL('../../../../src/products/journal/DayMarker.jsx', import.meta.url), 'utf8');

const PAGE = {
  day: '2026-08-28',                 // a Friday
  entitled: true,
  matches: [{ day: '2026-05-02', text: 'the older words', useful: false, withheldWords: 0 }],
};
const OTHER = { ...PAGE, day: '2026-07-04' };

function echoesWith(over = {}) {
  return {
    canvas: null,
    verify: () => {},
    walkTo: () => {},
    openSheet: () => {},
    markUseful: () => {},
    retireMatch: () => {},
    followScroll: () => {},
    lit: null,
    settling: null,
    swapping: false,
    marginDay: PAGE.day,
    heldDay: null,
    ...over,
  };
}

const draw = (echoes, page, sheeted = false) =>
  renderToStaticMarkup(React.createElement(EchoMargin, { echoes, page, sheeted }));

// ─── the aiming rule: where it points, and the four ways it may not be drawn ──────────────────────
//
// `tieAim` is the whole of the visibility rule, and every clause of it is a measurement. It is pure
// so that "the line points at a row the reader cannot see" is a case a test can state, rather than a
// judgement that needs a browser and a fling at the right speed.

const FRAME = { top: 0, bottom: 600, height: 600 };
const rowAt = (top) => ({ top, bottom: top + 16 });

test('the rule aims at the centre of the addressed row’s own date stamp, and straddles it', () => {
  assert.equal(tieAim(rowAt(300), FRAME), 307.25);        // centre 308, less half the 1.5px weight
  assert.equal(tieAim(rowAt(0), FRAME), 7.25);
});

test('no rect, no frame, no rule — a row the canvas is not holding is not a row to point at', () => {
  assert.equal(tieAim(null, FRAME), null);
  assert.equal(tieAim(rowAt(300), null), null);
  assert.equal(tieAim(null, null), null);
});

test('a row outside the scroll frame gets no line: a mark that aims off screen aims at nothing', () => {
  assert.equal(tieAim(rowAt(-40), FRAME), null, 'flung off the top');
  assert.equal(tieAim(rowAt(700), FRAME), null, 'below the frame');
  // exactly on each edge is inside the frame, and drawn
  assert.equal(tieAim({ top: -8, bottom: 8 }, FRAME), -0.75);
  assert.equal(tieAim({ top: 592, bottom: 608 }, FRAME), 599.25);
});

test('the trail occludes the top of the canvas, so a row under it is a row the reader cannot see', () => {
  // `.je-trail` is z-index 4 and covers the top of the canvas during a walk. The rule is z-index 2,
  // so it would be occluded WITH the row — but the stub in the panel's head would not be, and the
  // stub is the same glyph answering the same question. So the band is measured, not left to z-order.
  assert.equal(tieAim(rowAt(20), FRAME, 120), null, 'a row under the trail still got a line');
  assert.equal(tieAim(rowAt(200), FRAME, 120), 207.25);
  // and a trail shorter than the frame's own top never widens the band
  assert.equal(tieAim(rowAt(-40), FRAME, -200), null);
});

// ─── the drawing itself, driven ───────────────────────────────────────────────────────────────────
//
// `aimMark` is one frame of the mark. It is asserted by RUNNING it, not by matching the source that
// calls it: a rule can be left parked off screen for ever without a single line of this file
// changing, and an assertion over source text proves only that a line is still written.

const markPair = () => {
  const el = () => {
    const styles = new Map();
    return { hidden: false, style: { setProperty: (k, v) => styles.set(k, v) }, read: (k) => styles.get(k) };
  };
  return { rule: el(), stub: el() };
};

test('a frame of the mark writes the row’s centre, converted out of viewport space', () => {
  const { rule, stub } = markPair();
  const y = aimMark({ rule, stub, rootTop: 52, stampRect: rowAt(300), frame: FRAME });
  assert.equal(y, 307.25);
  assert.equal(rule.read('--je-tie-y'), '255.25px', 'the shell’s 52px offset was not taken off');
  assert.equal(rule.hidden, false);
  assert.equal(stub.hidden, false);

  // a root at the viewport's own origin needs no correction
  const plain = markPair();
  aimMark({ rule: plain.rule, stub: plain.stub, rootTop: 0, stampRect: rowAt(300), frame: FRAME });
  assert.equal(plain.rule.read('--je-tie-y'), '307.25px');
});

test('BOTH HALVES GET THE SAME ANSWER — a rule that aims while its stub hides is two answers', () => {
  for (const [why, args] of [
    ['no rect at all', { stampRect: null, frame: FRAME }],
    ['no scroll frame', { stampRect: rowAt(300), frame: null }],
    ['flung off the top', { stampRect: rowAt(-40), frame: FRAME }],
    ['below the frame', { stampRect: rowAt(700), frame: FRAME }],
    ['under the trail', { stampRect: rowAt(20), frame: FRAME, trailBottom: 120 }],
  ]) {
    const { rule, stub } = markPair();
    assert.equal(aimMark({ rule, stub, rootTop: 52, ...args }), null, why);
    assert.equal(rule.hidden, true, `the rule stayed drawn: ${why}`);
    assert.equal(stub.hidden, true, `the stub outlived the rule: ${why}`);
    assert.equal(rule.read('--je-tie-y'), undefined, `a hidden rule was still aimed: ${why}`);
  }
});

test('a hidden mark comes back the moment its row is back in the band, both halves together', () => {
  const { rule, stub } = markPair();
  aimMark({ rule, stub, rootTop: 52, stampRect: rowAt(-40), frame: FRAME });
  assert.equal(rule.hidden, true);
  aimMark({ rule, stub, rootTop: 52, stampRect: rowAt(200), frame: FRAME });
  assert.equal(rule.hidden, false);
  assert.equal(stub.hidden, false);
  assert.equal(rule.read('--je-tie-y'), '155.25px');
});

test('the band the mark refuses to leave is the band the stamp scrolls a row INTO', () => {
  // One function, two callers: if these ever disagreed the stamp would land a row exactly where the
  // mark refuses to point at it, which is the dead press the trail already produced once.
  assert.equal(bandTop(FRAME), 0);
  assert.equal(bandTop(FRAME, 157.5), 157.5);
  assert.equal(bandTop(FRAME, -200), 0, 'a trail above the frame never widens the band');
  // the row's CENTRE is what has to clear the bar, not its top: half a row still under the trail is
  // half a row the reader cannot read, and the line would point into the bar
  assert.equal(tieAim(rowAt(130), FRAME, 157.5), null, 'centre 138, still under a trail ending at 157.5');
  assert.equal(tieAim(rowAt(150), FRAME, 157.5), 157.25, 'centre 158, just clear of it');
  assert.match(MARGIN, /scroller\.scrollTop \+= article\.getBoundingClientRect\(\)\.top - bandTop\(frame, trailBottom\(marginRef\.current\)\);/);
  assert.ok(!MARGIN.includes("scrollIntoView"),
    'the stamp is scrolling to the frame top again, which is under the trail on a walked-to page');
});

test('the trail is looked for one node ABOVE the panel, where it actually hangs', () => {
  // Scoped to the panel this finds nothing, the band widens to the whole frame, and the mark points
  // at a row under an opaque bar — with every source regex in this file still matching. So the node
  // it starts from is asserted by handing it a panel that would answer differently either way.
  const at = (bottom) => ({ getBoundingClientRect: () => ({ bottom }) });
  const panel = {
    querySelector: () => at(999),                    // there is no trail inside the panel; if this
    parentElement: { querySelector: (s) => (s === '.je-trail' ? at(157.5) : null) },
  };
  assert.equal(trailBottom(panel), 157.5, 'the search started inside the panel instead of above it');
  assert.equal(trailBottom({ parentElement: { querySelector: () => null } }), null, 'no walk is up');
  assert.equal(trailBottom(null), null);
  assert.equal(trailBottom(undefined), null);
  // and the band it feeds narrows by exactly that much
  assert.equal(tieAim(rowAt(130), FRAME, trailBottom(panel)), null);
  assert.equal(tieAim(rowAt(130), FRAME, trailBottom(null)), 137.25);
});

test('the tracker re-aims on every fact it depends on, and aims once before any of them move', () => {
  // Each of these is a way the rule silently stops tracking: never aimed at all, or aimed once and
  // never again when the panel changes page.
  assert.match(MARGIN, /\n    aim\(\);\n/, 'nothing aims the rule until the first scroll');
  assert.match(MARGIN, /\}, \[drawn, canvas, page\?\.day\]\);/,
    'the rule no longer re-aims when the panel changes page, is drawn, or gets a new canvas');
  // The band is measured, not left to z-order: the rule would be occluded by the trail along with the
  // row, but the STUB sits inside the panel and would not be — and the two must answer the same.
  assert.match(MARGIN, /trailBottom: trailBottom\(marginRef\.current\),/, 'the trail no longer narrows the band');
});

// ─── the five conditions, and the two that are not measurements ───────────────────────────────────

test('with no page under the waterline there is no rule, no stub and no stamp — only the rest line', () => {
  const html = draw(echoesWith({ marginDay: null }), null);
  assert.ok(!html.includes('je-tie'), 'a rule was drawn for a page that does not exist');
  assert.ok(!html.includes('je-margin-stub'));
  assert.ok(!html.includes('je-margin-head'), 'a head with nothing to name');
  // OVERRULED 2026-09-02: the rest line stays. The drawn tie is built around it, never instead of it.
  assert.match(html, /class="je-margin-rest">No echo on this page\./);
  assert.match(html, /class="je-margin-body is-resting"/);
});

test('under the One sheet the rule HIDES rather than dimming with the panel — the stamp carries the tie alone', () => {
  const sheeted = draw(echoesWith(), PAGE, true);
  assert.ok(!sheeted.includes('je-tie'), 'the rule dimmed to 0.26 with the panel instead of going');
  assert.ok(!sheeted.includes('je-margin-stub'), 'the stub outlived the rule it is the near end of');
  // and the naming half is untouched: the panel still says which page it is describing
  assert.match(sheeted, new RegExp(`class="je-margin-stamp"[^>]*>${stampWeekday(PAGE.day)}<`));

  const open = draw(echoesWith(), PAGE, false);
  assert.match(open, /class="je-tie"/);
  assert.match(open, /class="je-margin-stub"/);
});

test('the sheet is ONE fact, decided where the class is set, so the panel and the rule cannot disagree', () => {
  const APP = readFileSync(new URL('../../../../src/products/journal/JournalApp.jsx', import.meta.url), 'utf8');
  assert.match(APP, /\(sheetPage \? ' is-sheeted' : ''\)/);
  assert.match(APP, /sheeted=\{Boolean\(sheetPage\)\}/);
  assert.match(CSS, /\.journal-root\.is-sheeted \.journal-scroll,\n\.journal-root\.is-sheeted \.je-margin \{ opacity: 0\.26; \}/);
});

// ─── one day, named in three places ───────────────────────────────────────────────────────────────

test('THE TIE AND THE PANEL CANNOT NAME DIFFERENT DAYS — every part reads the one page it was handed', () => {
  const html = draw(echoesWith({ marginDay: PAGE.day }), PAGE);
  const stamp = stampWeekday(PAGE.day);
  assert.equal(stamp, 'FRI 28 AUG');
  assert.match(html, new RegExp(`aria-label="Go to ${stamp}"`));
  assert.match(html, new RegExp(`>${stamp}<`));
  assert.ok(!html.includes(stampWeekday(OTHER.day)), 'a second day was named somewhere in the panel');

  // The panel is handed ONE page, and the rule is drawn by the same component off the same prop —
  // there is no second pick to disagree with. The tracker aims at that page and no other.
  assert.match(MARGIN, /stampRect: scroller && stampRect \? stampRect\(page\.day\) : null,/);
  assert.ok(!MARGIN.includes('marginDay ?'), 'the panel is picking a day of its own again');
  // The one place the panel reads the ADDRESSED day rather than the shown one is the network check,
  // which draws nothing: there is no reason to delay a re-location by the length of a fade.
  assert.match(MARGIN, /useEffect\(\(\) => \{ if \(echoes\.marginDay\) verify\(echoes\.marginDay\); \}/);
});

test('the frame hands the panel the day the SWAP is showing, and the canvas lights that same day', () => {
  const APP = readFileSync(new URL('../../../../src/products/journal/JournalApp.jsx', import.meta.url), 'utf8');
  assert.match(APP, /const shownPage = echoes\.shownDay \? echoes\.pageOf\(echoes\.shownDay\) : null;/);
  assert.match(CANVAS, /const addressedDay = echoes\?\.shownDay \?\? null;/);
  assert.match(CANVAS, /addressed=\{day\.date === addressedDay\}/);
  assert.match(CANVAS, /addressed=\{today === addressedDay\}/);
  // the lit row is colour and NOTHING else — a weight change would reflow a sticky row
  assert.match(MARKER, /'journal-marker' \+ \(addressed \? ' is-addressed' : ''\)/);
  assert.match(CSS, /\.journal-marker\.is-addressed \.journal-meta \{ color: var\(--je-addressed\); \}/);
  const litRow = /\.journal-marker\.is-addressed \.journal-meta \{([^}]*)\}/.exec(CSS)[1];
  for (const forbidden of ['background', 'border', 'font-weight', 'padding', 'margin', 'height']) {
    assert.ok(!litRow.includes(forbidden), `the lit row changes ${forbidden}, which moves the canvas`);
  }
});

test('the stamp is the day row’s own glyph run, today included — a copy, never a destination', () => {
  // `.journal-meta` and `.je-margin-stamp` are matched by SHAPE before they are read, so the two
  // share one format function and one type spec. The trail keeps TONIGHT; a mirror does not.
  assert.match(MARKER, /import \{ stampWeekday \} from '\.\/echoes\/echoDates\.js';/);
  assert.match(MARKER, /\{stampWeekday\(date\)\}/);
  assert.ok(!MARKER.includes('const WEEKDAYS'), 'DayMarker is stamping dates a second way');
  assert.equal(stampWeekday('2026-08-31'), 'MON 31 AUG');
  const meta = /\.journal-meta \{([^}]*)\}/.exec(CSS)[1];
  const stamp = /\.je-margin-stamp \{([^}]*)\}/.exec(CSS)[1];
  for (const face of ['12px', '0.04em', 'var(--font-mono)']) {
    assert.ok(meta.includes(face) && stamp.includes(face), `the stamp and the day row differ on ${face}`);
  }
});

// ─── the two faces, and letting go ────────────────────────────────────────────────────────────────

test('ONE VARIABLE CARRIES THE BINARY: the rule lands when the panel is held, and tapers when it follows', () => {
  const following = draw(echoesWith({ heldDay: null }), PAGE);
  assert.match(following, /class="je-tie"/);
  assert.ok(!following.includes('Follow again'), 'a following panel offered to follow again');

  const held = draw(echoesWith({ heldDay: PAGE.day }), PAGE);
  assert.match(held, /class="je-tie is-held"/);
  assert.match(held, /class="je-margin-follow"[^>]*>Follow again</);

  // NOTHING ON THE CANVAS DISTINGUISHES THE TWO: one place per fact, and the canvas never has to
  // explain the panel's mode.
  assert.ok(!CSS.includes('is-addressed.is-held') && !CSS.includes('journal-marker.is-held'));
  assert.match(CSS, /\.je-tie\.is-held \.je-tie-mark \{ background: var\(--je-tie\); \}/);
  assert.match(CSS, /background: linear-gradient\(to right, var\(--je-tie\) 0 60%, transparent 100%\);/);
});

test('held is read off the page the panel is DESCRIBING, never off a tab that asked for another one', () => {
  // Mid-swap the reader has already moved the hold; the panel has not finished leaving the old page.
  // The face has to belong to what is on screen, or for 90ms the mark says it lands on a page it is
  // not pointing at.
  const midSwap = draw(echoesWith({ heldDay: OTHER.day, marginDay: OTHER.day, swapping: true }), PAGE);
  assert.match(midSwap, /class="je-tie is-out"/);
  assert.ok(!midSwap.includes('is-held'), 'the rule wore the new page’s face while drawing the old one');
  assert.ok(!midSwap.includes('Follow again'));
  assert.match(midSwap, /class="je-margin-swap is-out"/);
});

test('the swap moves both halves of the mark on ONE clock, and the gap never shows two', () => {
  const out = draw(echoesWith({ swapping: true }), PAGE);
  assert.match(out, /class="je-tie is-out"/);
  assert.match(out, /class="je-margin-swap is-out"/);

  const settled = draw(echoesWith({ swapping: false }), PAGE);
  assert.ok(!settled.includes('is-out'));

  // A GAP, not a cross-fade: for the length of a cross-fade there would be two rules on screen
  // pointing at two pages. One element, one opacity, so two cannot exist.
  assert.match(CSS, /\.je-tie \{[^}]*transition: opacity var\(--je-swap\) var\(--ease-standard\);/);
  assert.match(CSS, /\.je-margin-swap \{[^}]*transition: opacity var\(--je-swap\) var\(--ease-standard\);/s);
  assert.match(CSS, /--je-swap: 90ms;/);
  assert.match(CSS, /\.je-tie\.is-out \{ opacity: 0; \}/);
  assert.match(CSS, /\.je-margin-swap\.is-out \{ opacity: 0; \}/);
});

test('the arrival’s ramp and the swap sit on two nodes, because on one they would fight', async (t) => {
  // `.je-margin-body.is-arrival` is an `animation` with a fill mode, and a filled animation pins
  // opacity against any transition on the SAME element — so a swap away from a page that had just
  // been lit would not fade at all. On two nodes they multiply, which is what it has to do.
  assert.match(CSS, /\.je-margin-body\.is-arrival \{ animation: journal-fade-in var\(--je-kindle-in\)/);
  assert.ok(!/\.je-margin-body \{[^}]*animation:/s.test(CSS), 'the body carries an animation again');
  assert.ok(!/\.je-margin-swap \{[^}]*animation:/s.test(CSS), 'the swap carries an animation');

  const now = Date.now();
  const echoes = echoesWith({ lit: { day: PAGE.day, landedAt: now, kindledAt: now, count: 1 }, swapping: true });
  const run = renderHook(t, () => EchoMargin({ echoes, page: PAGE }));
  await settle(6);
  const body = findByClass(run.tree, 'je-margin-body')[0];
  const swap = findByClass(run.tree, 'je-margin-swap')[0];
  assert.match(body.props.className, /is-arrival/, 'the arrival ramp was dropped by the swap');
  assert.match(swap.props.className, /is-out/, 'and the swap was swallowed by the arrival');
});

// ─── the geometry, the band it sits in, and the one number that moves ─────────────────────────────

test('the rule leaves the measure’s right edge and lands on the panel’s own border', () => {
  const tie = /\.je-tie \{([^}]*)\}/.exec(CSS)[1];
  // the canvas area's centre, the measure's half, and breath past `.journal-glyphs`
  assert.match(tie, /left: calc\(50% - var\(--je-gutter\) \/ 2 \+ 320px \+ 10px\);/);
  assert.match(tie, /right: var\(--je-gutter\);/);
  assert.match(tie, /height: 1\.5px;/);
  assert.match(tie, /z-index: 2;/);
  assert.match(tie, /pointer-events: none;/);
  // TRANSFORM ONLY. Never `top`, never `width`: a per-frame write that laid out would cost a layout
  // on every scroll frame of the canvas.
  assert.match(tie, /transform: translateY\(var\(--je-tie-y\)\);/);
  assert.ok(!/\btop:\s*var\(--je-tie-y\)/.test(tie) && !/width:\s*var\(--je-tie-y\)/.test(tie));
  assert.match(MARGIN, /rule\.style\.setProperty\('--je-tie-y', `\$\{y - rootTop\}px`\);/);
  assert.ok(!MARGIN.includes('style.top') && !MARGIN.includes('style.width'));
});

test('the y is converted out of viewport space, because the root is not where the viewport starts', () => {
  // `tieAim` compares rects, so it answers in VIEWPORT px. The rule is `position: absolute` inside
  // `.journal-root`, which is `position: fixed` — but the app shell's `.wm-room` carries
  // `contain: layout paint`, and that makes it the containing block for fixed descendants. Measured
  // in headless Chrome at 1440x900: `.journal-root` sits at viewport y=52, under the shell's header,
  // and a translate that assumed the two spaces were the same put the rule 52px below its own row.
  const { rule } = markPair();
  aimMark({ rule, rootTop: 52, stampRect: rowAt(400), frame: FRAME });
  assert.equal(rule.read('--je-tie-y'), '355.25px');
  assert.match(MARGIN, /rootTop: root\.getBoundingClientRect\(\)\.top,/);
});

test('the resting mark leaves room to rise, or the hover raise is a rule that does nothing', () => {
  const rest = Number(/--je-tie-rest:\s*([\d.]+);/.exec(CSS)[1]);
  assert.ok(rest > 0 && rest < 1, `--je-tie-rest is ${rest}: a raise to opacity 1 has nowhere to come from`);
  assert.match(CSS, /\.je-tie-mark \{[^}]*opacity: var\(--je-tie-rest\);/s);
  assert.match(CSS, /:has\(\.je-margin:hover\) \.je-tie-mark,\n\.journal-root:has\(\.je-margin:focus-within\) \.je-tie-mark \{ opacity: 1; \}/);
});

test('an un-aimed rule is parked outside the root’s clip, so no frame draws a line across the top', () => {
  assert.match(CSS, /--je-tie-y: -100px;/);
  assert.match(CSS, /\.journal-root \{[^}]*overflow: hidden;/s);
});

test('the rule sits above the canvas and below every panel, so nothing needs a z-index but the rule', () => {
  const z = (selector) => {
    // Anchored: `.je-home` is also restated indented inside a media query, and that copy has no z.
    const block = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'ms').exec(CSS);
    return Number(/z-index:\s*(-?\d+)/.exec(block[1])[1]);
  };
  assert.equal(z('.journal-scroll'), 1);
  assert.equal(z('.je-tie'), 2);
  assert.equal(z('.je-margin'), 3);
  assert.equal(z('.je-trail'), 4);
  assert.equal(z('.je-home'), 5);
});

test('the canvas answers a QUESTION about a row, not a node, and the rule reads only that answer', () => {
  assert.match(CANVAS, /const stampRect = \(date\) => dayElement\(date\)\?\.querySelector\('\.journal-meta'\)\?\.getBoundingClientRect\(\) \?\? null;/);
  assert.match(CANVAS, /holdCanvas\(\{ scroller: scrollRef\.current, dayElement, stampRect \}\);/);
  // and the waterline picker is untouched by the drawing: it measures the ARTICLE, which is what it
  // is right to measure — only the mark needs the row.
  const HOOK = readFileSync(new URL('../../../../src/products/journal/echoes/useEchoes.js', import.meta.url), 'utf8');
  assert.ok(!HOOK.includes('stampRect'), 'the picker is measuring the row instead of the article');
  assert.match(HOOK, /\.map\(\(day\) => \[day, dayElement\(day\)\?\.getBoundingClientRect\(\)\]\)/);
});

test('the tracker reads one rect a frame, off a passive listener, and takes both listeners back', () => {
  assert.match(MARGIN, /scroller\.addEventListener\('scroll', again, \{ passive: true \}\);/);
  assert.match(MARGIN, /window\.addEventListener\('resize', again\);/);
  assert.match(MARGIN, /scroller\.removeEventListener\('scroll', again\);/);
  assert.match(MARGIN, /window\.removeEventListener\('resize', again\);/);
  assert.match(MARGIN, /if \(!pending\) pending = requestAnimationFrame\(aim\);/);
  assert.match(MARGIN, /if \(pending\) cancelAnimationFrame\(pending\);/);
});

test('the visibility guard is instant and total — an author rule, because `[hidden]` would lose', () => {
  // `.je-tie` and `.je-margin-stub` both set `display`, and an author declaration out-ranks the UA
  // sheet's `[hidden] { display: none }`. Without this the guard would do nothing at all.
  assert.match(CSS, /\.je-tie\[hidden\],\n\.je-margin-stub\[hidden\] \{ display: none; \}/);
  assert.match(MARGIN, /rule\.hidden = y === null;/);
  assert.match(MARGIN, /if \(stub\) stub\.hidden = y === null;/);
  // it is never a fade: a rule fading out of a band it has already left trails behind a moving row
  assert.ok(!/\.je-tie\[hidden\][^}]*transition/.test(CSS));
});

// ─── reduced motion: three answers, each a decision ───────────────────────────────────────────────

test('under the preference the hover raise is restated and the swap is left to the clamp', () => {
  const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? [];
  const echoBlock = blocks.find((block) => block.includes('je-tab-lit'));
  assert.ok(echoBlock, 'the echo family’s reduced-motion block is gone');
  // the raise is feedback — an answer with no beat at all is a transient
  assert.match(echoBlock, /\.je-tie-mark \{ transition-duration: var\(--duration-fast\) !important; \}/);
  // the swap and the row's colour are NOT restated: with no fade the change is a hard cut, which is
  // what the preference asks for, and the hook closes its gap to nothing to match
  assert.ok(!echoBlock.includes('.je-tie {') && !echoBlock.includes('je-margin-swap'));
  assert.ok(!echoBlock.includes('journal-marker'));

  // TRACKING SURVIVES, and needs no rule to do it: a transform written per frame carries no
  // transition for a clamp to reach. Freezing it would leave the tie pointing at a row that moved.
  assert.ok(!/\.je-tie \{[^}]*transition:[^;]*transform/s.test(CSS));
});

test('the gap the hook holds between the two fades goes with them', () => {
  const HOOK = readFileSync(new URL('../../../../src/products/journal/echoes/useEchoes.js', import.meta.url), 'utf8');
  assert.match(HOOK, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 0 : SWAP_MS/);
  assert.match(HOOK, /const gap = shownSubject === null \? 0 : swapGap\(\);/);
  assert.match(HOOK, /const SWAP_MS = 90;/);
});

// ─── does the RESULT show? ────────────────────────────────────────────────────────────────────────
//
// Everything above proves the tie's mechanism runs. None of it would notice the tie being re-pointed
// at the ink it replaces, faded to nothing, or given a stub of zero width — the mark would go dark
// with the suite green, because a mechanism test asks "did the code run" and never "did anything
// appear". These read the shipped stylesheet, resolve its tokens the way a browser would, and assert
// what the reader ends up looking at. Every number here was verified against a real sRGB composite in
// headless Chrome; the arithmetic is here so a palette moving under the tie fails the build.

const PALETTES = readFileSync(new URL('../../../../src/styles/tokens/palettes.css', import.meta.url), 'utf8');
const COLORS = readFileSync(new URL('../../../../src/styles/tokens/colors.css', import.meta.url), 'utf8');

function declarationsOf(css, selector) {
  const body = new RegExp(`^${selector.replace(/[.[\]$()*+?^{}|\\]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  if (!body) return new Map();
  const clean = body[1].replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map([...clean.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
}

// The cascade a `.journal-root` custom property actually resolves through: the product's own theme
// block, then the room palette the shell stamps on <html>, then the family ramp.
function scopeFor(theme) {
  return [
    declarationsOf(CSS, `.journal-root[data-theme='${theme}']`),
    declarationsOf(PALETTES, `[data-theme="${theme}"][data-brand="journal"]`),
    declarationsOf(PALETTES, '[data-brand="journal"]'),
    declarationsOf(COLORS, ':root'),
  ];
}

function resolve(token, scope, depth = 0) {
  const found = scope.find((block) => block.has(token));
  if (!found || depth > 8) return null;
  const value = found.get(token);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? resolve(ref[1], scope, depth + 1) : value;
}

// A colour and the alpha it is painted at, out of either form this stylesheet writes: a night `rgba`
// or a day `color-mix` with transparent. One reader, so the two skins are measured the same way.
function paint(token, scope) {
  const value = resolve(token, scope);
  const mix = /color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*transparent\)/.exec(value);
  if (mix) return { hex: resolve(mix[1], scope), alpha: Number(mix[2]) / 100 };
  const rgba = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(value);
  if (rgba) {
    const hex = `#${[1, 2, 3].map((i) => Number(rgba[i]).toString(16).padStart(2, '0')).join('')}`;
    return { hex, alpha: Number(rgba[4]) };
  }
  return { hex: value, alpha: 1 };
}

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const luminance = (hex) => {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
};
const over = (hex, ground, alpha) => {
  const [f, g] = [channels(hex), channels(ground)];
  return `#${f.map((c, i) => Math.round((c * alpha + g[i] * (1 - alpha)) * 255).toString(16).padStart(2, '0')).join('')}`;
};
const groundOf = (scope) => resolve('--surface-canvas', scope) ?? resolve('--neutral-50', scope);

test('THE LIT ROW MOVES CONTRAST THE RIGHT WAY, in both skins — lighting that dims is not lighting', () => {
  for (const [theme, expected] of [['dark', { dim: 6.66, lit: 10.54 }], ['light', { dim: 5.27, lit: 7.26 }]]) {
    const scope = scopeFor(theme);
    const ground = groundOf(scope);
    const dim = contrast(resolve('--journal-ink-dim', scope), ground);
    const lit = contrast(resolve('--je-addressed', scope), ground);
    assert.equal(dim, expected.dim, `${theme}: the unlit date moved`);
    assert.equal(lit, expected.lit, `${theme}: the addressed date moved`);
    assert.ok(lit > dim, `${theme}: the lit row (${lit}:1) is QUIETER than the unlit one (${dim}:1)`);
    assert.ok(lit >= 4.5, `${theme}: the addressed date is ${lit}:1, under the gate`);
  }
  // day's own lamp-400 is the trap this token exists to avoid: under the gate AND lighter than the
  // dim it would replace, so it would have lowered the row's contrast to light it
  const day = scopeFor('light');
  assert.equal(contrast(resolve('--lamp-400', day), groundOf(day)), 4.39);
});

test('THE RULE IS QUIETER THAN EVERY MARK THAT CARRIES MEANING, and louder than nothing', () => {
  for (const theme of ['dark', 'light']) {
    const scope = scopeFor(theme);
    const ground = groundOf(scope);
    const rest = Number(/--je-tie-rest:\s*([\d.]+);/.exec(CSS)[1]);
    const tie = paint('--je-tie', scope);
    const raised = contrast(over(tie.hex, ground, tie.alpha), ground);
    const resting = contrast(over(tie.hex, ground, tie.alpha * rest), ground);
    // A.6 caps it: the rule is redundant with the stamp and is never counted toward legibility.
    assert.ok(raised < 3, `${theme}: the rule reads at ${raised}:1, loud enough to be counted`);
    assert.ok(raised < contrast(resolve('--journal-ink', scope), ground),
      `${theme}: the rule is as loud as the prose it crosses the gutter beside`);
    // and a floor, so it cannot be faded to a line nobody can follow: never quieter than the quietest
    // thing this family already draws, `--je-tab-aged-line`
    const aged = paint('--je-tab-aged-line', scope);
    const quietest = contrast(over(aged.hex, ground, aged.alpha), ground);
    assert.ok(resting > quietest,
      `${theme}: the resting rule (${resting}:1) is fainter than an aged tab's edge (${quietest}:1)`);
  }
});

test('the rule lands ON the panel because the two share one number, not because they were typed alike', () => {
  const gutter = /\.journal-root\.has-margin \{ --je-gutter: (\d+)px; \}/.exec(CSS)[1];
  const width = /^\.je-margin \{[\s\S]*?\n  width: (\d+)px;/m.exec(CSS)[1];
  assert.equal(width, gutter,
    `the panel is ${width}px wide in a ${gutter}px gutter, so the rule stops short of it or runs under it`);
});

test('every part of the mark has a size to be seen at', () => {
  const px = (selector, prop) => Number(
    new RegExp(`^\\${selector} \\{([\\s\\S]*?)\\n\\}`, 'm').exec(CSS)[1].match(new RegExp(`${prop}:\\s*([\\d.]+)px`))[1],
  );
  assert.equal(px('.je-tie', 'height'), 1.5, 'the house weight for "these two are joined"');
  assert.equal(px('.je-margin-stub', 'width'), 14);
  assert.equal(px('.je-margin-stub', 'height'), 1.5, 'the stub is the rule’s own weight or it is not its near end');
  // and the head has to paint OVER the ink scrolling under it, or the name goes behind the passages
  const head = /^\.je-margin-head \{([\s\S]*?)\n\}/m.exec(CSS)[1];
  assert.match(head, /position: sticky;/);
  assert.ok(Number(/z-index:\s*(-?\d+)/.exec(head)[1]) > 0, 'the sticky head paints behind the list it heads');
});

test('a press on the stamp for a page the canvas is not holding yet does nothing, and throws nothing', async (t) => {
  // Reachable: `walkTo` holds the panel on its destination and `extendTo` is still fetching, so the
  // panel names a page that has no element on the canvas for a beat.
  const echoes = echoesWith({ canvas: { scroller: {}, dayElement: () => null, stampRect: () => null } });
  const run = renderHook(t, () => EchoMargin({ echoes, page: PAGE }));
  await settle(6);
  const stamp = findByClass(run.tree, 'je-margin-stamp')[0];
  assert.doesNotThrow(() => stamp.props.onClick());
});

test('the band is measured against the SCROLL FRAME, not whatever box happens to share its extent', () => {
  // `.journal-root` and `.journal-scroll` have the same top and bottom today, so reading the wrong one
  // is invisible — until the root gains a header and the band silently follows a box the canvas is
  // not scrolling in.
  assert.match(MARGIN, /frame: scroller \? scroller\.getBoundingClientRect\(\) : null,/);
  assert.match(MARGIN, /const frame = scroller\.getBoundingClientRect\(\);/);
});
