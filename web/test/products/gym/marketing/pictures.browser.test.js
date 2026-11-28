// Gym's pictures under a real pointer on its landing: the unchanged lines' run and a movement's scheme warm, the
// remembered weight lifts once as the pointer arrives, the strength line rings its nearest vertex and holds it after,
// and nothing moves at rest.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';
import { beacon } from '../../roadmap/browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProductLanding } from '/src/shell/marketing/ProductLanding.jsx';
import { ProductSessions } from '/src/shell/ProductSessions.jsx';
import { DocumentDataScope } from '/src/shell/auth/accountChange.js';
import { PRODUCTS } from '/src/shell/products.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const scope = new DocumentDataScope();
scope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'anon' } } } });
const gym = PRODUCTS.find((product) => product.id === 'gym');
gym.landing.page().then((page) => createRoot(document.getElementById('root'))
  .render(React.createElement(ProductSessions, { dataScope: scope.read, products: [] }, React.createElement(ProductLanding, { product: gym, page }))));
`;

let server, browser, origin;
const ready = (async () => {
  const { output } = await build({ configFile: false, root, logLevel: 'silent', mode: 'development',
    plugins: [{ name: 'gym-picture-fixture', enforce: 'pre', resolveId(id) {
      if (id === '/gym-picture.js') return '\0entry';
      if (id.endsWith('/auth/AuthProvider.jsx')) return '\0auth';
      if (id.endsWith('/auth/SignInDoor.jsx')) return '\0door';
      if (id.endsWith('/telemetry/beacon.js')) return '\0events';
      if (id.endsWith('/telemetry/sentry.js')) return '\0sentry';
    }, load(id) {
      if (id === '\0entry') return entry;
      if (id === '\0auth') return 'export const useAuth = () => ({ status: "ghost", user: null, signOut() {} }); export default function AuthProvider({ children }) { return children; }';
      if (id === '\0door') return 'export const useSignInDoor = () => () => {}; export const useSignInDoorHost = () => () => {};';
      if (id === '\0events') return beacon;
      if (id === '\0sentry') return 'export function captureError(kind, operation, stack, route) { (window.captured ??= []).push([kind, operation, route]); }';
    } }], build: { write: false, minify: false, cssCodeSplit: false, modulePreload: false,
      rollupOptions: { input: '/gym-picture.js', output: { entryFileNames: 'entry.js' } } } });
  const files = new Map(output.map((file) => ['/' + file.fileName, file.type === 'chunk' ? file.code : file.source]));
  const css = [...files.keys()].find((name) => name.endsWith('.css'));
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.startsWith('/v1/') || path.endsWith('.svg')) { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/html');
    response.end(files.get(path) ?? `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${css}"><div id="root"></div><script type="module" src="/entry.js"></script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
ready.catch(() => {});
after(async () => { try { await ready; } finally { await browser?.close(); server?.close(); } });

