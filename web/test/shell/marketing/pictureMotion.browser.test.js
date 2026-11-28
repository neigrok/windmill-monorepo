// The picture frame under a real pointer and on a phone: a fixture picture whose sheet starts a beat under `data-beat`,
// an endless loop under `data-pointed` and a second loop on an element marked `data-cut`, drawn in three frames on one
// route: one in view, one far down the page and one taller than the view. On `?phone` the frames stand 40px apart, so
// the first two are seen together at 390, and every beat runs 1500ms.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';
import { beacon } from '../../products/roadmap/browserFixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PictureFrame } from '/src/shell/marketing/SiteChrome.jsx';
import '/src/styles/global.css';
const phone = new URLSearchParams(location.search).has('phone');
const sheet = document.createElement('style');
sheet.textContent = \`
  .fx { height: 100%; }
  .fx i { display: block; width: 20px; height: 20px; }
  [data-beat] .fx-beat { animation: fx-fade 400ms linear; }
  [data-pointed] .fx-loop, [data-pointed] .fx-cut { animation: fx-fade 800ms linear infinite; }
  @keyframes fx-fade { 50% { opacity: .5; } }
\` + (phone ? '[data-beat] .fx-beat { animation-duration: 1500ms; }' : '');
document.head.append(sheet);
const e = React.createElement;
const fixture = (name) => () => e('div', { className: 'fx', 'data-fx': name }, e('i', { className: 'fx-beat' }), e('i', { className: 'fx-loop' }), e('i', { className: 'fx-cut', 'data-cut': '' }));
const frame = (name, height) => e(PictureFrame, { id: 'fixture', page: 'front', route: '/', theme: 'light',
  picture: { name, label: 'Composed', stages: [{ name: 'only', width: 400, height }], Picture: fixture(name) } });
const gap = () => e('div', { style: { height: phone ? 40 : 1200 } });
createRoot(document.getElementById('root')).render(e('div', { style: { width: 600, maxWidth: '100%' } },
  frame('near', 300), gap(), frame('far', 300), gap(), frame('tall', 1500), e('div', { style: { height: 1200 } })));
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
      if (id === '\0sentry') return 'export function captureError(kind, operation, stack, route) { (window.captured ??= []).push([kind, operation, route, stack.length > 0]); }';
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

// A page with the three frames drawn, and in it `window.log`: every change of the two attributes on each body, timed.
async function open(options = {}, path = '/') {
  await ready;
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + path);
  await page.waitForFunction(() => document.querySelectorAll('.fx').length === 3, null, { timeout: 30000 });
  await page.evaluate(() => {
    window.log = [];
    document.querySelectorAll('.front-picture-body').forEach((body, index) => {
      new MutationObserver((records) => records.forEach((record) => window.log.push([performance.now(), index, record.attributeName, body.hasAttribute(record.attributeName)])))
        .observe(body, { attributes: true, attributeFilter: ['data-pointed', 'data-beat'] });
      body.addEventListener('pointerleave', () => window.log.push([performance.now(), index, 'left', true]));
      body.addEventListener('pointerenter', () => window.log.push([performance.now(), index, 'entered', true]));
    });
  });
  await page.mouse.move(700, 10);
  return { page, errors, close: () => context.close() };
}

const NEAR = [300, 250];
const OUTSIDE = [700, 10];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const attributes = (page, index = 0) => page.evaluate((at) => {
  const body = document.querySelectorAll('.front-picture-body')[at];
  return ['data-pointed', 'data-beat'].filter((name) => body.hasAttribute(name));
}, index);
const logged = (page) => page.evaluate(() => window.log);
const sinceLeft = (log, index, attribute) => {
  const left = log.findLast(([, at, name]) => at === index && name === 'left')[0];
  return log.find(([time, at, name, on]) => at === index && name === attribute && !on && time >= left)[0] - left;
};
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

test('arrival sets data-pointed and data-beat, and data-beat goes once the beat has finished', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  assert.deepEqual(await attributes(page), []);
  await page.mouse.move(...NEAR);
  await page.waitForFunction(() => document.querySelector('.front-picture-body').hasAttribute('data-beat'), null, { timeout: 5000 });
  assert.deepEqual(await attributes(page), ['data-pointed', 'data-beat']);
  await page.waitForFunction(() => !document.querySelector('.front-picture-body').hasAttribute('data-beat'), null, { timeout: 5000 });
  const log = await logged(page);
  await close();
  const beat = log.filter(([, at, name]) => at === 0 && name === 'data-beat').map(([time]) => time);
  assert.equal(beat.length, 2);
  assert.ok(beat[1] - beat[0] >= 380 && beat[1] - beat[0] < 900, `the beat ran ${beat[1] - beat[0]}ms of its 400ms`);
  assert.deepEqual(log.filter(([, at, name]) => at === 0 && name === 'data-pointed').map(([, , , on]) => on), [true]);
  assert.deepEqual(errors, []);
});

test('entering again while the beat runs changes nothing, and the beat plays again only after 2400ms out', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  await page.mouse.move(...NEAR);
  await wait(120);
  const first = await page.evaluate(() => document.querySelector('.fx-beat').getAnimations()[0].startTime);
  await page.mouse.move(...OUTSIDE);
  await wait(80);
  await page.mouse.move(...NEAR);
  const again = await page.evaluate(() => document.querySelector('.fx-beat').getAnimations().map((animation) => animation.startTime));
  assert.deepEqual(again, [first], 'the beat started over');
  await page.waitForFunction(() => !document.querySelector('.front-picture-body').hasAttribute('data-beat'), null, { timeout: 5000 });

  await page.mouse.move(...OUTSIDE);
  await wait(1200);
  await page.mouse.move(...NEAR);
  await wait(100);
  assert.deepEqual(await attributes(page), ['data-pointed'], 'the beat played after 1200ms out');
  await page.mouse.move(...OUTSIDE);
  await wait(2700);
  await page.mouse.move(...NEAR);
  await page.waitForFunction(() => document.querySelector('.front-picture-body').hasAttribute('data-beat'), null, { timeout: 5000 });
  await close();
  assert.deepEqual(errors, []);
});

test('leaving lets an endless loop finish its cycle before data-pointed goes, and a cut loop stops at once', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  await page.mouse.move(...NEAR);
  await wait(1000);
  const into = await page.evaluate(() => document.querySelector('.fx-loop').getAnimations()[0].currentTime % 800);
  await page.mouse.move(...OUTSIDE);
  await wait(50);
  assert.deepEqual(await attributes(page), ['data-pointed']);
  assert.deepEqual(await loopOf(page, '.fx-loop'), [{ iterations: 2, state: 'running' }]);
  assert.deepEqual(await loopOf(page, '.fx-cut'), []);
  await page.waitForFunction(() => !document.querySelector('.front-picture-body').hasAttribute('data-pointed'), null, { timeout: 5000 });
  const log = await logged(page);
  await close();
  const held = sinceLeft(log, 0, 'data-pointed');
  assert.ok(Math.abs(held - (800 - into)) < 150, `data-pointed went ${held}ms after leaving, ${800 - into}ms before the cycle's end`);
  assert.deepEqual(errors, []);
});

