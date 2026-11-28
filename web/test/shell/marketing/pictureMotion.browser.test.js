// The picture frame under a real pointer and on a phone: a fixture picture whose sheet starts a beat under `data-beat`,
// an endless loop under `data-pointed` and a second loop on an element marked `data-cut`, drawn in three frames on one
// route: one in view, one far down the page and one taller than the view. The page's clock is paused and moved only by
// the test, so every rule the frame times (a phone's 400ms hold, the 1000ms rest, the 2400ms re-arm, the beat's
// ceiling) is checked to the millisecond; the pictures' own animations run in real time and are waited on, not timed.
// On `?phone` the frames stand 40px apart and every beat runs 1500ms; on `?stuck` no beat finishes in a test's time; on
// `?held` the first picture draws when the test releases it, and on `?failed` it never does.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';
import { beacon } from '../../products/roadmap/browserFixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = `
import React, { lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { PictureFrame } from '/src/shell/marketing/SiteChrome.jsx';
import '/src/styles/global.css';
const query = new URLSearchParams(location.search);
const phone = query.has('phone');
const sheet = document.createElement('style');
sheet.textContent = \`
  .fx { height: 100%; }
  .fx i { display: block; width: 20px; height: 20px; }
  [data-beat] .fx-beat { animation: fx-fade 400ms linear; }
  [data-pointed] .fx-loop, [data-pointed] .fx-cut { animation: fx-fade 800ms linear infinite; }
  @keyframes fx-fade { 50% { opacity: .5; } }
\` + (phone ? '[data-beat] .fx-beat { animation-duration: 1500ms; }' : '')
  + (query.has('stuck') ? '[data-beat] .fx-beat { animation-duration: 60000ms; }' : '');
document.head.append(sheet);
const e = React.createElement;
const fixture = (name) => () => e('div', { className: 'fx', 'data-fx': name }, e('i', { className: 'fx-beat' }), e('i', { className: 'fx-loop' }), e('i', { className: 'fx-cut', 'data-cut': '' }));
const nearPicture = query.has('held') ? lazy(() => new Promise((resolve) => { window.release = () => resolve({ default: fixture('near') }); }))
  : query.has('failed') ? lazy(() => Promise.reject(new Error('chunk failed'))) : fixture('near');
const frame = (name, height, Picture = fixture(name)) => e(PictureFrame, { id: 'fixture', page: 'front', route: '/', theme: 'light',
  picture: { name, label: 'Composed', stages: [{ name: 'only', width: 400, height }], Picture } });
const gap = () => e('div', { style: { height: phone ? 40 : 1200 } });
createRoot(document.getElementById('root')).render(e('div', { style: { width: 600, maxWidth: '100%' } },
  frame('near', 300, nearPicture), gap(), frame('far', 300), gap(), frame('tall', 1500), e('div', { style: { height: 1200 } })));
`;

let server, browser, origin;
const ready = (async () => {
  const { output } = await build({ configFile: false, root, logLevel: 'silent', mode: 'development',
    plugins: [{ name: 'picture-motion-fixture', enforce: 'pre', resolveId(id) {
      if (id === '/picture-motion.js') return '\0entry';
      if (id.endsWith('/auth/AuthProvider.jsx')) return '\0auth';
      if (id.endsWith('/auth/SignInDoor.jsx')) return '\0door';
      if (id.endsWith('/telemetry/beacon.js')) return '\0events';
      if (id.endsWith('/telemetry/sentry.js')) return '\0sentry';
    }, load(id) {
      if (id === '\0entry') return entry;
      if (id === '\0auth') return 'export const useAuth = () => ({ status: "ghost", user: null, signOut() {} });';
      if (id === '\0door') return 'export const useSignInDoor = () => () => {}; export const useSignInDoorHost = () => () => {};';
      if (id === '\0events') return beacon;
      if (id === '\0sentry') return 'export function captureError(kind, operation, stack, route, tags) { (window.captured ??= []).push([kind, operation, route, stack.length > 0, tags ?? null]); }';
    } }], build: { write: false, minify: false, cssCodeSplit: false, modulePreload: false,
      rollupOptions: { input: '/picture-motion.js', output: { entryFileNames: 'entry.js' } } } });
  const files = new Map(output.map((file) => ['/' + file.fileName, file.type === 'chunk' ? file.code : file.source]));
  const css = [...files.keys()].find((name) => name.endsWith('.css'));
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.startsWith('/v1/') || path.endsWith('.svg') || path.endsWith('.woff2')) { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(files.get(path) ?? `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${css}"><div id="root"></div><script type="module" src="/entry.js"></script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
ready.catch(() => {});
after(async () => { try { await ready; } finally { await browser?.close(); server?.close(); } });

const DESK = { viewport: { width: 800, height: 600 } };
// A phone: touch, no hover, 390 wide.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

// A page with the three frames, its clock paused, and in it `window.log`: every change of the two attributes on each
// body, and each beat animation's end (`finished`, or `cancelled` when the lifted attribute took it), in order, as
// [body, what, on]; `window.seen`: whether each body is seen by the frame's own rule; and `window.beatOf`: the beat
// animation each body's last beat started.
async function open({ device = DESK, path = '/', drawn = 3 } = {}) {
  await ready;
  const context = await browser.newContext(device);
  await context.clock.install({ time: 1_000_000 });
  await context.clock.pauseAt(1_000_100);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + path);
  await page.waitForFunction((count) => document.querySelectorAll('.front-picture-body').length === 3 && document.querySelectorAll('.fx').length === count, drawn, { timeout: 30000 });
  await page.evaluate(() => {
    window.scrolls = 0;
    addEventListener('scroll', () => { window.scrolls += 1; });
    window.log = [];
    window.seen = [];
    window.beatOf = [];
    const steps = Array.from({ length: 101 }, (_, step) => step / 100);
    document.querySelectorAll('.front-picture-body').forEach((body, index) => {
      new MutationObserver((records) => records.forEach((record) => {
        const on = body.hasAttribute(record.attributeName);
        window.log.push([index, record.attributeName, on]);
        if (record.attributeName !== 'data-beat' || !on) return;
        const beat = body.querySelector('.fx-beat')?.getAnimations()[0];
        window.beatOf[index] = beat;
        beat?.finished.then(() => window.log.push([index, 'finished', true]), () => window.log.push([index, 'cancelled', true]));
      })).observe(body, { attributes: true, attributeFilter: ['data-pointed', 'data-beat'] });
      new IntersectionObserver(([entry]) => {
        window.seen[index] = entry.intersectionRatio >= 0.6 || entry.intersectionRect.height >= 0.6 * entry.rootBounds.height;
      }, { threshold: steps }).observe(body);
    });
  });
  await page.mouse.move(700, 10);
  return { page, errors, context, close: () => context.close() };
}

const NEAR = [300, 250];
const OUTSIDE = [700, 10];
const attributes = (page, index = 0) => page.evaluate((at) => {
  const body = document.querySelectorAll('.front-picture-body')[at];
  return ['data-pointed', 'data-beat'].filter((name) => body.hasAttribute(name));
}, index);
const logged = (page) => page.evaluate(() => window.log);
const events = (page) => page.evaluate(() => window.events ?? []);
const seenAs = (page, index, value) => page.waitForFunction(([at, wanted]) => window.seen[at] === wanted, [index, value], { timeout: 10000 });
const ended = (page, count) => page.waitForFunction((least) => window.log.filter(([, name, on]) => name === 'data-beat' && !on).length >= least, count, { timeout: 20000 });
const beatsIn = (log) => log.filter(([, name]) => name === 'data-beat').map(([index, , on]) => `${index}${on ? '+' : '-'}`);
// Each body's beat records as one line: '+' as it began, its animation's end, '-' as it lifted.
const endingsIn = (log, index) => log.filter(([at, name]) => at === index && name !== 'data-pointed')
  .map(([, name, on]) => (name === 'data-beat' ? (on ? '+' : '-') : name)).join(' ');
const scrollToBody = (page, index, offset) => page.evaluate(([at, by]) => {
  const top = document.querySelectorAll('.front-picture-body')[at].getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, top - by);
}, [index, offset]);
const loopOf = (page, selector) => page.evaluate((target) => document.querySelector(target).getAnimations()
  .map((animation) => ({ iterations: animation.effect.getTiming().iterations, state: animation.playState })), selector);

test('the frame spares a screen reader and the keyboard without inert, and holds nothing to focus', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  const bodies = await page.evaluate(() => [...document.querySelectorAll('.front-picture-body')].map((body) => ({
    hidden: body.getAttribute('aria-hidden'),
    inert: body.hasAttribute('inert') || Boolean(body.closest('[inert]')),
    focusable: body.querySelectorAll('a, button, input, select, textarea, [tabindex], [contenteditable]').length,
    pointerEvents: getComputedStyle(body).pointerEvents,
    cursor: getComputedStyle(body.querySelector('.fx')).cursor,
  })));
  await close();
  assert.deepEqual(errors, []);
  assert.deepEqual(bodies, Array(3).fill({ hidden: 'true', inert: false, focusable: 0, pointerEvents: 'auto', cursor: 'default' }));
});

test('a mouse on a drawn, seen picture points at it and plays the beat, which lifts as its animations finish', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  assert.deepEqual(await attributes(page), []);
  await page.mouse.move(...NEAR);
  assert.deepEqual(await attributes(page), ['data-pointed', 'data-beat']);
  await ended(page, 1);
  const seen = { log: await logged(page), now: await attributes(page) };
  await close();
  assert.deepEqual(seen, { log: [[0, 'data-pointed', true], [0, 'data-beat', true], [0, 'finished', true], [0, 'data-beat', false]], now: ['data-pointed'] });
  assert.deepEqual(errors, []);
});

test('entering again while the beat runs changes nothing, and the beat plays again only after 2400ms out', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  await page.mouse.move(...NEAR);
  await page.mouse.move(...OUTSIDE);
  await page.mouse.move(...NEAR);
  const again = await page.evaluate(() => document.querySelector('.fx-beat').getAnimations().map((animation) => animation === window.beatOf[0]));
  await ended(page, 1);
  await page.mouse.move(...OUTSIDE);
  await page.clock.runFor(2399);
  await page.mouse.move(...NEAR);
  const early = await attributes(page);
  await page.mouse.move(...OUTSIDE);
  await page.clock.runFor(2400);
  await page.mouse.move(...NEAR);
  const rearmed = await attributes(page);
  await close();
  assert.deepEqual(again, [true], 'the beat started over');
  assert.deepEqual({ early, rearmed }, { early: ['data-pointed'], rearmed: ['data-pointed', 'data-beat'] });
  assert.deepEqual(errors, []);
});

test('leaving lets an endless loop finish its cycle before data-pointed goes, and a cut loop stops at once', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  await page.mouse.move(...NEAR);
  await ended(page, 1);
  // The loop is held still in its second cycle, so its end comes only when the test lets it run.
  await page.evaluate(() => { const loop = document.querySelector('.fx-loop').getAnimations()[0]; loop.pause(); loop.currentTime = 1000; window.loop = loop; });
  await page.mouse.move(...OUTSIDE);
  const left = { attributes: await attributes(page), loop: await loopOf(page, '.fx-loop'), cut: await loopOf(page, '.fx-cut') };
  await page.evaluate(() => {
    window.loopAtLift = null;
    new MutationObserver(() => { window.loopAtLift ??= [window.loop.playState, window.loop.currentTime]; })
      .observe(document.querySelector('.front-picture-body'), { attributes: true, attributeFilter: ['data-pointed'] });
    window.loop.play();
  });
  await page.waitForFunction(() => !document.querySelector('.front-picture-body').hasAttribute('data-pointed'), null, { timeout: 10000 });
  const atLift = await page.evaluate(() => window.loopAtLift);
  await close();
  assert.deepEqual(left, { attributes: ['data-pointed'], loop: [{ iterations: 2, state: 'paused' }], cut: [] });
  assert.deepEqual(atLift, ['finished', 1600]);
  assert.deepEqual(errors, []);
});

test('a pointer back before the cycle ends keeps both loops endless', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  await page.mouse.move(...NEAR);
  await page.evaluate(() => { const loop = document.querySelector('.fx-loop').getAnimations()[0]; loop.pause(); loop.currentTime = 100; });
  await page.mouse.move(...OUTSIDE);
  await page.mouse.move(...NEAR);
  const seen = { attributes: (await attributes(page)).includes('data-pointed'), loop: await loopOf(page, '.fx-loop'), cut: await loopOf(page, '.fx-cut') };
  await close();
  assert.deepEqual(seen, { attributes: true, loop: [{ iterations: Infinity, state: 'running' }], cut: [{ iterations: Infinity, state: 'running' }] });
  assert.deepEqual(errors, []);
});

test('a picture is pointed at wherever the mouse is on it, and plays its beat only once it is also seen', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  // The far picture, 300px tall, with 90px of it in view: pointed at, and no beat.
  await scrollToBody(page, 1, 510);
  await seenAs(page, 1, false);
  await page.mouse.move(300, 560);
  const sliver = await attributes(page, 1);
  // The page scrolls under the pointer until 210px of it is in view: the beat plays.
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => document.querySelectorAll('.front-picture-body')[1].hasAttribute('data-beat'), null, { timeout: 10000 });

  // The tall picture, 1500px, never 60% in view: it is seen once it covers 400px of the 600px view.
  await page.mouse.move(...OUTSIDE);
  await scrollToBody(page, 2, 400);
  await seenAs(page, 2, false);
  await page.mouse.move(300, 500);
  const short = await attributes(page, 2);
  await scrollToBody(page, 2, 200);
  await page.mouse.move(300, 501);
  await page.waitForFunction(() => document.querySelectorAll('.front-picture-body')[2].hasAttribute('data-beat'), null, { timeout: 10000 });
  await close();
  assert.deepEqual({ sliver, short }, { sliver: ['data-pointed'], short: ['data-pointed'] });
  assert.deepEqual(errors, []);
});

test('front_picture is told once a mouse has rested a second on a drawn, seen picture with the page still, and for nothing less', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  // A pass across: 600ms, then away.
  await page.mouse.move(...NEAR);
  await page.clock.runFor(600);
  await page.mouse.move(...OUTSIDE);
  await page.clock.runFor(2000);
  const pass = await events(page);
  // A rest broken by the page scrolling under the mouse every 300ms, then left still.
  await page.mouse.move(...NEAR);
  for (let step = 0; step < 5; step += 1) {
    await page.clock.runFor(300);
    const scrolls = await page.evaluate(() => { window.scrollBy(0, 1); return window.scrolls; });
    await page.waitForFunction((count) => window.scrolls > count, scrolls, { timeout: 5000 });
  }
  const scrolling = await events(page);
  await page.clock.runFor(999);
  const almost = await events(page);
  await page.clock.runFor(1);
  const rested = await events(page);
  // A second rest, and a pen joining the mouse: still one.
  await page.mouse.move(...OUTSIDE);
  await page.mouse.move(...NEAR);
  await page.evaluate(() => document.querySelector('.front-picture-body').dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'pen', pointerId: 7 })));
  await page.clock.runFor(3000);
  const again = await events(page);
  await close();
  assert.deepEqual({ pass, scrolling, almost }, { pass: [], scrolling: [], almost: [] });
  assert.deepEqual(rested, [{ name: 'front_picture', props: { page: 'front', product: 'fixture', picture: 'near' } }]);
  assert.deepEqual(again, rested);
  assert.deepEqual(errors, []);
});

test('front_picture is never told for a sliver, a slow scroll past, or two pointers resting together', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  // A sliver of the far picture, 90px of its 300px in view, under a resting mouse for three seconds.
  await scrollToBody(page, 1, 510);
  await seenAs(page, 1, false);
  await page.mouse.move(300, 560);
  await page.clock.runFor(3000);
  const sliver = await events(page);
  // The mouse parked while the page scrolls 20px every 100ms from the top to past the tall picture.
  await page.mouse.move(300, 300);
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let top = 0; top < 4400; top += 20) {
    await page.mouse.wheel(0, 20);
    await page.clock.runFor(100);
  }
  const scrolled = await events(page);
  // A mouse and a pen entering the near picture together, resting a second: told once.
  await page.mouse.move(...OUTSIDE);
  await page.evaluate(() => window.scrollTo(0, 0));
  await seenAs(page, 0, true);
  await page.mouse.move(...NEAR);
  await page.evaluate(() => document.querySelector('.front-picture-body').dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'pen', pointerId: 7 })));
  await page.clock.runFor(1000);
  const together = await events(page);
  await close();
  assert.deepEqual({ sliver, scrolled }, { sliver: [], scrolled: [] });
  assert.deepEqual(together, [{ name: 'front_picture', props: { page: 'front', product: 'fixture', picture: 'near' } }]);
  assert.deepEqual(errors, []);
});

test('a picture still loading takes no pointer, beat or event until it draws; one that never draws stays still and tells nothing', { timeout: 120000 }, async () => {
  const held = await open({ path: '/?held', drawn: 2 });
  await held.page.mouse.move(...NEAR);
  await held.page.clock.runFor(3000);
  const before = { attributes: await attributes(held.page), events: await events(held.page) };
  await held.page.evaluate(() => window.release());
  await held.page.waitForFunction(() => document.querySelectorAll('.fx').length === 3, null, { timeout: 10000 });
  const drawn = (await logged(held.page)).filter(([index, , on]) => index === 0 && on).map(([, name]) => name);
  await held.page.clock.runFor(1000);
  const told = await events(held.page);
  await held.close();

  const failed = await open({ path: '/?failed', drawn: 2 });
  await failed.page.mouse.move(...NEAR);
  await failed.page.clock.runFor(3000);
  const empty = { attributes: await attributes(failed.page), events: await events(failed.page) };
  await failed.close();

  assert.deepEqual(before, { attributes: [], events: [] });
  assert.deepEqual(drawn, ['data-pointed', 'data-beat']);
  assert.deepEqual(told, [{ name: 'front_picture', props: { page: 'front', product: 'fixture', picture: 'near' } }]);
  assert.deepEqual(empty, { attributes: [], events: [] });
  assert.deepEqual([...held.errors, ...failed.errors], []);
});

test('on a phone a picture still loading plays nothing until it draws, then plays once it has held 400ms', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open({ device: PHONE, path: '/?phone&held', drawn: 2 });
  await seenAs(page, 0, true);
  await page.clock.runFor(400);
  await ended(page, 1);
  const beforeDrawing = beatsIn(await logged(page));
  await page.evaluate(() => window.release());
  await page.waitForFunction(() => document.querySelectorAll('.fx').length === 3, null, { timeout: 10000 });
  const drawnAt = (await logged(page)).length;
  await page.clock.runFor(399);
  const early = beatsIn((await logged(page)).slice(drawnAt));
  await page.clock.runFor(1);
  await ended(page, 2);
  const log = await logged(page);
  await close();
  assert.deepEqual(beforeDrawing, ['1+', '1-'], 'the loading picture played, or the far one did not');
  assert.deepEqual(early, []);
  assert.deepEqual(beatsIn(log.slice(drawnAt)), ['0+', '0-']);
  assert.deepEqual(errors, []);
});

test('a finger on a hover device points at nothing, and does not end a resting mouse\'s pointing', { timeout: 120000 }, async () => {
  const { page, errors, close, context } = await open();
  const cdp = await context.newCDPSession(page);
  const tap = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await page.mouse.move(...NEAR);
  await ended(page, 1);
  await tap(100, 300);
  const resting = { attributes: await attributes(page), loop: await loopOf(page, '.fx-loop') };
  await page.mouse.move(...OUTSIDE);
  await page.waitForFunction(() => !document.querySelector('.front-picture-body').hasAttribute('data-pointed'), null, { timeout: 10000 });
  await scrollToBody(page, 1, 100);
  await seenAs(page, 1, true);
  await tap(300, 250);
  await page.clock.runFor(3000);
  const tapped = { attributes: await attributes(page, 1), animations: await page.evaluate(() => document.querySelectorAll('.front-picture-body')[1].getAnimations({ subtree: true }).length), events: await events(page) };
  await close();
  assert.deepEqual(resting, { attributes: ['data-pointed'], loop: [{ iterations: Infinity, state: 'running' }] });
  assert.deepEqual(tapped, { attributes: [], animations: 0, events: [] });
  assert.deepEqual(errors, []);
});

test('a failure in the motion reports once for the route, naming the picture, and leaves every picture it touched still and silent', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  await page.evaluate(() => { Element.prototype.getAnimations = () => { throw new Error('motion failed'); }; });
  await page.mouse.move(...NEAR);
  const near = await attributes(page, 0);
  await page.mouse.move(...OUTSIDE);
  await page.mouse.move(...NEAR);
  await page.clock.runFor(2000);
  const nearAgain = { attributes: await attributes(page, 0), events: await events(page) };
  await scrollToBody(page, 1, 200);
  await seenAs(page, 1, true);
  await page.mouse.move(300, 300);
  const seen = { far: await attributes(page, 1), captured: await page.evaluate(() => window.captured) };
  await close();
  assert.deepEqual({ near, nearAgain }, { near: [], nearAgain: { attributes: [], events: [] } });
  assert.deepEqual(seen, { far: [], captured: [['render', 'front-picture-motion', '/', true, { product: 'fixture', picture: 'near' }]] });
  assert.deepEqual(errors, []);
});

test('on a phone two pictures seen together play their beats one after the other, and nothing is ever pointed at', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open({ device: PHONE, path: '/?phone' });
  assert.equal(await page.evaluate(() => matchMedia('(hover: none)').matches), true);
  await seenAs(page, 0, true);
  await seenAs(page, 1, true);
  await page.clock.runFor(400);
  await ended(page, 2);
  const log = await logged(page);
  await close();
  const beats = beatsIn(log);
  const first = beats[0][0];
  const second = first === '0' ? '1' : '0';
  assert.deepEqual(beats, [`${first}+`, `${first}-`, `${second}+`, `${second}-`]);
  assert.deepEqual([endingsIn(log, 0), endingsIn(log, 1)], ['+ finished -', '+ finished -']);
  assert.deepEqual(log.filter(([, name]) => name === 'data-pointed'), []);
  assert.deepEqual(errors, []);
});

test('on a phone a picture plays once it has stayed seen 400ms, once; a flick past plays nothing, nor does a second look', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open({ device: PHONE, path: '/?phone' });
  await page.clock.runFor(400);
  await ended(page, 2);
  // A flick: the tall picture over most of the view for 200ms.
  await scrollToBody(page, 2, 100);
  await seenAs(page, 2, true);
  await page.clock.runFor(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await seenAs(page, 2, false);
  await page.clock.runFor(2000);
  const flicked = beatsIn(await logged(page));
  await scrollToBody(page, 2, 100);
  await seenAs(page, 2, true);
  await page.clock.runFor(399);
  const early = beatsIn(await logged(page));
  await page.clock.runFor(1);
  await ended(page, 3);
  await page.evaluate(() => window.scrollTo(0, 0));
  await seenAs(page, 2, false);
  await scrollToBody(page, 2, 100);
  await seenAs(page, 2, true);
  await page.clock.runFor(2000);
  const log = await logged(page);
  await close();
  assert.equal(flicked.length, 4, 'the flicked picture played');
  assert.deepEqual(early, flicked);
  assert.deepEqual(beatsIn(log).slice(4), ['2+', '2-']);
  assert.deepEqual(errors, []);
});

test('on a phone a waiting picture no longer seen at its turn is dropped, and one back just before its turn waits a fresh 400ms', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open({ device: PHONE, path: '/?phone' });
  await seenAs(page, 0, true);
  await seenAs(page, 1, true);
  // Both fall due together: one plays its 1500ms beat and the other waits.
  await page.clock.runFor(400);
  const [first] = beatsIn(await logged(page));
  const playing = Number(first[0]);
  const waiting = 1 - playing;
  // The playing beat is held still while the waiting one leaves view and comes straight back: its hold starts over,
  // and the clock stands still.
  await page.evaluate((at) => window.beatOf[at].pause(), playing);
  await scrollToBody(page, 2, 100);
  await seenAs(page, waiting, false);
  await page.evaluate(() => window.scrollTo(0, 0));
  await seenAs(page, waiting, true);
  await page.evaluate((at) => window.beatOf[at].play(), playing);
  await ended(page, 1);
  const atTurn = beatsIn(await logged(page));
  await page.clock.runFor(399);
  const early = beatsIn(await logged(page));
  await page.clock.runFor(1);
  await ended(page, 2);
  const log = await logged(page);
  await close();
  assert.deepEqual(atTurn, [`${playing}+`, `${playing}-`], 'the waiting picture played without a fresh 400ms in view');
  assert.deepEqual(early, atTurn);
  assert.deepEqual(beatsIn(log), [`${playing}+`, `${playing}-`, `${waiting}+`, `${waiting}-`]);
  assert.deepEqual(errors, []);
});

test('on a phone a beat that never finishes lifts at its 10s ceiling, and the next picture plays', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open({ device: PHONE, path: '/?phone&stuck' });
  await seenAs(page, 0, true);
  await seenAs(page, 1, true);
  // Both fall due together; the first one's beat began as its hold ended, so its ceiling is 10000ms on.
  await page.clock.runFor(400);
  const [started] = beatsIn(await logged(page));
  const first = started[0];
  const second = first === '0' ? '1' : '0';
  await page.clock.runFor(9999);
  const before = beatsIn(await logged(page));
  await page.clock.runFor(1);
  await ended(page, 1);
  await page.waitForFunction((at) => window.log.some(([index, name]) => index === at && name === 'cancelled'), Number(first), { timeout: 10000 });
  const log = await logged(page);
  await close();
  assert.deepEqual(before, [`${first}+`], 'the stuck beat lifted early, or another played beside it');
  assert.deepEqual(beatsIn(log), [`${first}+`, `${first}-`, `${second}+`]);
  assert.equal(endingsIn(log, Number(first)), '+ - cancelled', 'the beat lifted because its animation ended, not at the ceiling');
  assert.deepEqual(errors, []);
});

test('on a phone a tap changes nothing and tells nothing', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open({ device: PHONE, path: '/?phone' });
  await page.clock.runFor(400);
  await ended(page, 2);
  const before = (await logged(page)).length;
  await page.touchscreen.tap(195, 200);
  await page.clock.runFor(2000);
  const after = await logged(page);
  const told = await events(page);
  await close();
  assert.deepEqual(after.slice(before), []);
  assert.deepEqual(told, []);
  assert.deepEqual(errors, []);
});
