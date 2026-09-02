// `locate` takes an occurrence index, not an offset: a span indexes the UTF-16 string the browser holds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { browserWith, renderHook, settle } from '../../gym/harness.mjs';
import { locate, stillStanding, useEchoes } from '../../../../src/products/journal/echoes/useEchoes.js';

const TWICE = "i don't know. and then i don't know.";

test('locate — a passage that is still in the body comes back as its span', () => {
  assert.deepEqual(locate('slept badly. i like c++ now.', 'i like c++ now.', 0), [13, 28]);
  assert.deepEqual(locate('i like c++ now.', 'i like c++ now.', 0), [0, 15]);
});

test('locate — the hint picks WHICH "i don\'t know." the passage is', () => {
  assert.deepEqual(locate(TWICE, "i don't know.", 0), [0, 13]);
  assert.deepEqual(locate(TWICE, "i don't know.", 1), [23, 36]);
});

test('locate — no hint, or a hint the server declined to send, is the first occurrence', () => {
  assert.deepEqual(locate(TWICE, "i don't know.", undefined), [0, 13]);
  assert.deepEqual(locate(TWICE, "i don't know.", -1), [0, 13]);
  assert.deepEqual(locate(TWICE, "i don't know.", null), [0, 13]);
});

test('locate — a hint that over-counts falls back to the first occurrence', () => {
  assert.deepEqual(locate(TWICE, "i don't know.", 5), [0, 13]);
  assert.deepEqual(locate('i like c++ now.', 'i like c++ now.', 2), [0, 15]);
});

test('locate — text the page no longer holds is not shown, and neither is nothing at all', () => {
  assert.equal(locate('slept badly.', 'i like c++ now.', 0), null);
  assert.equal(locate('', 'i like c++ now.', 0), null);
  assert.equal(locate('slept badly.', '', 0), null);
  assert.equal(locate(undefined, 'i like c++ now.', 0), null);
  assert.equal(locate('slept badly.', undefined, 0), null);
});

test('locate — the span it returns slices the passage back out, accents and emoji included', () => {
  const accented = 'j’étais fatigué. et puis j’étais fatigué encore.';
  const span = locate(accented, 'j’étais fatigué encore.', 0);
  assert.deepEqual(span, [25, 48]);
  assert.equal(accented.slice(span[0], span[1]), 'j’étais fatigué encore.');

  const emoji = 'good day 🌙 and then a bad one 🌙 after it';
  const found = locate(emoji, '🌙', 1);
  assert.deepEqual(found, [31, 33]);
  assert.equal(emoji.slice(found[0], found[1]), '🌙');
});

// `stillStanding` is the retraction rule the canvas runs on every keystroke-settled body: an echo
// quoting words the writer has just deleted comes off the page as they delete them, with no fetch
// and no reload. The rule has to be careful in one direction — silence about a body is not evidence
// against the quote inside it — or scrolling away would retire echoes nobody touched.
test('stillStanding — a quote whose words are gone from an edited body is dropped', () => {
  const matches = [
    { day: '2026-08-11', text: 'хочется в сербию', occurrenceHint: 0 },
    { day: '2026-08-11', text: 'еще и заболел', occurrenceHint: 0 },
  ];
  const live = new Map([['2026-08-11', 'еще и заболел вчера.']]);

  assert.deepEqual(stillStanding(matches, live), [matches[1]]);
});

test('stillStanding — a match into a page the canvas is not holding is left alone', () => {
  const matches = [{ day: '2024-01-01', text: 'i want to learn c++.', occurrenceHint: 0 }];

  assert.deepEqual(stillStanding(matches, new Map()), matches);
  assert.deepEqual(stillStanding(matches, new Map([['2026-08-11', 'something else']])), matches);
});

test('stillStanding — the occurrence hint still picks WHICH copy, so an edit to one is not both', () => {
  const twice = { day: '2026-08-11', text: "i don't know.", occurrenceHint: 1 };
  assert.deepEqual(stillStanding([twice], new Map([['2026-08-11', "i don't know. i don't know."]])),
                   [twice]);
  // One of the two removed: the second occurrence is gone, and the hint falls back to the first.
  assert.deepEqual(stillStanding([twice], new Map([['2026-08-11', "i don't know."]])), [twice]);
  // Both gone: nothing stands.
  assert.deepEqual(stillStanding([twice], new Map([['2026-08-11', 'nothing like it']])), []);
});

test('stillStanding — an empty body retires every quote into it, which is what deleting a page is', () => {
  const matches = [{ day: '2026-08-11', text: 'хочется в сербию', occurrenceHint: 0 }];
  assert.deepEqual(stillStanding(matches, new Map([['2026-08-11', '']])), []);
});

// ─── the margin's width, and the one page the panel sits beside ───────────────────────────────────
//
// The width is asked here rather than in a media query, so a surface cannot behave one way while the
// stylesheet lays it out another at the same width. `marginDay` is the one answer to which page the
// panel sits beside — the page the reader is holding it on, and the page under the reading waterline
// otherwise — because the panel draws that page and every edge tab reads whether it is the one.

const SETTLE_MS = 160;
const ECHO_PAGES = [
  { day: '2026-08-11', entitled: true, matches: [{ day: '2026-05-02', text: 'older words', occurrenceHint: 0 }] },
  { day: '2026-08-20', entitled: true, matches: [{ day: '2026-01-19', text: 'older still', occurrenceHint: 0 }] },
];