test('a pointer back before the cycle ends keeps both loops endless', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  await page.mouse.move(...NEAR);
  await wait(500);
  await page.mouse.move(...OUTSIDE);
  await wait(100);
  await page.mouse.move(...NEAR);
  await wait(1200);
  assert.deepEqual(await attributes(page), ['data-pointed']);
  assert.deepEqual(await loopOf(page, '.fx-loop'), [{ iterations: Infinity, state: 'running' }]);
  assert.deepEqual(await loopOf(page, '.fx-cut'), [{ iterations: Infinity, state: 'running' }]);
  await close();
  assert.deepEqual(errors, []);
});

test('a picture arrives only once it is seen: 60% of it in view, or 60% of the view\'s height under it', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  const top = (index) => page.evaluate((at) => document.querySelectorAll('.front-picture-body')[at].getBoundingClientRect().top + window.scrollY, index);

  // The far picture, 300px tall, with 90px of it in view: the pointer on it points at nothing.
  await page.evaluate((y) => window.scrollTo(0, y - 510), await top(1));
  await page.mouse.move(300, 560);
  await wait(400);
  assert.deepEqual(await attributes(page, 1), []);
  // The page scrolls under the pointer until 210px of it is in view: it arrives, beat and all.
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => document.querySelectorAll('.front-picture-body')[1].hasAttribute('data-beat'), null, { timeout: 5000 });

  // The tall picture, 1500px, never 60% in view: it arrives once it covers 400px of the 600px view.
  await page.mouse.move(...OUTSIDE);
  await page.evaluate((y) => window.scrollTo(0, y - 400), await top(2));
  await page.mouse.move(300, 500);
  await wait(400);
  assert.deepEqual(await attributes(page, 2), []);
  await page.evaluate((y) => window.scrollTo(0, y - 200), await top(2));
  await page.mouse.move(300, 501);
  await page.waitForFunction(() => document.querySelectorAll('.front-picture-body')[2].hasAttribute('data-pointed'), null, { timeout: 5000 });
  await close();
  assert.deepEqual(errors, []);
});

