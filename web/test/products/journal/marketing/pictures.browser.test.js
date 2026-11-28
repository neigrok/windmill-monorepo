// The journal's pictures under a real pointer on its landing: the echo's light kindles while a picture is pointed at
// and settles after, a caret blinks only while pointed and is solid the moment the pointer leaves, the search hit
// washes and a day dot grows its ring, and nothing moves at rest. On a phone the echo's light plays once as a beat.

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
const journal = PRODUCTS.find((product) => product.id === 'journal');
journal.landing.page().then((page) => createRoot(document.getElementById('root'))
  .render(React.createElement(ProductSessions, { dataScope: scope.read, products: [] }, React.createElement(ProductLanding, { product: journal, page }))));
`;

let server, browser, origin;
const ready = (async () => {
  const { output } = await build({ configFile: false, root, logLevel: 'silent', mode: 'development',
    plugins: [{ name: 'journal-picture-fixture', enforce: 'pre', resolveId(id) {
      if (id === '/journal-picture.js') return '\0entry';
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
      rollupOptions: { input: '/journal-picture.js', output: { entryFileNames: 'entry.js' } } } });
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
async function open({ reducedMotion = 'no-preference', device = { viewport: { width: 1440, height: 900 } } } = {}) {
  await ready;
  const page = await browser.newPage({ ...device, reducedMotion });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/journal`);
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
// Waits until every finite animation and transition on an element and inside it has run its course; a loop is left running.
const settled = (locator) => locator.evaluate((element) => Promise.all(element.getAnimations({ subtree: true })
  .filter((animation) => animation.effect.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
// The transition an element is running, as [property, duration, easing], once it has run its course.
const transitionOf = (locator) => locator.evaluate(async (element) => {
  const [transition] = element.getAnimations().filter((animation) => animation instanceof CSSTransition);
  if (!transition) return null;
  const timing = [transition.transitionProperty, transition.effect.getTiming().duration, transition.effect.getTiming().easing];
  await transition.finished.catch(() => {});
  return timing;
});
// An animation's look at a moment of it: the animation is held there, read, and let go.
const lookAt = (locator, time, read) => locator.evaluate((element, [at, property]) => {
  const [animation] = element.getAnimations().filter((each) => each instanceof CSSAnimation);
  animation.pause();
  animation.currentTime = at;
  const value = getComputedStyle(element)[property];
  animation.play();
  return { value, light: [animation.animationName, animation.effect.getTiming().duration] };
}, [time, read]);
// Waits for the page to draw twice, so what a scroll changed has reached the style.
const drawnTwice = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// What a colour computes to inside a picture, read off a probe that wears it.
const colourOf = (frame, value) => frame.evaluate((body, colour) => {
  const probe = body.querySelector('.front-picture-stage > *').appendChild(document.createElement('i'));
  probe.style.color = colour;
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}, value);
const LIT = 'color-mix(in srgb, var(--color-brand) 26%, transparent)';
// A colour as the pixel it paints, however the browser writes it: an animated colour reads back in oklab.
const painted = (page, colour) => page.evaluate((value) => {
  const context = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data];
}, colour);
const pointed = (frame) => frame.evaluate((body) => body.hasAttribute('data-pointed'));

test('at rest nothing moves in any picture on the journal\'s landing', { timeout: 120000 }, async () => {
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
  assert.deepEqual(seen, Array(5).fill({ animations: 0, attributes: [] }));
});

test('the seam between page and echo kindles over 1200ms while the picture is pointed at, and settles over 2400ms after', { timeout: 120000 }, async () => {
  const { page, errors } = await open();
  const frame = await frameOf(page, '.jnPicture');
  const seam = frame.locator('.jnPicture-rule');
  const looked = () => seam.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.transitionDuration, style.transitionTimingFunction];
  });
  const [rest] = await looked();
  const lit = await colourOf(frame, LIT);
  await page.mouse.move(...await centreOf(frame.locator('.jnPicture-page')));
  const rising = await transitionOf(seam);
  const kindled = await looked();
  await page.mouse.move(2, 2);
  const stillPointed = await pointed(frame);
  const falling = await transitionOf(seam);
  const after = await looked();
  await page.close();

  assert.deepEqual(errors, []);
  assert.notEqual(rest, lit);
  assert.deepEqual({ rising, kindled }, { rising: ['background-color', 1200, 'cubic-bezier(0.45, 0, 0.15, 1)'], kindled: [lit, '1.2s', 'cubic-bezier(0.45, 0, 0.15, 1)'] });
  assert.deepEqual({ stillPointed, falling, after }, { stillPointed: false, falling: ['background-color', 2400, 'linear'], after: [rest, '2.4s', 'linear'] });
});