// The echoes read AND the page reads behind it, because the hook re-locates every quote it is handed
// before it will hold it: a fake that answers the echo list alone is a fake of a server that retires
// every echo it sends, and every page here would come straight back off the canvas.
function reading({ wide, reduced = false, pages = ECHO_PAGES }) {
  browserWith();
  // ONE ANSWER PER QUESTION. A fake that says `matches: true` to every query is a fake of a browser
  // that cannot exist, and it answers `prefers-reduced-motion` yes on every wide screen — which is
  // exactly the preference the panel's swap reads to decide whether it holds a gap at all.
  globalThis.window.matchMedia = (media) => ({
    media,
    matches: media.includes('min-width') ? wide : reduced,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.window.history = { pushState() {}, state: null };
  globalThis.window.dispatchEvent = () => {};
  globalThis.PopStateEvent = class PopStateEvent {};
  const answer = { pages, edits: new Map() };
  const bodies = () => new Map([
    ...answer.pages.flatMap(
      (page) => page.matches.map((match) => [match.day, `before this. ${match.text}. and after.`]),
    ),
    ...answer.edits,
  ]);
  const asked = { echoes: 0, page: 0 };
  const held = [];
  globalThis.fetch = async (url) => {
    const day = /\/page\/(\d{4}-\d{2}-\d{2})$/.exec(String(url));
    if (day) {
      asked.page += 1;
      if (answer.hold) return new Promise((keep) => held.push(() => keep({ ok: true, status: 200, json: async () => ({ date: day[1], body: bodies().get(day[1]) ?? '' }) })));
      return { ok: true, status: 200, json: async () => ({ date: day[1], body: bodies().get(day[1]) ?? '' }) };
    }
    asked.echoes += 1;
    // Captured at the moment of asking, the way a server answers: a reply held in the air carries
    // what was true when it was asked for, not what became true while it was in flight.
    const served = answer.pages;
    const floored = answer.floor;
    answer.floor = false;
    const reply = { ok: true, status: 200, json: async () => (floored
      ? { floorWaived: false, pagesWritten: 3, pages: [] }
      : { floorWaived: true, pages: served }) };
    if (!answer.hold) return reply;
    return new Promise((keep) => held.push(() => keep(reply)));
  };
  return {
    // What the next read answers, so a test can land an echo without waiting out LIVE_INTERVAL.
    serve: (next) => { answer.pages = next; },
    asked,
    // Hold replies in the air, so a test can decide WHEN a read lands relative to everything else.
    holdReplies: () => { answer.hold = true; },
    resume: () => { answer.hold = false; },
    // The next read comes back under the page floor, the way a poll landing mid-sweep does.
    floorNext: () => { answer.floor = true; },
    // The writer edits the page a quote lives in, so the quote stops locating in the live body.
    editBody: (day, body) => answer.edits.set(day, body),
    release: () => { const waiting = held.splice(0); waiting.forEach((keep) => keep()); },
  };
}

const readerOn = (t) => renderHook(t, () => useEchoes({ today: '2026-09-01', account: 'reader' }));
const rested = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 60));
// Two clocks, and they are different facts. `rested` is the scroll settling and the panel COMMITTING
// to a page; `shown` is the panel having finished LEAVING the page before it and named the new one.
const SWAP_MS = 90;
const shown = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS + SWAP_MS + 60));

// A canvas with two echo pages on screen: the waterline at 55% of 600px falls between them. Each
// page's day row is 16px tall at the article's own top, which is where `.journal-marker` sticks — the
// stamps the margin's rule aims at, and the ONE thing the canvas answers about a row's position.
function canvasOf(run) {
  const frame = { top: 0, bottom: 600, height: 600 };
  const boxes = new Map([
    ['2026-08-11', { top: 10, bottom: 200 }],
    ['2026-08-20', { top: 300, bottom: 500 }],
  ]);
  // Every listener the canvas is given, and a real removal for each — the dwell hangs its whole
  // surfacing rule off these, and a fake that never forgets one would hide a light spent by a
  // listener that should already have been torn down.
  const heard = new Map();
  run.holdCanvas({
    scroller: {
      getBoundingClientRect: () => frame,
      addEventListener: (type, fn) => heard.set(type, [...(heard.get(type) ?? []), fn]),
      removeEventListener: (type, fn) => heard.set(type, (heard.get(type) ?? []).filter((each) => each !== fn)),
    },
    dayElement: (day) => (boxes.has(day) ? { getBoundingClientRect: () => boxes.get(day) } : null),
    stampRect: (day) => (boxes.has(day)
      ? { top: boxes.get(day).top, bottom: boxes.get(day).top + 16 }
      : null),
  });
  const fire = (type) => (heard.get(type) ?? []).forEach((fn) => fn());
  return { boxes, fire, hears: (type) => (heard.get(type) ?? []).length, scroll: () => fire('scroll') };
}