// The landing with every picture drawn, the pointer parked off them all.
async function open({ reducedMotion = 'no-preference' } = {}) {
  await ready;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/gym`);
  await page.waitForFunction(() => {
    const stages = [...document.querySelectorAll('.front-picture-stage')];
    return stages.length > 0 && stages.every((stage) => stage.firstElementChild);
  }, null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(2, 2);
  return { page, errors };
}

// The frame a picture stands in, scrolled to the middle of the view.
async function frameOf(page, selector) {
  const frame = page.locator('.front-picture-body', { has: page.locator(selector) }).first();
  await frame.evaluate((body) => body.scrollIntoView({ block: 'center', behavior: 'instant' }));
  return frame;
}
const centreOf = (locator) => locator.evaluate((element) => {
  const box = element.getBoundingClientRect();
  return [box.left + box.width / 2, box.top + box.height / 2];
});
// Waits until every finite animation and transition on an element and inside it has run its course.
const settled = (locator) => locator.evaluate((element) => Promise.all(element.getAnimations({ subtree: true })
  .filter((animation) => animation.effect.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
// Waits for the page to draw twice, so what a scroll changed has reached the style.
const drawnTwice = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// Records, in the page, the animations a body runs the moment its beat begins.
const beatWatched = (frame) => frame.evaluate((body) => {
  window.atBeat = null;
  new MutationObserver(() => {
    if (!body.hasAttribute('data-beat') || window.atBeat) return;
    window.atBeat = body.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSAnimation)
      .map((animation) => [animation.animationName, animation.effect.getTiming().duration, animation.effect.getTiming().iterations]);
  }).observe(body, { attributes: true, attributeFilter: ['data-beat'] });
});
// What a colour computes to inside a picture, read off a probe that wears it.
const colourOf = (frame, value) => frame.evaluate((body, colour) => {
  const probe = body.querySelector('.front-picture-stage > *').appendChild(document.createElement('i'));
  probe.style.color = colour;
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}, value);
const pointed = (frame) => frame.evaluate((body) => body.hasAttribute('data-pointed'));

test('at rest nothing moves in any picture on Gym\'s landing', { timeout: 120000 }, async () => {
  const { page, errors } = await open();
  const bodies = page.locator('.front-picture-body');
  const seen = [];
  for (let index = 0; index < await bodies.count(); index += 1) {
    await bodies.nth(index).evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await drawnTwice(page);
    seen.push(await bodies.nth(index).evaluate((element) => ({ animations: element.getAnimations({ subtree: true }).length,
      attributes: ['data-pointed', 'data-beat'].filter((name) => element.hasAttribute(name)) })));
  }
  await page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(seen, Array(6).fill({ animations: 0, attributes: [] }));
});

test('the unchanged lines\' run warms to the room\'s dim ink under the pointer, and a movement\'s scheme to the link', { timeout: 120000 }, async () => {
  const { page, errors } = await open();
  const coach = await frameOf(page, '.gyPicture');
  const unfold = coach.locator('.gyPicture-unfold');
  const inkOf = (locator) => locator.evaluate((element) => [getComputedStyle(element).color, getComputedStyle(element).transitionDuration]);
  const [faint, dim] = [await colourOf(coach, 'var(--gym-ink-faint)'), await colourOf(coach, 'var(--gym-ink-dim)')];
  const unfoldRest = await inkOf(unfold);
  await page.mouse.move(...await centreOf(unfold));
  await settled(unfold);
  const unfoldHovered = await inkOf(unfold);
  const kept = await coach.locator('.gyPicture-kept:not(.gyPicture-unfold)').evaluate((element) => getComputedStyle(element).color);

  const routine = await frameOf(page, '.gyRoutine');
  const row = routine.locator('.gyRoutine li').nth(1);
  const [ink, link] = [await colourOf(routine, 'var(--gym-ink)'), await colourOf(routine, 'var(--text-link)')];
  const schemeRest = await inkOf(row.locator('.gyRoutine-scheme'));
  await page.mouse.move(...await centreOf(row.locator('.gyRoutine-movement')));
  await settled(row);
  const schemeHovered = await inkOf(row.locator('.gyRoutine-scheme'));
  const others = await routine.locator('.gyRoutine li:not(:nth-child(2)) .gyRoutine-scheme').evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color));
  await page.close();

  assert.deepEqual(errors, []);
  assert.deepEqual({ unfoldRest, unfoldHovered, kept }, { unfoldRest: [faint, '0.15s'], unfoldHovered: [dim, '0.15s'], kept: faint });
  assert.deepEqual({ schemeRest, schemeHovered, others }, { schemeRest: [ink, '0.15s'], schemeHovered: [link, '0.15s'], others: [ink, ink] });
});

test('the remembered weight lifts to the link\'s ink once as the pointer arrives, and the beat ends as drawn', { timeout: 120000 }, async () => {
  const { page, errors } = await open();
  const frame = await frameOf(page, '.gyRemembered');
  const weight = frame.locator('.gyRemembered-weight');
  const rest = await weight.evaluate((element) => getComputedStyle(element).color);
  await beatWatched(frame);
  await page.mouse.move(...await centreOf(frame.locator('.gyRemembered-head')));
  await page.waitForFunction(() => window.atBeat && !document.querySelector('.front-picture-body:has(.gyRemembered)').hasAttribute('data-beat'), null, { timeout: 10000 });
  const lift = await page.evaluate(() => window.atBeat);
  const after = await weight.evaluate((element) => ({ color: getComputedStyle(element).color, animations: element.getAnimations().length }));
  await page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual({ lift, after }, { lift: [['gy-ink-lift', 280, 1]], after: { color: rest, animations: 0 } });
});

test('the strength line rings the vertex nearest the pointer by x, one at a time, and holds the last 1500ms after the pointer leaves', { timeout: 120000 }, async () => {
  const { page, errors } = await open();
  const frame = await frameOf(page, '.gyLine');
  // A point of the plot, in the plot's own 240 × 90 units, where the page draws it.
  const onPlot = (x, y) => frame.locator('.gyLine svg').evaluate((svg, [px, py]) => {
    const point = new DOMPoint(px, py).matrixTransform(svg.getScreenCTM());
    return [point.x, point.y];
  }, [x, y]);
  const shown = () => frame.evaluate((body) => ({
    plot: Number(getComputedStyle(body.querySelector('.gyLine-plot')).opacity),
    rings: [...body.querySelectorAll('.gyLine-ring')].map((ring, index) => [index, Number(getComputedStyle(ring).opacity)]).filter(([, opacity]) => opacity > 0).map(([index]) => index),
  }));
  const rest = await shown();
  // The slot of the vertex at 28 (index 1) ends at 38, halfway to 48 (index 2); 101 is nearer 108 (index 5) than 88.
  await page.mouse.move(...await onPlot(37, 20));
  await settled(frame.locator('.gyLine-plot'));
  const first = await shown();
  // A ring that loses the pointer goes at once, and the next shows at once: read with no wait.
  await page.mouse.move(...await onPlot(39, 20));
  const across = await shown();
  await page.mouse.move(...await onPlot(101, 85));
  const stepped = await shown();
  await page.mouse.move(...await onPlot(239, 60));
  const last = await shown();
  await page.mouse.move(2, 2);
  // The plot's fade and the last ring's going, each held at moments of its own timeline, then let go.
  const leaving = await frame.evaluate((body) => {
    const transitionOf = (element) => element.getAnimations().find((animation) => animation instanceof CSSTransition);
    const plot = transitionOf(body.querySelector('.gyLine-plot'));
    const ring = transitionOf(body.querySelectorAll('.gyLine-ring')[11]);
    const at = (transition, time, element) => { transition.pause(); transition.currentTime = time; const opacity = Number(getComputedStyle(element).opacity); transition.play(); return opacity; };
    return {
      plot: [plot.effect.getTiming().delay, plot.effect.getTiming().duration, at(plot, 1499, body.querySelector('.gyLine-plot')), at(plot, 1650, body.querySelector('.gyLine-plot'))],
      ring: [ring.effect.getTiming().delay, ring.effect.getTiming().duration, at(ring, 1649, body.querySelectorAll('.gyLine-ring')[11])],
    };
  });
  await settled(frame);
  const gone = await shown();
  await page.close();

  assert.deepEqual(errors, []);
  assert.deepEqual({ rest, first, across, stepped, last, leaving, gone }, {
    rest: { plot: 0, rings: [] }, first: { plot: 1, rings: [1] }, across: { plot: 1, rings: [2] }, stepped: { plot: 1, rings: [5] }, last: { plot: 1, rings: [11] },
    leaving: { plot: [1500, 150, 1, 0], ring: [1650, 0, 1] }, gone: { plot: 0, rings: [] },
  });
});

test('under reduced motion the colours, the ring\'s fade and the ink lift keep their times', { timeout: 120000 }, async () => {
  const { page, errors } = await open({ reducedMotion: 'reduce' });
  const coach = await frameOf(page, '.gyPicture');
  const unfold = await coach.locator('.gyPicture-unfold').evaluate((element) => getComputedStyle(element).transitionDuration);
  const line = await frameOf(page, '.gyLine');
  const plot = await line.locator('.gyLine-plot').evaluate((element) => [getComputedStyle(element).transitionDuration, getComputedStyle(element).transitionDelay]);
  const routine = await frameOf(page, '.gyRoutine');
  const scheme = await routine.locator('.gyRoutine-scheme').first().evaluate((element) => getComputedStyle(element).transitionDuration);
  const remembered = await frameOf(page, '.gyRemembered');
  await beatWatched(remembered);
  await page.mouse.move(...await centreOf(remembered.locator('.gyRemembered-head')));
  await page.waitForFunction(() => window.atBeat, null, { timeout: 10000 });
  const lift = (await page.evaluate(() => window.atBeat)).map(([name]) => name);
  await page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual({ unfold, plot, scheme, lift }, { unfold: '0.15s', plot: ['0.15s', '1.5s'], scheme: '0.15s', lift: ['gy-ink-lift'] });
});
