// The edge tab is two different controls at two widths, and `marginOpen` is the single fact that says
// which. Above the margin's width the panel IS the page's ink and is already open, so the tab
// discloses nothing: it holds the panel on this page, and pressing it again hands the panel back to
// the scroll. Below it, the tab is the disclosure it looks like. Both are asserted here, because the
// defect this replaces was invisible at one width — a tab that announced `aria-expanded` and swapped
// to a ✕ while nothing opened or closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { elementsOf, loadScreen, renderHook } from '../../gym/harness.mjs';

const tabCountModule = await loadScreen('products/journal/echoes/PageEchoes.jsx');
const { PageEchoes, edgeTabProps } = tabCountModule;

const CSS = readFileSync(new URL('../../../../src/products/journal/journal.css', import.meta.url), 'utf8');
const HOOK = readFileSync(new URL('../../../../src/products/journal/echoes/useEchoes.js', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../../../../src/products/journal/JournalApp.jsx', import.meta.url), 'utf8');

const PAGE = {
  day: '2026-08-11',
  entitled: true,
  matches: [
    { day: '2026-05-02', text: 'the older words', useful: false, withheldWords: 0 },
    { day: '2026-01-19', text: 'and the ones before those', useful: false, withheldWords: 0 },
  ],
};

function echoesWith(overrides = {}) {
  return {
    pageOf: (day) => (day === PAGE.day ? PAGE : null),
    verify: () => {},
    canvas: null,
    openDay: null,
    firstEchoDay: null,
    marginOpen: false,
    marginDay: null,
    heldDay: null,
    openInk: () => {},
    closeInk: () => {},
    holdPanel: () => {},
    followScroll: () => {},
    walkTo: () => {},
    openSheet: () => {},
    markUseful: () => {},
    retireMatch: () => {},
    // The arrival. `lit` is a separate answer from every state above — a page can be aged and lit —
    // so a fake that folded it into the state enum would be a fake of a tab that cannot exist.
    lit: null,
    settling: null,
    taken: null,
    // Whether this page has ever been drawn at rest. A tab asks it once, as it mounts, to know
    // whether it is the appearance of a new object or an element that was already on screen — the
    // arming cannot answer that, because a tab is drawn by the read and armed a body fetch later.
    presentedBefore: () => true,
    litInView: () => {},
    spendLight: () => {},
    ...overrides,
  };
}

// A light burning on this page, kindled `ago` milliseconds back.
const litOn = (day, { ago = 0, count = 2 } = {}) => {
  const now = Date.now();
  return { day, landedAt: now - ago, kindledAt: now - ago, count };
};

// The panel is open, on this page, and the scroll is what put it there.
const addressing = (overrides = {}) => echoesWith({ marginOpen: true, marginDay: PAGE.day, ...overrides });

const markup = (echoes) => renderToStaticMarkup(
  React.createElement(PageEchoes, { echoes, day: PAGE.day, standing: true }),
);

const tabOf = (tree) => elementsOf(tree)
  .find((each) => each.props.tab && typeof each.props.onClick === 'function');

// ─── with the margin open, nothing about the tab is a disclosure ──────────────────────────────────

test('above the margin’s width the tab offers the hold and claims no open/closed state of its own', () => {
  const html = markup(addressing());
  assert.ok(!html.includes('aria-expanded'), 'the tab announces a disclosure state with no referent');
  assert.ok(!html.includes('je-tab-open'), 'the tab paints itself open beside an already-open panel');
  assert.ok(!html.includes('<svg'), 'the close glyph is drawn where nothing can be closed');
  assert.ok(!html.includes('je-ink'), 'the in-page ink renders where the margin holds it');
  assert.match(html, /aria-label="2 passages you wrote before — hold panel on this page"/);
  assert.match(html, /class="je-tab je-tab-addressed"/);
  assert.match(html, /<span class="je-tab-face" aria-hidden="true"><span class="je-tab-count">2<\/span><\/span>/);
});

test('the three states above that width are the panel’s, not the page’s: held, addressed, aged', () => {
  assert.match(markup(addressing({ heldDay: PAGE.day })), /class="je-tab je-tab-held"/);
  assert.match(markup(addressing({ heldDay: PAGE.day })), /aria-label="2 passages you wrote before — follow the scroll again"/);
  // the panel is holding some other page: this one is neither held nor the page it describes
  const elsewhere = markup(echoesWith({ marginOpen: true, marginDay: '2026-07-04', heldDay: '2026-07-04' }));
  assert.match(elsewhere, /class="je-tab je-tab-aged"/);
  assert.match(elsewhere, /aria-label="2 passages you wrote before — hold panel on this page"/);
  // and `standing` — the page being stood on — decides none of it at this width
  const stood = renderToStaticMarkup(
    React.createElement(PageEchoes, { echoes: addressing(), day: PAGE.day, standing: false }),
  );
  assert.match(stood, /class="je-tab je-tab-addressed"/);
});

test('a walked-to page cannot put the tab into an open state it has no way to leave', () => {
  // `openDay` is set by a walk at every width. Above the margin's width it is the panel that answers
  // it, and the tab must not repaint itself as the control that closes something.
  const html = markup(addressing({ openDay: PAGE.day, heldDay: PAGE.day }));
  assert.ok(!html.includes('aria-expanded'));
  assert.ok(!html.includes('je-tab-open'));
  assert.ok(!html.includes('<svg'));
  assert.ok(!html.includes('je-ink'));
  assert.match(html, /class="je-tab je-tab-held"/);
});

test('the press holds the panel on this page, and hands it back once this page is the one holding it', (t) => {
  const calls = [];
  const wiring = {
    openDay: PAGE.day,
    holdPanel: (day) => calls.push(['hold', day]),
    followScroll: () => calls.push(['follow']),
    openInk: (day) => calls.push(['open', day]),
    closeInk: () => calls.push(['close']),
  };
  const loose = renderHook(t, () => PageEchoes({ echoes: addressing(wiring), day: PAGE.day, standing: true }));
  tabOf(loose.tree).props.onClick();
  const held = renderHook(t, () => PageEchoes({
    echoes: addressing({ ...wiring, heldDay: PAGE.day }), day: PAGE.day, standing: true,
  }));
  tabOf(held.tree).props.onClick();
  assert.deepEqual(calls, [['hold', PAGE.day], ['follow']]);
});

// ─── below it, the tab is the disclosure it has always been ───────────────────────────────────────

test('below the margin’s width the closed tab counts the passages and says it is closed', () => {
  const html = markup(echoesWith({}));
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="2 passages you wrote before"/);
  assert.match(html, /class="je-tab je-tab-current"/);
  assert.ok(!html.includes('<svg'));
  assert.ok(!html.includes('je-ink'));
});

test('below it, an open tab closes the ink it opened — the ✕, the open paint and the label', () => {
  const html = markup(echoesWith({ openDay: PAGE.day }));
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-label="Close what you wrote before"/);
  assert.match(html, /class="je-tab je-tab-open"/);
  assert.ok(html.includes('<svg'), 'the close glyph is gone from the one state that closes something');
  assert.ok(html.includes('class="je-ink"'), 'the ink the tab opens does not render');
});