test('the margin’s space is reserved on WIDTH ALONE, so no echo can ever widen the canvas under a writer', async (t) => {
  // It used to also need the account to have been paired before, held in localStorage — so the space
  // appeared mid-session the first time an account was ever echoed, sliding the reading column 150px
  // sideways at exactly the moment the arrival light was asking to be looked at. Ruled 2026-09-02.
  reading({ wide: true });
  const room = readerOn(t);
  assert.equal(room.log.marginOpen, true, 'the space is claimed before the first read lands');
  await settle(8);
  assert.equal(room.log.marginOpen, true, 'and the read that finds echoes changes nothing about it');

  reading({ wide: false });
  const phone = readerOn(t);
  assert.equal(phone.log.marginOpen, false);
  await settle(8);
  assert.equal(phone.log.marginOpen, false, 'a phone with echoes has no room for the panel');

  reading({ wide: true, pages: [] });
  const empty = readerOn(t);
  await settle(8);
  assert.equal(empty.log.marginOpen, true, 'room with no echoes reserves it anyway — an empty column costs nothing, a moving canvas costs a sentence');
});

test('nothing about the reserved space is remembered between mounts — the width is the whole answer', async (t) => {
  reading({ wide: true, pages: [] });
  const first = readerOn(t);
  await settle(8);
  assert.equal(first.log.marginOpen, true);
  const wrote = Object.keys(globalThis.localStorage ?? {}).filter((key) => key.includes('gutter'));
  assert.deepEqual(wrote, [], 'the per-account latch is gone, and nothing writes in its place');
});

test('with nothing held, the panel sits beside the waterline’s page once the scroll has rested', async (t) => {
  reading({ wide: true });
  const run = readerOn(t);
  await settle(8);
  canvasOf(run.log);

  assert.equal(run.log.followedDay, '2026-08-20', 'the waterline reads the lower of the two');
  assert.equal(run.log.marginDay, null, 'and the panel has not committed to it yet');
  await rested();
  assert.equal(run.log.marginDay, '2026-08-20');
  assert.equal(run.log.heldDay, null);
});

test('a hold takes the panel off the scroll and keeps it there; pressing again hands it back', async (t) => {
  reading({ wide: true });
  const run = readerOn(t);
  await settle(8);
  const canvas = canvasOf(run.log);
  await rested();

  run.log.holdPanel('2026-08-11');
  assert.equal(run.log.heldDay, '2026-08-11');
  assert.equal(run.log.marginDay, '2026-08-11');
  assert.equal(run.log.followedDay, '2026-08-20', 'a hold does not move the waterline');

  canvas.boxes.set('2026-08-11', { top: -420, bottom: -140 });   // scrolled off the top
  canvas.scroll();
  await rested();
  assert.equal(run.log.marginDay, '2026-08-11', 'the hold is the reader’s, and the scroll does not take it');

  run.log.followScroll();
  assert.equal(run.log.heldDay, null);
  assert.equal(run.log.marginDay, '2026-08-20', 'and the panel is back on the page the scroll chose');
});

test('a hold on a page whose echoes are gone falls through to the scroll rather than resting on nothing', async (t) => {
  reading({ wide: true });
  const run = readerOn(t);
  await settle(8);
  canvasOf(run.log);
  await rested();

  run.log.holdPanel('2026-03-03');            // a page the account has no echo on
  assert.equal(run.log.heldDay, '2026-03-03');
  assert.equal(run.log.marginDay, '2026-08-20');

  run.log.holdPanel('2026-08-11');
  run.log.retireEcho('2026-08-11');
  assert.equal(run.log.heldDay, null, 'retiring the held page releases the hold');
  assert.equal(run.log.marginDay, '2026-08-20');
});

test('a walk holds the panel on the page it lands on; going back to tonight hands it to the scroll', async (t) => {
  reading({ wide: true });
  const run = readerOn(t);
  await settle(8);

  run.log.walkTo('2026-08-20', { day: '2026-05-02', lo: 0, hi: 5 });
  assert.equal(run.log.heldDay, '2026-05-02');
  assert.equal(run.log.openDay, '2026-05-02');

  run.log.backToTonight();
  assert.equal(run.log.heldDay, null);
  assert.equal(run.log.openDay, null);
});

// ─── the deadband, the swap, and the one page everything on screen agrees about ───────────────────
//
// The panel names the page it describes, and the tie draws a line to it. Two marks asserting a page
// is one assertion that has to be true in every frame, so `shownDay` is the only day any of them
// reads. Below it sit the two guards that stop the assertion from flickering: a settle, which is a
// clock, and a deadband, which is not — inertia RESTS, so no amount of waiting catches a scroll that
// stops three pixels past the line, commits, drifts, and commits again.

test('a page must cross the waterline by 12px to take the panel, and by 12px to give it up', async (t) => {
  reading({ wide: true });
  const run = readerOn(t);
  await settle(8);
  const canvas = canvasOf(run.log);

  canvas.boxes.set('2026-08-20', { top: 500, bottom: 700 });   // well below the line
  canvas.scroll();
  await rested();
  assert.equal(run.log.marginDay, '2026-08-11');

  // Five pixels past the 330px waterline — a trackpad's inertia coming to rest. The old rule would
  // have committed here, drifted back, and committed again.
  canvas.boxes.set('2026-08-20', { top: 325, bottom: 525 });
  canvas.scroll();
  await rested();
  assert.equal(run.log.marginDay, '2026-08-11', 'a page inside the deadband took the panel');

  canvas.boxes.set('2026-08-20', { top: 317, bottom: 517 });   // 13px past: a real crossing
  canvas.scroll();
  await rested();
  assert.equal(run.log.marginDay, '2026-08-20');

  // And it holds it on the way back up until it is 12px clear on the other side.
  canvas.boxes.set('2026-08-20', { top: 341, bottom: 541 });
  canvas.scroll();
  await rested();
  assert.equal(run.log.marginDay, '2026-08-20', 'a page inside the deadband gave the panel up');

  canvas.boxes.set('2026-08-20', { top: 343, bottom: 543 });
  canvas.scroll();
  await rested();
  assert.equal(run.log.marginDay, '2026-08-11');
});