test('tonight\'s caret blinks only while the picture is pointed at and is solid the moment the pointer leaves; the echo\'s edge kindles', { timeout: 120000 }, async () => {
  const { page, errors } = await open();
  const frame = await frameOf(page, '.jnWindow');
  const caret = frame.locator('.jnCursor');
  const caretSeen = () => caret.evaluate((element) => ({ opacity: getComputedStyle(element).opacity,
    blink: element.getAnimations().map((animation) => [animation.animationName, animation.effect.getTiming().iterations, animation.effect.getTiming().duration]) }));
  const rest = await caretSeen();
  await page.mouse.move(...await centreOf(frame.locator('.jnWindow-earlier')));
  await page.waitForFunction(() => document.querySelector('.front-picture-body:has(.jnWindow)').hasAttribute('data-pointed'), null, { timeout: 5000 });
  const blinking = await caretSeen();
  // The blink held at the middle of each half of two seconds: on, cut, on, cut.
  const phases = [];
  for (const time of [250, 750, 1250, 1750]) phases.push((await lookAt(caret, time, 'opacity')).value);
  await settled(frame.locator('.jnWindow-echo'));
  const edge = await frame.locator('.jnWindow-echo').evaluate((element) => getComputedStyle(element).borderTopColor);
  const lit = await colourOf(frame, LIT);
  await page.mouse.move(2, 2);
  const left = await caretSeen();
  await page.close();

  assert.deepEqual(errors, []);
  assert.deepEqual(rest, { opacity: '1', blink: [] });
  assert.deepEqual(blinking.blink, [['jn-caret-blink', Infinity, 1000]]);
  assert.deepEqual(phases, ['1', '0', '1', '0'], 'the caret did not blink cut, on and off');
  assert.equal(edge, lit, 'the echo\'s edge did not kindle');
  assert.deepEqual(left, { opacity: '1', blink: [] });
});

test('the search hit takes the room\'s wash, edge to edge, and the dimmed days take none', { timeout: 120000 }, async () => {
  const { page, errors } = await open();
  const frame = await frameOf(page, '.jnSearch');
  const hit = frame.locator('.jnSearch li.is-hit');
  const wash = await colourOf(frame, 'color-mix(in srgb, var(--color-brand) 8%, transparent)');
  const washOf = (row) => row.evaluate((element) => {
    const style = getComputedStyle(element, '::before');
    return [style.content, style.opacity, style.backgroundColor, style.inset, style.transitionDuration];
  });
  const rest = await washOf(hit);
  await page.mouse.move(...await centreOf(hit));
  await settled(hit);
  const hovered = await washOf(hit);
  const dim = frame.locator('.jnSearch li:not(.is-hit)').first();
  await page.mouse.move(...await centreOf(dim));
  await settled(frame);
  const dimWash = await dim.evaluate((element) => getComputedStyle(element, '::before').content);
  await page.close();

  assert.deepEqual(errors, []);
  assert.deepEqual(rest, ['""', '0', wash, '-6px -18px', '0.14s']);
  assert.deepEqual(hovered, ['""', '1', wash, '-6px -18px', '0.14s']);
  assert.equal(dimWash, 'none');
});