test('front_picture is told once, after the pointer has stayed 1000ms, and never for a pass across', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  await page.mouse.move(...NEAR);
  await wait(600);
  await page.mouse.move(...OUTSIDE);
  await wait(800);
  assert.deepEqual(await page.evaluate(() => window.events ?? []), []);
  await page.mouse.move(...NEAR);
  await wait(1200);
  await page.mouse.move(...OUTSIDE);
  await page.mouse.move(...NEAR);
  await wait(1200);
  const events = await page.evaluate(() => window.events ?? []);
  await close();
  assert.deepEqual(events, [{ name: 'front_picture', props: { page: 'front', product: 'fixture', picture: 'near' } }]);
  assert.deepEqual(errors, []);
});

test('a failure in the motion reports once for the route and leaves every picture it touched still', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open();
  await page.evaluate(() => { Element.prototype.getAnimations = () => { throw new Error('motion failed'); }; });
  await page.mouse.move(...NEAR);
  await wait(300);
  const near = await attributes(page, 0);
  await page.mouse.move(...OUTSIDE);
  await page.mouse.move(...NEAR);
  await wait(300);
  await page.evaluate((y) => window.scrollTo(0, y - 200), await page.evaluate(() => document.querySelectorAll('.front-picture-body')[1].getBoundingClientRect().top + window.scrollY));
  await page.mouse.move(300, 300);
  await wait(300);
  const seen = { near, far: await attributes(page, 1), captured: await page.evaluate(() => window.captured) };
  await close();
  assert.deepEqual(seen, { near: [], far: [], captured: [['render', 'front-picture-motion', '/', true]] });
  assert.deepEqual(errors, []);
});

// A phone: touch, no hover, 390 wide.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
// Each beat on each body as [body, from, to], in the order they began, from the page's log.
const beatsIn = (log) => {
  const beats = [];
  for (const [time, index, name, on] of log) {
    if (name !== 'data-beat') continue;
    if (on) beats.push([index, time, null]);
    else beats.findLast(([at, , to]) => at === index && to === null)[2] = time;
  }
  return beats;
};
const scrollToBody = (page, index, offset) => page.evaluate(([at, by]) => {
  const top = document.querySelectorAll('.front-picture-body')[at].getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, top - by);
  return performance.now();
}, [index, offset]);
// Waits until `count` beats have ended on the page.
const ended = (page, count) => page.waitForFunction((least) => window.log.filter(([, , name, on]) => name === 'data-beat' && !on).length >= least,
  count, { timeout: 10000 });
const changes = (log) => log.filter(([, , name]) => name === 'data-beat' || name === 'data-pointed');