test('THE SWAP — the panel goes on naming the page it is drawing until the new one is ready to be named', async (t) => {
  reading({ wide: true });
  const run = readerOn(t);
  await settle(8);
  canvasOf(run.log);
  await shown();
  assert.equal(run.log.shownDay, '2026-08-20');
  assert.equal(run.log.swapping, false, 'the first page the panel ever describes takes no gap — there was nothing on screen to leave');

  run.log.holdPanel('2026-08-11');
  assert.equal(run.log.marginDay, '2026-08-11', 'the subject changed the instant the reader asked');
  assert.equal(run.log.shownDay, '2026-08-20', 'and every mark on screen is still naming the page it was drawing');
  assert.equal(run.log.swapping, true);

  await new Promise((resolve) => setTimeout(resolve, SWAP_MS + 60));
  assert.equal(run.log.shownDay, '2026-08-11', 'both halves changed together, at zero');
  assert.equal(run.log.swapping, false);
});

test('THE SWAP CANNOT WEDGE: changing the subject and changing it back inside the gap still resolves', async (t) => {
  // The gap's flag belongs to the DIFFERENCE between two days, so the moment they are equal again
  // something has to say so. Press one tab twice inside 90ms: the cleanup kills the timer that would
  // have cleared the flag, and an early return that only returned would hold the panel AND the rule
  // at opacity 0 for ever, with the canvas still lighting the row beside them. A double-click does it.
  reading({ wide: true });
  const run = readerOn(t);
  await settle(8);
  canvasOf(run.log);
  await shown();
  assert.equal(run.log.shownDay, '2026-08-20');

  run.log.holdPanel('2026-08-11');
  assert.equal(run.log.swapping, true);
  await new Promise((resolve) => setTimeout(resolve, 40));   // inside the gap
  run.log.followScroll();                                    // and straight back to where it was
  assert.equal(run.log.marginDay, '2026-08-20');
  assert.equal(run.log.swapping, false, 'the panel is stuck at opacity 0 with nothing left to clear it');

  await new Promise((resolve) => setTimeout(resolve, SWAP_MS + 80));
  assert.equal(run.log.shownDay, '2026-08-20', 'and it is still describing the page it never left');
  assert.equal(run.log.swapping, false);
});