test('a page being written blinks its caret too, and a day dot grows 1.25 with its ring over its whole grid cell', { timeout: 120000 }, async () => {
  const { page, errors } = await open();
  const write = await frameOf(page, '.jnScene .jnScene-now');
  await page.mouse.move(...await centreOf(write.locator('.jnScene-past')));
  await page.waitForFunction(() => document.querySelector('.front-picture-body:has(.jnScene-now)').hasAttribute('data-pointed'), null, { timeout: 5000 });
  const writing = await write.locator('.jnCursor').evaluate((element) => element.getAnimations().map((animation) => animation.animationName));
  await page.mouse.move(2, 2);

  // A written day with a hollow one beside it and a written one above: each owns its cell to half the gap between them.
  const year = await frameOf(page, '.jnYear');
  const day = (row, column) => year.locator('.jnYear p').nth(row).locator('i').nth(column);
  const ring = await colourOf(year, 'color-mix(in srgb, var(--color-brand) 60%, transparent)');
  const [x, y] = await centreOf(day(1, 4));
  const [besideX] = await centreOf(day(1, 3));
  const [, aboveY] = await centreOf(day(0, 4));
  const hovered = () => year.evaluate((body) => [...body.querySelectorAll('.jnYear i')].filter((element) => element.matches(':hover'))
    .map((element) => ({ day: `${[...element.parentElement.parentElement.children].indexOf(element.parentElement)}:${[...element.parentElement.children].indexOf(element)}`,
      scale: getComputedStyle(element).scale, ring: getComputedStyle(element).boxShadow })));
  // Each point is reached from off the year, since a grown day answers over its grown cell as the room's zoom cell does,
  // and stands 3px inside a boundary: Chromium's hover lands a pixel apart from its hit test on an edge.
  const at = async (pointX, pointY) => {
    await page.mouse.move(2, 2);
    await settled(year);
    await page.mouse.move(pointX, pointY);
    await settled(year);
    return hovered();
  };
  const probes = {
    inside: await at((x + besideX) / 2 + 3, y), beside: await at((x + besideX) / 2 - 3, y),
    belowMiddle: await at(x, (y + aboveY) / 2 + 3), aboveMiddle: await at(x, (y + aboveY) / 2 - 3),
  };
  await page.close();

  assert.deepEqual(errors, []);
  assert.deepEqual(writing, ['jn-caret-blink']);
  const grown = (row, column) => [{ day: `${row}:${column + 1}`, scale: '1.25', ring: `${ring} 0px 0px 0px 2px` }];
  assert.deepEqual(probes, { inside: grown(1, 4), beside: grown(1, 3), belowMiddle: grown(1, 4), aboveMiddle: grown(0, 4) });
});

test('under reduced motion the caret stays solid, a day dot rings without growing, and the light and the wash keep their times', { timeout: 120000 }, async () => {
  const { page, errors } = await open({ reducedMotion: 'reduce' });
  const night = await frameOf(page, '.jnWindow');
  await page.mouse.move(...await centreOf(night.locator('.jnWindow-earlier')));
  await page.waitForFunction(() => document.querySelector('.front-picture-body:has(.jnWindow)').hasAttribute('data-pointed'), null, { timeout: 5000 });
  const caret = await night.locator('.jnCursor').evaluate((element) => ({ opacity: getComputedStyle(element).opacity, animations: element.getAnimations().length }));
  const echo = await night.locator('.jnWindow-echo').evaluate((element) => getComputedStyle(element).transitionDuration);
  await page.mouse.move(2, 2);
  const echoOut = await night.locator('.jnWindow-echo').evaluate((element) => getComputedStyle(element).transitionDuration);
  const seam = await (await frameOf(page, '.jnPicture')).locator('.jnPicture-rule').evaluate((element) => getComputedStyle(element).transitionDuration);
  const search = await frameOf(page, '.jnSearch');
  const hitWash = await search.locator('li.is-hit').evaluate((element) => getComputedStyle(element, '::before').transitionDuration);
  const year = await frameOf(page, '.jnYear');
  const dot = year.locator('.jnYear p').first().locator('i').first();
  await page.mouse.move(...await centreOf(dot));
  await settled(dot);
  const dotSeen = await dot.evaluate((element) => ({ scale: getComputedStyle(element).scale, ringed: getComputedStyle(element).boxShadow !== 'none', time: getComputedStyle(element).transitionDuration }));
  await page.close();

  assert.deepEqual(errors, []);
  assert.deepEqual({ caret, echo, echoOut, seam, hitWash, dotSeen }, {
    caret: { opacity: '1', animations: 0 }, echo: '1.2s', echoOut: '2.4s', seam: '2.4s', hitWash: '0.14s',
    dotSeen: { scale: 'none', ringed: true, time: '0.12s' },
  });
});