test('on a phone two pictures seen together play their beats one after the other, and nothing is ever pointed at', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open(PHONE, '/?phone');
  assert.equal(await page.evaluate(() => matchMedia('(hover: none)').matches), true);
  await ended(page, 2);
  await wait(300);
  const log = await logged(page);
  await close();
  const beats = beatsIn(log);
  assert.deepEqual(beats.map(([index]) => index).sort(), [0, 1]);
  const [[, firstFrom, firstTo], [, secondFrom, secondTo]] = beats;
  for (const ran of [firstTo - firstFrom, secondTo - secondFrom]) assert.ok(ran >= 1450 && ran < 2100, `a beat ran ${ran}ms of its 1500ms`);
  assert.ok(secondFrom >= firstTo && secondFrom - firstTo < 150, `the second beat began ${secondFrom - firstTo}ms after the first ended`);
  assert.deepEqual(log.filter(([, , name]) => name === 'data-pointed'), []);
  assert.deepEqual(errors, []);
});

test('on a phone a picture plays once after 400ms seen; a flick past plays nothing, nor does a second look', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open(PHONE, '/?phone');
  await ended(page, 2);
  // A flick: the tall picture over most of the view for 200ms.
  await scrollToBody(page, 2, 100);
  await wait(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(700);
  const flicked = beatsIn(await logged(page)).filter(([index]) => index === 2);
  const shownAt = await scrollToBody(page, 2, 100);
  await ended(page, 3);
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(300);
  await scrollToBody(page, 2, 100);
  await wait(900);
  const log = await logged(page);
  await close();
  const tall = beatsIn(log).filter(([index]) => index === 2);
  assert.deepEqual(flicked, []);
  assert.equal(tall.length, 1, 'the tall picture played again');
  const [[, from, to]] = tall;
  assert.ok(from - shownAt >= 400 && from - shownAt < 900, `the beat began ${from - shownAt}ms after the picture came into view`);
  assert.ok(to - from >= 1450 && to - from < 2100, `the beat ran ${to - from}ms of its 1500ms`);
  assert.deepEqual(beatsIn(log).map(([index]) => index).sort(), [0, 1, 2]);
  assert.deepEqual(errors, []);
});

test('on a phone a picture that left view before its turn is dropped, and plays when it is seen again', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open(PHONE, '/?phone');
  // Both have fallen due by now: one plays its 1500ms and the other waits.
  await wait(800);
  const [first] = beatsIn(await logged(page)).map(([index]) => index);
  // Both leave view; the tall one comes in, falls due and waits behind the one playing.
  await scrollToBody(page, 2, 100);
  await ended(page, 2);
  const beforeReturn = beatsIn(await logged(page)).map(([index]) => index);
  const backAt = await page.evaluate(() => { window.scrollTo(0, 0); return performance.now(); });
  await ended(page, 3);
  const log = await logged(page);
  await close();
  const beats = beatsIn(log);
  const dropped = 1 - first;
  assert.deepEqual(beforeReturn, [first, 2], 'the waiting picture played out of view, or the tall one did not play in its place');
  assert.deepEqual(beats.map(([index]) => index), [first, 2, dropped]);
  assert.ok(beats[2][1] - backAt >= 400, 'the dropped picture played before it had been seen again for 400ms');
  beats.slice(1).forEach(([, from], index) => assert.ok(from >= beats[index][2], 'two beats overlapped'));
  assert.deepEqual(errors, []);
});

test('on a phone a tap changes nothing and tells nothing', { timeout: 120000 }, async () => {
  const { page, errors, close } = await open(PHONE, '/?phone');
  await ended(page, 2);
  const before = changes(await logged(page)).length;
  await page.touchscreen.tap(195, 200);
  await wait(1300);
  const after = changes(await logged(page));
  const events = await page.evaluate(() => window.events ?? []);
  await close();
  assert.deepEqual(after.slice(before), []);
  assert.deepEqual(events, []);
  assert.deepEqual(errors, []);
});