test('the settle is a rate limit on the FACT: a pass across a page commits nothing until it rests', async (t) => {
  reading({ wide: true });
  const run = readerOn(t);
  await settle(8);
  const canvas = canvasOf(run.log);
  await rested();
  assert.equal(run.log.marginDay, '2026-08-20');

  // A fling: four proposals inside one settle, none of them the page it lands on.
  for (const top of [200, 120, 60, 500]) {
    canvas.boxes.set('2026-08-20', { top, bottom: top + 200 });
    canvas.scroll();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(run.log.followedDay, '2026-08-11', 'the waterline proposes continuously');
  assert.equal(run.log.marginDay, '2026-08-20', 'and the panel has committed to none of them yet');

  await rested();
  assert.equal(run.log.marginDay, '2026-08-11', 'it commits once, to the page the scroll landed on');
});

test('a page the reader has just refused is never left lit on the canvas with the panel resting', async (t) => {
  // `shownDay` is the machine's subject until the swap catches up, and for that stretch it can name a
  // page `pageOf` no longer answers — the panel would rest on "No echo on this page." while the
  // canvas went on lighting that page's row. One predicate, so the two cannot hold opposite halves.
  reading({ wide: true });
  const run = readerOn(t);
  await settle(8);
  canvasOf(run.log);
  await shown();
  assert.equal(run.log.shownDay, '2026-08-20');

  run.log.retireEcho('2026-08-20');
  assert.equal(run.log.pageOf('2026-08-20'), null, 'the page is off the canvas at once');
  assert.notEqual(run.log.shownDay, '2026-08-20',
    'the canvas is lighting a row for a page the panel cannot draw');
  await shown();
  assert.equal(run.log.shownDay, '2026-08-11', 'and the panel settles on what is left');
});

test('under prefers-reduced-motion the subject changes on ONE frame — a gap with no fade is the only motion left', async (t) => {
  reading({ wide: true, reduced: true });
  const run = readerOn(t);
  await settle(8);
  canvasOf(run.log);
  await rested();
  assert.equal(run.log.shownDay, '2026-08-20');

  run.log.holdPanel('2026-08-11');
  assert.equal(run.log.shownDay, '2026-08-11', 'the panel was held blank for 90ms with nothing crossing it');
  assert.equal(run.log.swapping, false);
});

test('below the margin’s width nothing describes a page, so no day row may be lit as though something did', async (t) => {
  reading({ wide: false });
  const run = readerOn(t);
  await settle(8);
  canvasOf(run.log);
  await shown();
  assert.equal(run.log.marginDay, '2026-08-20', 'the waterline still has an answer');
  assert.equal(run.log.shownDay, null, 'but there is no panel for that answer to be the subject of');
});

test('AN ARRIVAL NEVER CHANGES WHICH PAGE IS ADDRESSED — news lower on the same screen does not take the panel', async (t) => {
  const server = reading({ wide: true, pages: [ECHO_PAGES[0]] });
  const run = readerOn(t);
  await settle(12);
  canvasOf(run.log);
  await shown();
  assert.equal(run.log.shownDay, '2026-08-11', 'the only echo page on screen');

  // A page further down the SAME screen gets an echo while the reader is mid-sentence. Its day row is
  // below the waterline, so a re-decided pick would hand it the panel and swap the prose under them —
  // a step, and a far louder one than the light that caused it.
  server.serve(ECHO_PAGES);
  run.log.reread();
  await settle(12);
  await shown();
  assert.equal(run.log.lit?.day, '2026-08-20', 'the news did land, and it lit its own tab');
  assert.equal(run.log.marginDay, '2026-08-11', 'and the panel stayed on the prose the reader was in');
  assert.equal(run.log.shownDay, '2026-08-11');
  assert.equal(run.log.swapping, false, 'nothing swapped, because the SUBJECT did not change');
});

// ─── the arrival ─────────────────────────────────────────────────────────────────────────────────
//
// The light asserts that something is NEW, which is a claim about time, and a claim about time is
// exactly what a browser cannot show you and a test can. The rule itself is pure (arrival.test.js);
// these are the ways the hook around it could still light the wrong thing, twice, or forever. Time
// is real here — no clock is stubbed except where a case is about a two-second pause.

const LANDED = { day: '2026-02-02', text: 'newly found words', occurrenceHint: 0 };
const withMatch = (page, match) => ({ ...page, matches: [...page.matches, match] });

test('the mount’s first completed read arms nothing — a page already there when you opened is not news', async (t) => {
  reading({ wide: false });
  const run = readerOn(t);
  await settle(12);

  assert.equal(run.log.pageOf('2026-08-11').matches.length, 1, 'the page is on the canvas');
  assert.equal(run.log.lit, null, 'and nothing about it is claimed to have just happened');
  assert.equal(run.log.announce, null);
});

test('a passage that lands after the journal is open lights its page, ONCE, however often it is re-read', async (t) => {
  const server = reading({ wide: false, pages: [ECHO_PAGES[0]] });
  const run = readerOn(t);
  await settle(12);
  assert.equal(run.log.lit, null);

  server.serve([withMatch(ECHO_PAGES[0], LANDED)]);
  run.log.reread();
  await settle(12);

  assert.equal(run.log.lit.day, '2026-08-11');
  assert.equal(run.log.lit.count, 2, 'the light names what the tab says, not what is new about it');
  assert.equal(typeof run.log.lit.kindledAt, 'number');
  assert.equal(run.log.presentedBefore('2026-08-11'), true,
    'this page was drawn on the mount read, so its tab is not a new object and must not ramp in');
  const first = run.log.lit;

  for (let beat = 0; beat < 3; beat += 1) {
    run.log.reread();
    await settle(12);
    assert.equal(run.log.lit, first, 'the same news re-read is not a second arrival');
  }
});

// Whether a TAB is new is a fact about an element, not about the arming, because the tab is drawn by
// the read and armed a body fetch later. The hook answers only what it can: had this page ever been
// drawn at rest when the element asked?
test('a page nobody had an echo on at all has not been presented, and its tab is a new object', async (t) => {
  const server = reading({ wide: false, pages: [ECHO_PAGES[0]] });
  const run = readerOn(t);
  await settle(12);
  assert.equal(run.log.presentedBefore('2026-08-20'), false, 'no such page has ever been drawn');

  server.serve(ECHO_PAGES);
  run.log.reread();
  await settle(12);

  assert.equal(run.log.lit.day, '2026-08-20');
  assert.equal(run.log.lit.count, 1);
  assert.equal(run.log.presentedBefore('2026-08-20'), true, 'and now it has, so a remount ramps nothing');
});

test('AT MOST ONE TAB IS LIT: a read dropping echoes on two pages lights the one at the waterline', async (t) => {
  const server = reading({ wide: true, pages: [] });
  const run = readerOn(t);
  await settle(12);
  canvasOf(run.log);
  await rested();

  server.serve(ECHO_PAGES);
  run.log.reread();
  await settle(12);
  await rested();

  assert.equal(run.log.lit.day, '2026-08-20', 'the page under the reading waterline, and only it');
  assert.equal(run.log.lit.count, 1);
});

test('news on a second page moves the light rather than adding one — never two at once', async (t) => {
  const server = reading({ wide: false, pages: [ECHO_PAGES[0]] });
  const run = readerOn(t);
  await settle(12);

  server.serve([withMatch(ECHO_PAGES[0], LANDED)]);
  run.log.reread();
  await settle(12);
  assert.equal(run.log.lit.day, '2026-08-11');

  server.serve([withMatch(ECHO_PAGES[0], LANDED), ECHO_PAGES[1]]);
  run.log.reread();
  await settle(12);
  assert.equal(run.log.lit.day, '2026-08-20', 'the newer news takes the one light there is');
});

test('a shrinking match set arms nothing, and retiring the lit page puts the light out', async (t) => {
  const server = reading({ wide: false, pages: [withMatch(ECHO_PAGES[0], LANDED)] });
  const run = readerOn(t);
  await settle(12);
  assert.equal(run.log.lit, null);

  server.serve([ECHO_PAGES[0]]);
  run.log.reread();
  await settle(12);
  assert.equal(run.log.lit, null, 'a passage taken away is not a passage arriving');

  server.serve([withMatch(ECHO_PAGES[0], LANDED)]);
  run.log.reread();
  await settle(12);
  assert.equal(run.log.lit, null, 'and it comes back as a repair, not as news');
});

test('a light whose page is retired goes out with it', async (t) => {
  const server = reading({ wide: false, pages: [ECHO_PAGES[0]] });
  const run = readerOn(t);
  await settle(12);

  server.serve(ECHO_PAGES);
  run.log.reread();
  await settle(12);
  assert.equal(run.log.lit.day, '2026-08-20');

  run.log.retireEcho('2026-08-20');
  await settle(4);
  assert.equal(run.log.lit, null);
});

test('one region says the tab’s own words, once per arrival, and never the word "new"', async (t) => {
  const server = reading({ wide: false, pages: [ECHO_PAGES[0]] });
  const run = readerOn(t);
  await settle(12);
  assert.equal(run.log.announce, null, 'nothing is said about what was already on screen');

  server.serve([withMatch(ECHO_PAGES[0], LANDED)]);
  run.log.reread();
  await settle(12);
  assert.deepEqual(
    { day: run.log.announce.day, count: run.log.announce.count },
    { day: '2026-08-11', count: 2 },
  );
  assert.equal(run.log.announce.at, run.log.lit.kindledAt);
});

// ─── the dwell ───────────────────────────────────────────────────────────────────────────────────
//
// The light waits to be spent, and ONLY WHILE THE TAB IS ON SCREEN. That is the half that makes
// firing the instant an echo lands survivable: if tonight's echo lands while the writer is reading
// March, nothing spends it, and the scroll back is what starts the decay as they arrive.

async function lightOn(t, { wide = false, covered = false } = {}) {
  const server = reading({ wide, pages: [ECHO_PAGES[0]] });
  const run = renderHook(t, () => useEchoes({ today: '2026-09-01', account: 'reader', covered }));
  await settle(12);
  const canvas = canvasOf(run.log);
  await settle(4);
  server.serve([withMatch(ECHO_PAGES[0], LANDED)]);
  run.log.reread();
  await settle(12);
  return { run, canvas, server };
}

test('nothing spends a light the reader cannot see — a surfacing event off-screen counts for nothing', async (t) => {
  const { run, canvas } = await lightOn(t);
  assert.equal(run.log.lit.day, '2026-08-11');
  assert.equal(canvas.hears('pointerdown'), 0, 'out of sight, the dwell listens for nothing at all');

  canvas.fire('pointerdown');
  canvas.fire('focusout');
  await settle(4);
  assert.equal(run.log.lit.day, '2026-08-11', 'the light was never fired into an empty room');
});

test('once the tab is on screen, a press anywhere in the canvas spends the light', async (t) => {
  const { run, canvas } = await lightOn(t);
  run.log.litInView(true);
  await settle(4);
  assert.equal(canvas.hears('pointerdown'), 1);

  canvas.fire('pointerdown');
  await settle(4);
  assert.equal(run.log.lit, null);
});

test('the composer losing focus spends it too, and the listeners come off with the light', async (t) => {
  const { run, canvas } = await lightOn(t);
  run.log.litInView(true);
  await settle(4);

  canvas.fire('focusout');
  await settle(4);
  assert.equal(run.log.lit, null);
  assert.deepEqual(
    [canvas.hears('keydown'), canvas.hears('focusout'), canvas.hears('pointerdown')],
    [0, 0, 0],
    'a spent dwell leaves nothing listening',
  );
});

test('a scroll that has RESTED spends it; a scroll still moving does not', async (t) => {
  const { run, canvas } = await lightOn(t);
  run.log.litInView(true);
  await settle(4);

  canvas.fire('scroll');
  await settle(4);
  assert.equal(run.log.lit.day, '2026-08-11', 'still moving — the reader has not arrived anywhere');

  await rested();
  assert.equal(run.log.lit, null);
});

test('a press on the tab ends the dwell at once, with no decay, and marks the page for one beat', async (t) => {
  const { run } = await lightOn(t);
  run.log.litInView(true);
  await settle(4);

  run.log.spendLight('2026-08-11');
  await settle(4);
  assert.equal(run.log.lit, null);
  assert.equal(run.log.taken, '2026-08-11');
});

test('two seconds without a keystroke spends it; every keystroke puts the two seconds back', async (t) => {
  const { run, canvas } = await lightOn(t);
  // Taken over before the tab comes into sight, so EVERY timer the dwell arms — the pause and the
  // 90s ceiling both — is one this clock owns and can clear again.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  run.log.litInView(true);
  await settle(4);

  t.mock.timers.tick(1900);
  assert.equal(run.log.lit.day, '2026-08-11');

  canvas.fire('keydown');                       // mid-sentence: the pause starts again
  t.mock.timers.tick(1900);
  assert.equal(run.log.lit.day, '2026-08-11', 'a writer still typing has not surfaced');

  t.mock.timers.tick(200);
  assert.equal(run.log.lit, null);
});

test('an arrival under an overlay is HELD, not spent, and kindles on the first frame the canvas is back', async (t) => {
  const server = reading({ wide: false, pages: [ECHO_PAGES[0]] });
  let covered = true;
  const run = renderHook(t, () => useEchoes({ today: '2026-09-01', account: 'reader', covered }));
  await settle(12);
  canvasOf(run.log);
  await settle(4);

  server.serve([withMatch(ECHO_PAGES[0], LANDED)]);
  run.log.reread();
  await settle(12);
  assert.equal(run.log.lit.day, '2026-08-11', 'the news is held');
  assert.equal(run.log.lit.kindledAt, null, 'but no light is burning under the zoom view');
  assert.equal(run.log.announce, null, 'and nothing is announced into a screen nobody is on');

  covered = false;
  run.redraw();
  await settle(4);
  assert.equal(typeof run.log.lit.kindledAt, 'number', 'the canvas is back, and now it kindles');
  assert.equal(run.log.announce.count, 2);
});

// A light has two exits and they do not look alike: a slow decay when the writer surfaced, and no
// decay at all when they pressed the tab. Both are MARKED rather than inferred, because the ramps
// belong to the arrival alone — a tab's own states are the scroll's and the reader's, and a scroll
// that repaints twenty tabs must not set twenty 2.4s cross-fades running.
test('a light spent by surfacing settles, and the settle ends on its own clock', async (t) => {
  const { run, canvas } = await lightOn(t);
  // Taken over before the dwell arms anything, so every timer it makes is one this clock can clear.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  run.log.litInView(true);
  await settle(4);
  assert.equal(run.log.settling, null, 'nothing is settling while the light is still burning');

  canvas.fire('pointerdown');
  await settle(4);
  assert.equal(run.log.lit, null);
  assert.equal(run.log.settling, '2026-08-11');
  assert.equal(run.log.taken, null, 'nobody pressed anything');

  t.mock.timers.tick(2399);
  assert.equal(run.log.settling, '2026-08-11');
  t.mock.timers.tick(2);
  assert.equal(run.log.settling, null, 'and the ramp is gone with the light it belonged to');
});

test('a press takes the light with no decay: taken, never settling', async (t) => {
  const { run } = await lightOn(t);
  run.log.litInView(true);
  await settle(4);

  run.log.spendLight('2026-08-11');
  await settle(4);
  assert.equal(run.log.settling, null, 'a press asks for the face it pressed, not for a decay');
  assert.equal(run.log.taken, '2026-08-11');
});

test('a second echo landing mid-settle takes the light back rather than decaying under it', async (t) => {
  const { run, canvas, server } = await lightOn(t);
  run.log.litInView(true);
  await settle(4);
  canvas.fire('pointerdown');
  await settle(4);
  assert.equal(run.log.settling, '2026-08-11');

  server.serve([withMatch(withMatch(ECHO_PAGES[0], LANDED), {
    day: '2026-03-03', text: 'later still', occurrenceHint: 0,
  })]);
  run.log.reread();
  await settle(12);

  assert.equal(run.log.lit.day, '2026-08-11');
  assert.equal(run.log.lit.count, 3);
  assert.equal(run.log.settling, null, 'the two ramps are never on the same tab at once');
});

// ─── the ways an arrival can lie about time, about whose prose it is, or about what it costs ─────

test('THE MOUNT READ PRESENTS ITSELF AS IT LANDS, so no later commit can mistake it for news', async (t) => {
  // The first read used to say "I am the first" through a counter an EFFECT read one commit later.
  // A tab returning to the foreground fires visibilitychange AND focus, so two reads start; batched
  // into one commit, the counter already said two, the memory was still empty, and every page the
  // mount itself had read armed. The read now seeds the memory itself, so there is no window at all.
  const server = reading({ wide: false });
  const run = readerOn(t);
  await settle(12);

  for (const day of ['2026-08-11', '2026-08-20']) {
    assert.equal(run.log.presentedBefore(day), true, `${day} was read at mount and is not news`);
  }
  assert.equal(run.log.lit, null);

  // and a second read landing on top of the first still arms nothing
  server.serve(ECHO_PAGES);
  run.log.reread();
  run.log.reread();
  await settle(16);
  assert.equal(run.log.lit, null, 'the journal claimed something was new that was there when it opened');
});

test('A READ THAT OUTLIVES A SIGN-OUT IS DROPPED — it may not draw, light or announce another account', async (t) => {
  let account = 'alice';
  const server = reading({ wide: false, pages: [] });
  const run = renderHook(t, () => useEchoes({ today: '2026-09-01', account }));
  await settle(12);

  // Alice's poll goes out and is still in the air when she signs out.
  server.serve([{
    day: '2026-08-11',
    entitled: true,
    matches: [{ day: '2026-05-02', text: 'alice private words', occurrenceHint: 0 }],
  }]);
  server.holdReplies();
  run.log.reread();
  await settle(4);

  account = 'bob';
  server.serve([]);                  // Bob has no echoes of his own
  server.resume();                   // and Bob's own read answers at once
  run.redraw();
  await settle(12);
  assert.equal(run.log.pageOf('2026-08-11'), null, 'Bob starts on his own empty canvas');

  // Alice's read lands LAST, so nothing but the era it started under can keep it off this canvas.
  const bodiesRead = server.asked.page;
  server.release();
  await settle(16);

  assert.equal(server.asked.page, bodiesRead,
    'the reply was taken: Bob’s canvas went and fetched the bodies of Alice’s quotes');
  assert.equal(run.log.pageOf('2026-08-11'), null, 'Alice’s page was drawn on Bob’s canvas');
  assert.equal(run.log.lit, null, 'and it lit a tab');
  assert.equal(run.log.announce, null, 'and a screen reader was told about it');
});

test('opening the journal fetches no bodies of its own — the tabs that draw ask for what they need', async (t) => {
  const server = reading({ wide: false });
  const run = readerOn(t);
  await settle(16);

  assert.equal(server.asked.echoes, 1);
  assert.equal(server.asked.page, 0,
    'the mount read swept every body of every echo page before the reader scrolled anywhere');
  assert.equal(run.log.pageOf('2026-08-11').verified, false, 'and nothing is claimed to be checked');
});

test('a page a LATER read brings IS re-located at once, without waiting out the beat', async (t) => {
  const server = reading({ wide: false, pages: [ECHO_PAGES[0]] });
  const run = readerOn(t);
  await settle(16);
  const before = server.asked.page;

  server.serve(ECHO_PAGES);
  run.log.reread();
  await settle(16);

  assert.ok(server.asked.page > before, 'the page that just landed waited for the next beat to be checked');
  assert.equal(run.log.pageOf('2026-08-20').verified, true);
  assert.equal(run.log.lit.day, '2026-08-20');
});

// The tie's requirement, and the one an arrival is most likely to break: the panel addresses the page
// the SCROLL and the READER chose. Nothing the journal receives may take that answer.
test('AN ARRIVAL NEVER MOVES THE PANEL, even onto a page further down the same screen', async (t) => {
  const server = reading({ wide: true, pages: [ECHO_PAGES[0]] });
  const run = readerOn(t);
  await settle(12);
  const canvas = canvasOf(run.log);
  await rested();
  assert.equal(run.log.marginDay, '2026-08-11', 'the only echo page on screen');

  server.serve(ECHO_PAGES);          // an echo lands on 2026-08-20, lower down the same screen
  run.log.reread();
  await settle(16);
  await rested();

  assert.equal(run.log.lit.day, '2026-08-20', 'the news did land');
  assert.equal(run.log.marginDay, '2026-08-11',
    'and it swapped the prose the reader was mid-sentence in, with the 180ms follow');

  // a real scroll still moves it, because that is the reader moving rather than the journal receiving
  canvas.boxes.set('2026-08-11', { top: -420, bottom: -140 });
  canvas.scroll();
  await rested();
  assert.equal(run.log.marginDay, '2026-08-20');
});

test('the light moving to newer news leaves the page it left DECAYING, not dark', async (t) => {
  const server = reading({ wide: false, pages: [ECHO_PAGES[0]] });
  const run = readerOn(t);
  await settle(12);

  server.serve([withMatch(ECHO_PAGES[0], LANDED)]);
  run.log.reread();
  await settle(16);
  assert.equal(run.log.lit.day, '2026-08-11');

  server.serve([withMatch(ECHO_PAGES[0], LANDED), ECHO_PAGES[1]]);
  run.log.reread();
  await settle(16);

  assert.equal(run.log.lit.day, '2026-08-20', 'the one light there is moved to the newer news');
  assert.equal(run.log.settling, '2026-08-11',
    'the whole ramp lives on the lit class, so a page losing it with no settle SNAPS');
});

test('A READ THAT PRESENTED NOTHING IS NOT THE FIRST READ — a floored mount arms nothing later', (t) => {
  // `pagesWritten` can read under the floor for a beat: a poll can land mid-sweep on a page between
  // deletion and rewrite. If a floored reply spent the first read, the NEXT read would find every
  // page in the account unseen and light one — the mount's own back catalogue, announced as news.
  return (async () => {
    const server = reading({ wide: false });
    server.floorNext();
    const run = readerOn(t);
    await settle(12);
    assert.equal(run.log.pageOf('2026-08-11'), null, 'under the floor the canvas stays quiet');
    assert.equal(run.log.lit, null);

    run.log.reread();
    await settle(16);

    assert.equal(run.log.pageOf('2026-08-11').matches.length, 1, 'and now the pages are there');
    assert.equal(run.log.lit, null, 'they were always there — the floor was hiding them, not the clock');
    assert.equal(run.log.presentedBefore('2026-08-11'), true);
  })();
});

test('an echo an edit retracted comes back as news, and as a new tab, when the words come back', async (t) => {
  const server = reading({ wide: false, pages: [ECHO_PAGES[0]] });
  // The beat is what re-reads bodies the client already holds, so it is the beat that retires a
  // quote the writer has edited away. Taken over here so the test does not sit through 15s of it.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const run = readerOn(t);
  await settle(16);
  assert.equal(run.log.presentedBefore('2026-08-11'), true);

  // the writer edits the quoted page until the passage no longer stands
  server.editBody('2026-05-02', 'nothing like it any more');
  t.mock.timers.tick(15000);
  await settle(16);
  assert.equal(run.log.pageOf('2026-08-11'), null, 'the echo left the canvas with the words');
  assert.equal(run.log.presentedBefore('2026-08-11'), false,
    'a page that has left the canvas is not still being presented');

  // and they undo it
  server.editBody('2026-05-02', 'before this. older words. and after.');
  t.mock.timers.tick(15000);
  await settle(16);

  assert.equal(run.log.pageOf('2026-08-11').matches.length, 1);
  assert.equal(run.log.lit.day, '2026-08-11', 'the tab came back with no signal at all');
});
