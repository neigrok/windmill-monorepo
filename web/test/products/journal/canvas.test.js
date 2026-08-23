import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_KEYS, CARET_KEYS, writerTookTheScroll } from '../../../src/products/journal/openingGesture.js';

const SOURCE = readFileSync(new URL('../../../src/products/journal/Canvas.jsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../../src/products/journal/journal.css', import.meta.url), 'utf8');
const CODE = SOURCE.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n'`]*$/gm, '');   // the claims below are about code, not prose

// ─── who owns the scroll while the canvas is opening ──────────────────────────────────────────────

test('a wheel or a touch takes the scroll, over the composer as much as over the prose', () => {
  for (const insideField of [false, true]) {
    assert.equal(writerTookTheScroll({ type: 'wheel', insideField }), true);
    assert.equal(writerTookTheScroll({ type: 'touchstart', insideField }), true);
  }
});

test('a press on the canvas takes the scroll — a scrollbar drag, a selection, an echo tab', () => {
  assert.equal(writerTookTheScroll({ type: 'pointerdown', insideField: false }), true);
  // in the composer it places a caret, at the foot, where the canvas already is
  assert.equal(writerTookTheScroll({ type: 'pointerdown', insideField: true }), false);
});

test('the page keys scroll from inside the composer too; the caret keys only from outside it', () => {
  assert.deepEqual(PAGE_KEYS, ['PageUp', 'PageDown']);
  assert.deepEqual(CARET_KEYS, ['ArrowUp', 'ArrowDown', 'Home', 'End', ' ']);
  for (const key of PAGE_KEYS) {
    assert.equal(writerTookTheScroll({ type: 'keydown', key, insideField: false }), true);
    assert.equal(writerTookTheScroll({ type: 'keydown', key, insideField: true }), true);
  }
  for (const key of CARET_KEYS) {
    assert.equal(writerTookTheScroll({ type: 'keydown', key, insideField: false }), true);
    assert.equal(writerTookTheScroll({ type: 'keydown', key, insideField: true }), false);
  }
});

test('writing does not take the scroll, and neither does anything the browser does by itself', () => {
  for (const key of ['a', 'Enter', 'Backspace', 'Shift', 'Tab', 'Escape', null]) {
    assert.equal(writerTookTheScroll({ type: 'keydown', key, insideField: true }), false);
    assert.equal(writerTookTheScroll({ type: 'keydown', key, insideField: false }), false);
  }
  // THE defect this replaces: a scroll event cannot say who caused it — anchoring compensation, a
  // clamp when the content above shrinks, Chrome's own restoration on reload all arrive as one.
  for (const type of ['scroll', 'scrollend', 'resize', 'focus', 'pointermove', 'keyup', 'click']) {
    assert.equal(writerTookTheScroll({ type }), false);
  }
});

// ─── the canvas wires that rule, and nothing else ends the opening ────────────────────────────────

test('the opening latch is armed by a gesture listener and never by a scroll event', () => {
  assert.match(CODE, /const GESTURES = \['wheel', 'touchstart', 'pointerdown', 'keydown'\];/);
  assert.match(CODE, /for \(const type of GESTURES\) scroller\.addEventListener\(type, taken, \{ passive: true \}\);/);
  assert.match(CODE, /for \(const type of GESTURES\) scroller\.removeEventListener\(type, taken\);/);
  assert.ok(!/addEventListener\('scroll'/.test(CODE), 'a scroll event is deciding ownership again');
  assert.ok(!CODE.includes('placedRef'), 'the >8px placed-position heuristic is back');
  // the three positions the writer asks for are still the only other things that end it
  assert.equal(CODE.split('openingRef.current = false').length - 1, 3);
  assert.match(CODE, /useLayoutEffect\(\(\) => \{ openingRef\.current = true; \}, \[focusDate\]\);/);
});

test('the composer is re-measured on a change of WIDTH, not only of text', () => {
  assert.match(CODE, /useLayoutEffect\(sizeToContent, \[body\]\);/);
  assert.match(CODE, /widthRef\.current = ta\.clientWidth;/);
  const observer = CODE.slice(CODE.indexOf('new ResizeObserver'), CODE.indexOf('const taken ='));
  assert.match(observer, /if \(ta && ta\.clientWidth !== widthRef\.current\) sizeToContent\(\);/);
  // and re-measured BEFORE the position is taken off it, or the foot is short by the clipped lines
  assert.ok(observer.indexOf('sizeToContent()') < observer.indexOf('takeRef.current()'));
  // the scroller's own box never changes as days stream in — the column and the composer are the
  // two boxes that do, and the composer's width is the one the gutter changes
  assert.match(observer, /observer\?\.observe\(scroller\);/);
  assert.match(observer, /if \(columnRef\.current\) observer\?\.observe\(columnRef\.current\);/);
  assert.match(observer, /if \(textareaRef\.current\) observer\?\.observe\(textareaRef\.current\);/);
});

test('nothing but the canvas holds the canvas position: scroll anchoring is off on the scroller', () => {
  const scroll = CSS.slice(CSS.indexOf('.journal-scroll {')).split('}')[0];
  assert.match(scroll, /overflow-anchor: none;/);
  assert.equal(CSS.split('overflow-anchor').length - 1, 1);
});