test('below it the press opens the ink, and closes the ink it opened', (t) => {
  const calls = [];
  const wiring = {
    holdPanel: (day) => calls.push(['hold', day]),
    followScroll: () => calls.push(['follow']),
    openInk: (day) => calls.push(['open', day]),
    closeInk: () => calls.push(['close']),
  };
  const shut = renderHook(t, () => PageEchoes({ echoes: echoesWith(wiring), day: PAGE.day }));
  tabOf(shut.tree).props.onClick();
  const open = renderHook(t, () => PageEchoes({
    echoes: echoesWith({ ...wiring, openDay: PAGE.day }), day: PAGE.day,
  }));
  tabOf(open.tree).props.onClick();
  assert.deepEqual(calls, [['open', PAGE.day], ['close']]);
});

// ─── the rule itself, at both widths ──────────────────────────────────────────────────────────────

test('edgeTabProps — the margin’s width decides the control; nothing else can', () => {
  assert.deepEqual(edgeTabProps({ marginOpen: true, open: true, standing: true, held: true, addressed: false, count: 3 }), {
    state: 'held',
    face: 'count',
    label: '3 passages you wrote before — follow the scroll again',
  });
  assert.deepEqual(edgeTabProps({ marginOpen: true, open: false, standing: true, held: false, addressed: true, count: 3 }), {
    state: 'addressed',
    face: 'count',
    label: '3 passages you wrote before — hold panel on this page',
  });
  assert.deepEqual(edgeTabProps({ marginOpen: true, open: false, standing: false, held: false, addressed: false, count: 1 }), {
    state: 'aged',
    face: 'count',
    label: '1 passage you wrote before — hold panel on this page',
  });
  assert.deepEqual(edgeTabProps({ marginOpen: false, open: false, standing: false, held: false, addressed: false, count: 1 }), {
    state: 'aged',
    face: 'count',
    expanded: false,
    label: '1 passage you wrote before',
  });
  assert.deepEqual(edgeTabProps({ marginOpen: false, open: true, standing: true, held: false, addressed: false, count: 3 }), {
    state: 'open',
    face: 'close',
    expanded: true,
    label: 'Close what you wrote before',
  });
});