test('on a phone the echo\'s light plays once as each picture\'s beat and ends as drawn; with hover the beat lights nothing', { timeout: 120000 }, async () => {
  const { page, errors } = await open({ device: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } });
  const night = page.locator('.front-picture-body:has(.jnWindow)');
  const edge = night.locator('.jnWindow-echo');
  const lit = await colourOf(night, LIT);
  const edgeRest = await colourOf(night, 'var(--border-subtle)');
  const edgeOf = () => edge.evaluate((element) => ({ colour: getComputedStyle(element).borderTopColor,
    light: element.getAnimations().filter((animation) => animation instanceof CSSAnimation).map((animation) => [animation.animationName, animation.effect.getTiming().duration]) }));
  // Tonight's page stands in view as the landing opens, so it falls due first; its light is read held at 2400ms in.
  await page.waitForFunction(() => document.querySelector('.front-picture-body:has(.jnWindow)').hasAttribute('data-beat'), null, { timeout: 5000 });
  const edgeHeld = await lookAt(edge, 2400, 'borderTopColor');
  await page.waitForFunction(() => !document.querySelector('.front-picture-body:has(.jnWindow)').hasAttribute('data-beat'), null, { timeout: 10000 });
  const edgeAfter = await edgeOf();

  const root = await frameOf(page, '.jnPicture');
  const seam = root.locator('.jnPicture-rule');
  const seamOf = () => seam.evaluate((element) => ({ colour: getComputedStyle(element).backgroundColor,
    light: element.getAnimations().filter((animation) => animation instanceof CSSAnimation).map((animation) => [animation.animationName, animation.effect.getTiming().duration]) }));
  const seamRest = await colourOf(root, 'var(--border-subtle)');
  await page.waitForFunction(() => document.querySelector('.front-picture-body:has(.jnPicture)').hasAttribute('data-beat'), null, { timeout: 5000 });
  const seamHeld = await lookAt(seam, 2400, 'backgroundColor');
  await page.waitForFunction(() => !document.querySelector('.front-picture-body:has(.jnPicture)').hasAttribute('data-beat'), null, { timeout: 10000 });
  const seamAfter = await seamOf();
  const pointed = await page.evaluate(() => [...document.querySelectorAll('.front-picture-body')].some((body) => body.hasAttribute('data-pointed')));
  const pixels = { lit: await painted(page, lit), edgeHeld: await painted(page, edgeHeld.value), seamHeld: await painted(page, seamHeld.value) };
  await page.close();

  const desk = await open();
  const deskRoot = await frameOf(desk.page, '.jnPicture');
  const withHover = await deskRoot.evaluate((body) => {
    body.setAttribute('data-beat', '');
    const animations = body.querySelector('.jnPicture-rule').getAnimations().length + body.ownerDocument.querySelector('.jnWindow-echo').getAnimations().length;
    body.removeAttribute('data-beat');
    return animations;
  });
  await desk.page.close();

  assert.deepEqual([...errors, ...desk.errors], []);
  assert.deepEqual([edgeHeld.light, edgeAfter.light, seamHeld.light, seamAfter.light], [['jn-edge-light', 6000], [], ['jn-seam-light', 6000], []]);
  assert.deepEqual([pixels.edgeHeld, pixels.seamHeld], [pixels.lit, pixels.lit], 'the light did not hold at the lamp\'s 26%');
  assert.deepEqual([edgeAfter.colour, seamAfter.colour], [edgeRest, seamRest], 'the light did not end as drawn');
  assert.deepEqual({ pointed, withHover }, { pointed: false, withHover: 0 });
});