// ─── one width, asked once ────────────────────────────────────────────────────────────────────────

test('the margin’s width is asked in the hook and nowhere else — the stylesheet takes the class', () => {
  assert.match(HOOK, /const MARGIN_MIN_WIDTH = 1240;/);
  assert.match(HOOK, /window\.matchMedia\(`\(min-width: \$\{MARGIN_MIN_WIDTH\}px\)`\)/);
  assert.ok(!/min-width:\s*1240/.test(CSS), 'the stylesheet decides the breakpoint a second time');
  assert.ok(!CSS.includes('has-gutter'), 'the retired class is still styled');
  assert.match(CSS, /\.journal-root\.has-margin \{ --je-gutter: 300px; \}/);
  // The column's ink is not rendered where the margin holds it, so nothing hides it after the fact.
  assert.ok(!/je-ink(-foot)?[^{;]*\{[^}]*display:\s*none/.test(CSS), 'the ink is hidden by CSS again');
  // and the held tab has a face of its own, on the fill the open tab uses below that width
  assert.match(CSS, /\.je-tab-open \.je-tab-face,\n\.je-tab-held \.je-tab-face \{/);
});

test('the frame wears that one answer: the class, the panel and the page footer all read it', () => {
  assert.match(APP, /echoes\.marginOpen \? ' has-margin' : ''/);
  assert.match(APP, /\{echoes\.marginOpen && <EchoMargin echoes=\{echoes\} page=\{shownPage\} sheeted=\{Boolean\(sheetPage\)\} \/>\}/);
  assert.match(APP, /\{!echoes\.marginOpen && openPage && <InkFooter/);
  // The panel draws the page the SWAP is showing, never this frame's pick: one source of truth for
  // the panel, its stamp, its rule and the day row that lights on the canvas.
  assert.match(APP, /const shownPage = echoes\.shownDay \? echoes\.pageOf\(echoes\.shownDay\) : null;/);
  assert.ok(!APP.includes('marginPage'), 'the frame is picking the panel’s page a second time');
  // the settle that keeps a fast scroll from strobing the panel is the hook's, so the tabs share it
  assert.ok(!APP.includes('setTimeout'), 'the frame is settling the follow a second time');
});

// ─── the arrival ─────────────────────────────────────────────────────────────────────────────────
//
// The light is ORTHOGONAL to everything above. A page can be aged and lit, held and lit; folding it
// into the state enum would make "an echo just landed on a page you last read in March" unsayable.

test('a lit tab wears the light BESIDE its state, at every width and in every state it can be in', () => {
  const lit = litOn(PAGE.day);
  assert.match(markup(echoesWith({ lit })), /class="je-tab je-tab-current je-tab-lit"/);
  assert.match(markup(addressing({ lit })), /class="je-tab je-tab-addressed je-tab-lit"/);
  assert.match(markup(addressing({ lit, heldDay: PAGE.day })), /class="je-tab je-tab-held je-tab-lit"/);
  // the one that could not be said at all if the light were a member of the enum
  const aged = markup(echoesWith({ lit, marginOpen: true, marginDay: '2026-07-04', heldDay: '2026-07-04' }));
  assert.match(aged, /class="je-tab je-tab-aged je-tab-lit"/);
});

test('a light on another page lights nothing here, and no light leaves the tab exactly as it was', () => {
  assert.match(markup(echoesWith({ lit: litOn('2026-07-04') })), /class="je-tab je-tab-current"/);
  assert.match(markup(echoesWith({ lit: null })), /class="je-tab je-tab-current"/);
});

test('a light still held under an overlay draws nothing — it has not kindled yet', () => {
  const held = { day: PAGE.day, landedAt: Date.now(), kindledAt: null, count: 2, born: false };
  assert.match(markup(echoesWith({ lit: held })), /class="je-tab je-tab-current"/);
});

// THE RAMP BELONGS TO THE ELEMENT'S FIRST PAINT OR TO NOTHING. A tab is drawn by the read, still
// unverified, and armed a body fetch later; a ramp keyed to the ARMING would find a tab that had
// been on screen at full weight for a whole round trip, drop it to zero and fade it back — a step,
// and the one abrupt onset this design exists to carry none of.
test('a tab whose page the reader had not been shown ramps in; one already drawn never does', () => {
  const fresh = markup(echoesWith({ presentedBefore: () => false }));
  assert.match(fresh, /class="je-tab je-tab-current is-born"/,
    'a page arriving mid-session is a new object on screen, and the ramp is what defuses it');

  // the same page, already presented — the common case, and the one that would have snapped
  assert.ok(!markup(echoesWith({ lit: litOn(PAGE.day) })).includes('is-born'));
  assert.ok(!markup(echoesWith({})).includes('is-born'));
});

test('a tab mounting into a dwell already under way RESUMES: no kindle, and no ramp either', () => {
  const midDwell = markup(echoesWith({ lit: litOn(PAGE.day, { ago: 4000 }) }));
  assert.match(midDwell, /class="je-tab je-tab-current je-tab-lit is-resumed"/);
  assert.ok(!midDwell.includes('is-born'),
    'a scroll that remounts the page would otherwise ramp in a tab that was already there');
});

test('a light spent by surfacing marks the tab settling, so the face falls instead of snapping', () => {
  assert.match(markup(echoesWith({ settling: PAGE.day })), /class="je-tab je-tab-current is-settling"/);
  assert.ok(!markup(echoesWith({ settling: '2026-07-04' })).includes('is-settling'));
});

test('a press spends the light on this page before it does anything else it was going to do', (t) => {
  const calls = [];
  const wiring = {
    lit: litOn(PAGE.day),
    spendLight: (day) => calls.push(['spend', day]),
    openInk: (day) => calls.push(['open', day]),
  };
  const run = renderHook(t, () => PageEchoes({ echoes: echoesWith(wiring), day: PAGE.day }));
  tabOf(run.tree).props.onClick();
  assert.deepEqual(calls, [['spend', PAGE.day], ['open', PAGE.day]]);
});

test('the tab is drawn in a rail of its own, so it can ride its page instead of scrolling off it', () => {
  assert.match(markup(echoesWith({})), /^<div class="je-tab-rail"><button/);
});

test('the live region says the tab’s own words, and never a word the tab does not use', async () => {
  const { EchoLive } = await loadScreen('products/journal/echoes/PageEchoes.jsx');
  const said = renderToStaticMarkup(React.createElement(EchoLive, {
    arrival: { day: PAGE.day, count: 3, at: Date.now() },
  }));
  assert.match(said, /aria-live="polite"/);
  for (const word of ['new', 'New', 'echo', 'Echo']) {
    assert.ok(!said.includes(word), `the light is the whole sentence, and it does not say "${word}"`);
  }
});

// ─── what the stylesheet has to hold up ──────────────────────────────────────────────────────────

test('THE LANE IS ALWAYS RESERVED: an echo landing may not re-wrap the sentence being written', () => {
  // With `:has(.je-tab)` the 40px lane existed only once the tab did, so an echo landing on tonight's
  // page narrowed the composer mid-sentence and every line re-wrapped under the caret — measured at
  // 40% of prose lengths gaining a line. journal.md rules the opposite in bold, and the same selector
  // made the measure narrower on a page with an echo than on one without, down one canvas.
  assert.ok(!/\.journal-page:has\(/.test(CSS), 'the lane appears with the tab again');
  assert.match(CSS, /\.journal-page \{[^}]*padding-right: 40px;/);
});

test('the tab rides its own page: sticky in a rail, under the day chip, and the phone edge is the rail’s', () => {
  assert.match(CSS, /\.je-tab-rail \{[^}]*position: absolute;/);
  assert.match(CSS, /\.je-tab-rail \{[^}]*pointer-events: none;/);
  assert.match(CSS, /\.je-tab \{[^}]*position: sticky;/);
  assert.match(CSS, /\.je-tab \{[^}]*top: var\(--je-tab-sticky-top\);/);
  assert.match(CSS, /--je-tab-sticky-top: 30px;/);
  assert.ok(!/\.je-tab \{[^}]*position: absolute;/.test(CSS), 'the tab is anchored to the page top again');
  assert.match(CSS, /@media \(max-width: 684px\) \{\s*\.je-tab-rail \{ right: -22px; \}/);
});

// The rule body for a selector or a @keyframes, brace-matched, so a test cannot be fooled by a
// declaration that belongs to the block after the one it meant to read.
function block(head) {
  const at = CSS.indexOf(`\n${head}`);
  assert.ok(at >= 0, `the stylesheet has no ${head}`);
  let depth = 0;
  for (let i = CSS.indexOf('{', at); i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}' && (depth -= 1) === 0) return CSS.slice(at, i + 1);
  }
  throw new Error(`unclosed rule: ${head}`);
}

const declared = (body) => [...body.matchAll(/([a-z-]+)\s*:/g)].map((each) => each[1]);

test('THE LUMINANCE CHANGE SURVIVES REDUCED MOTION — it is the only signal those readers get', () => {
  // styles/global.css forces `transition-duration: 0.001ms !important` on `*` under the preference.
  // Measured in headless Chrome: it reaches these transitions, and left alone it would collapse the
  // whole arrival into an instant luminance STEP — an abrupt onset, the one transient this design
  // exists to carry none of, handed to the reader who asked for less. A class-level `!important`
  // out-ranks it (same origin, so specificity decides), and that is what these lines are.
  const stilled = CSS.split('@media (prefers-reduced-motion: reduce)')
    .find((each) => each.includes('transition-duration: var(--je-kindle-in) !important'));
  assert.ok(stilled, 'the echoes have no reduced-motion block of their own');
  for (const [selector, token] of [
    ['.je-tab-lit .je-tab-face', '--je-kindle-in'],
    ['.je-tab.is-settling .je-tab-face', '--je-kindle-out'],
    ['.je-tab.is-taken .je-tab-face', '--duration-fast'],
    ['.je-margin.is-lit', '--je-kindle-in'],
    ['.je-margin.is-settling', '--je-kindle-out'],
  ]) {
    assert.ok(
      stilled.includes(`${selector} { transition-duration: var(${token}) !important; }`),
      `${selector} loses its ramp to the site-wide clamp`,
    );
  }
  // and nothing may switch the arrival off in the name of the preference
  assert.ok(!/je-tab[^{}]*\{[^}]*animation:\s*none/.test(stilled),
    'the light is turned off for the very readers it was authored for');
});

test('the arrival is one channel: every waveform in it animates opacity and nothing else', () => {
  for (const waveform of ['@keyframes je-tab-born', '@keyframes je-tab-count-swap',
    '@keyframes je-margin-rest-out', '@keyframes journal-fade-in {']) {
    assert.deepEqual([...new Set(declared(block(waveform)))], ['opacity'],
      `${waveform} animates something that is not luminance`);
  }
});

test('and every ramp in it carries colour, shadow and opacity — never a size, a position or a transform', () => {
  const allowed = ['background-color', 'border-color', 'box-shadow', 'opacity', 'border-left-color'];
  for (const rule of ['.je-tab-lit .je-tab-face', '.je-tab.is-settling .je-tab-face',
    '.je-tab.is-taken .je-tab-face', '.je-margin.is-lit', '.je-margin.is-settling']) {
    const listed = /transition:\s*([^;]+);/.exec(block(rule));
    assert.ok(listed, `${rule} declares no transition of its own`);
    for (const property of listed[1].split(',').map((each) => each.trim().split(/\s+/)[0])) {
      assert.ok(allowed.includes(property), `${rule} ramps ${property}, which is not luminance`);
    }
  }
  // The tab itself has none: its states are the scroll's and the reader's, and they take effect at
  // once. A base ramp made every addressed/aged flip cross-fade for 2.4s on every scroll — measured
  // still three quarters short of its target 1.6s after the swap.
  assert.ok(!/transition/.test(block('.je-tab-face {')), 'the resting tab ramps its own states again');
  assert.ok(!/transition/.test(block('.je-margin {')), 'the resting panel ramps its own seam again');
  assert.match(CSS, /--je-kindle-in: 1200ms;/);
  assert.match(CSS, /--je-kindle-out: var\(--duration-glow\);/);
});

test('the live region is said, not seen — and it takes no room in the column it sits in', () => {
  const live = block('.je-live {');
  assert.match(live, /position: absolute;/);
  assert.match(live, /clip-path: inset\(50%\);/);
  assert.match(live, /width: 1px;/);
});

test('the count cross-fade re-arms on a second change, so no digit ever flips at full weight', (t) => {
  // The digit is held back 600ms so it changes at the fade's dimmest point. A second change arriving
  // mid-fade has to move the fade's own clock with it — otherwise the first fade ends on schedule,
  // the class comes off, and the second digit lands afterwards at full weight, which is precisely
  // the thing the fade is here to prevent. Two "not useful" presses ~800ms apart do it.
  const { TabCount } = tabCountModule;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 2;
  const run = renderHook(t, () => TabCount({ count }));
  const face = () => ({ cls: run.tree.props.className, digit: run.tree.props.children });

  assert.deepEqual(face(), { cls: 'je-tab-count', digit: 2 });

  count = 3;
  run.redraw();
  assert.deepEqual(face(), { cls: 'je-tab-count is-swapping', digit: 2 }, 'the old digit dims first');
  t.mock.timers.tick(600);
  assert.deepEqual(face(), { cls: 'je-tab-count is-swapping', digit: 3 }, 'and swaps at the dimmest point');

  t.mock.timers.tick(200);
  count = 4;
  run.redraw();
  t.mock.timers.tick(400);
  assert.equal(face().cls, 'je-tab-count is-swapping',
    'the fade ended on the first change’s clock, stranding the second digit');
  t.mock.timers.tick(200);
  assert.deepEqual(face(), { cls: 'je-tab-count is-swapping', digit: 4 });

  t.mock.timers.tick(700);
  assert.deepEqual(face(), { cls: 'je-tab-count', digit: 4 }, 'and only then is the fade over');
});
