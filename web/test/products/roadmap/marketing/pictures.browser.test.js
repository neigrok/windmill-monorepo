// Roadmap's pictures under a real pointer, on the brand root and on Roadmap's landing: a step and a branch answer it
// with the room's feedback, a path card's crown breathes while the card stays put, a subtask washes, the pictures rest still until
// the pointer arrives, and each beat ends with the picture as drawn. The room's own shelf still breathes.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';
import { beacon } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrandLanding } from '/src/shell/marketing/BrandLanding.jsx';
import { ProductLanding } from '/src/shell/marketing/ProductLanding.jsx';
import { ProductSessions } from '/src/shell/ProductSessions.jsx';
import { DocumentDataScope } from '/src/shell/auth/accountChange.js';
import { PRODUCTS } from '/src/shell/products.js';
import { QuestShelf } from '/src/products/roadmap/quests/QuestShelf.jsx';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const scope = new DocumentDataScope();
scope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'anon' } } } });
const mount = (page) => createRoot(document.getElementById('root')).render(React.createElement(ProductSessions, { dataScope: scope.read, products: [] }, page));
const roadmap = PRODUCTS.find((product) => product.id === 'roadmap');
if (location.pathname === '/roadmap') roadmap.landing.page().then((page) => mount(React.createElement(ProductLanding, { product: roadmap, page })));
else if (location.pathname === '/shelf') mount(React.createElement(QuestShelf));
else mount(React.createElement(BrandLanding));
`;

let server, browser, origin;
const ready = (async () => {
  const { output } = await build({ configFile: false, root, logLevel: 'silent', mode: 'development',
    plugins: [{ name: 'tree-picture-fixture', enforce: 'pre', resolveId(id) {
      if (id === '/tree-picture.js') return '\0entry';
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
      rollupOptions: { input: '/tree-picture.js', output: { entryFileNames: 'entry.js' } } } });
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

// A page with every picture drawn, the path cards' thumbnails too, the pointer parked off them all.
async function open(path, { reducedMotion = 'no-preference', colorScheme = 'light' } = {}) {
  await ready;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion, colorScheme });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + path);
  await page.waitForFunction(() => {
    const stages = [...document.querySelectorAll('.front-picture-stage')];
    return stages.length > 0 && stages.every((stage) => stage.firstElementChild)
      && [...document.querySelectorAll('.rmPaths-thumb')].every((thumb) => thumb.querySelector('.quest-thumb-halo'));
  }, null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(2, 2);
  return { page, errors };
}

// The frame a picture stands in, scrolled to the middle of the view.
async function frameOf(page, selector) {
  const frame = page.locator('.front-picture-body', { has: page.locator(selector) });
  await frame.evaluate((body) => body.scrollIntoView({ block: 'center', behavior: 'instant' }));
  return frame;
}

const centreOf = (locator) => locator.evaluate((element) => {
  const box = element.getBoundingClientRect();
  return [box.left + box.width / 2, box.top + box.height / 2];
});
// A step is drawn just before its name.
const stepNamed = (frame, name) => frame.locator('.ndlabel').filter({ hasText: new RegExp(`^${name}$`) }).locator('xpath=preceding-sibling::div[1]');
// Waits until every finite animation and transition on an element and inside it has run its course; a loop is left running.
const settled = (locator) => locator.evaluate((element) => Promise.all(element.getAnimations({ subtree: true })
  .filter((animation) => animation.effect.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
// Waits for the page to draw twice, so what a scroll or a press changed has reached the style.
const drawnTwice = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const running = (body) => body.evaluate((element) => element.getAnimations({ subtree: true })
  .filter((animation) => animation instanceof CSSAnimation).map((animation) => animation.animationName));

test('at rest nothing moves in any picture on the brand root or Roadmap\'s landing', { timeout: 120000 }, async () => {
  for (const path of ['/', '/roadmap']) {
    const { page, errors } = await open(path);
    const bodies = page.locator('.front-picture-body');
    const seen = [];
    for (let index = 0; index < await bodies.count(); index += 1) {
      const body = bodies.nth(index);
      await body.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await drawnTwice(page);
      seen.push(await body.evaluate((element) => ({ animations: element.getAnimations({ subtree: true }).length,
        attributes: ['data-pointed', 'data-beat'].filter((name) => element.hasAttribute(name)) })));
    }
    await page.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(seen, seen.map(() => ({ animations: 0, attributes: [] })), path);
  }
});

test('a step under the pointer grows 1.06 and brightens 1.12 about its own centre, and a dormant branch takes the lit hue', { timeout: 120000 }, async () => {
  const { page, errors } = await open('/');
  const frame = await frameOf(page, '.rmPicture');
  const docking = stepNamed(frame, 'Docking');
  const [x, y] = await centreOf(docking);
  await page.mouse.move(x, y + 21);
  await settled(docking);
  const hovered = await docking.evaluate((step) => ({ hover: step.matches(':hover'), scale: getComputedStyle(step).scale, filter: getComputedStyle(step).filter }));
  const centre = await centreOf(docking);

  const branch = frame.locator('.rmTree-branch').filter({ has: page.locator('.rmTree-edge:not(.is-lit)') }).first();
  const lit = frame.locator('.rmTree-branch').filter({ has: page.locator('.rmTree-edge.is-lit') }).first();
  const midpoint = (locator) => locator.evaluate((group) => {
    const path = group.querySelector('.rmTree-edge');
    const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM());
    return [point.x, point.y + 8];
  });
  const stroke = (locator) => locator.evaluate((group) => {
    const edge = getComputedStyle(group.querySelector('.rmTree-edge'));
    return [edge.stroke, edge.strokeOpacity, edge.strokeWidth];
  });
  const litHue = await frame.evaluate((body) => {
    const probe = body.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
    probe.style.stroke = 'var(--connector-active)';
    const hue = getComputedStyle(probe).stroke;
    probe.remove();
    return hue;
  });
  const litAtRest = await stroke(lit);
  await page.mouse.move(...await midpoint(branch));
  await settled(branch);
  const dormantHovered = await stroke(branch);
  await page.mouse.move(...await midpoint(lit));
  await settled(frame.locator('.rmTree'));
  const litHovered = await stroke(lit);
  await page.close();

  assert.deepEqual(errors, []);
  assert.deepEqual(hovered, { hover: true, scale: '1.06', filter: 'brightness(1.12)' });
  assert.ok(Math.hypot(centre[0] - x, centre[1] - y) < 0.5, `the step moved its centre from ${x},${y} to ${centre}`);
  assert.deepEqual(dormantHovered, [litHue, '0.95', '1.5px']);
  assert.deepEqual(litHovered, litAtRest);
});

test('under reduced motion a step under the pointer brightens over 280ms and does not grow', { timeout: 120000 }, async () => {
  const { page, errors } = await open('/', { reducedMotion: 'reduce' });
  const frame = await frameOf(page, '.rmPicture');
  const docking = stepNamed(frame, 'Docking');
  await page.mouse.move(...await centreOf(docking));
  await settled(docking);
  const seen = await docking.evaluate((step) => {
    const style = getComputedStyle(step);
    return { scale: style.scale, filter: style.filter, transition: [style.transitionProperty, style.transitionDuration] };
  });
  await page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(seen, { scale: 'none', filter: 'brightness(1.12)', transition: ['scale, filter', '0.28s'] });
});

test('arrival pulses the seven open steps on one phase while the crown breathes, and the beat ends by itself', { timeout: 120000 }, async () => {
  const { page, errors } = await open('/');
  const frame = await frameOf(page, '.rmPicture');
  await page.mouse.move(...await centreOf(frame.locator('.rmPicture-arrow')));
  await page.waitForFunction(() => document.querySelector('.front-picture-body:has(.rmPicture)').hasAttribute('data-beat'), null, { timeout: 5000 });
  const beat = await frame.evaluate(async (body) => {
    const animations = body.getAnimations({ subtree: true });
    await Promise.all(animations.map((animation) => animation.ready));
    return animations.map((animation) => ({
      name: animation.animationName, open: animation.effect.target.classList.contains('nd-avail'),
      crowned: animation.effect.target.classList.contains('is-crowned'), iterations: animation.effect.getTiming().iterations, start: animation.startTime,
    }));
  });
  await page.waitForFunction(() => !document.querySelector('.front-picture-body:has(.rmPicture)').hasAttribute('data-beat'), null, { timeout: 6000 });
  const afterBeat = await running(frame);
  await page.mouse.move(2, 2);
  await page.waitForFunction(() => !document.querySelector('.front-picture-body:has(.rmPicture)').hasAttribute('data-pointed'), null, { timeout: 6000 });
  const left = await running(frame);
  await page.close();

  assert.deepEqual(errors, []);
  const pulses = beat.filter(({ name }) => name === 'wm-pulse-frontier');
  assert.deepEqual(pulses.map(({ open, iterations }) => [open, iterations]), Array(7).fill([true, 1]));
  assert.equal(new Set(pulses.map(({ start }) => start)).size, 1, 'the open steps pulse out of phase');
  assert.deepEqual(beat.filter(({ name }) => name !== 'wm-pulse-frontier').map(({ name, crowned, iterations }) => [name, crowned, iterations]), [['wm-pulse-node', true, Infinity]]);
  assert.deepEqual([afterBeat, left], [['wm-pulse-node'], []]);
});

test('the unlock plays blossom, travels, wakes and the pulse, and ends with the picture as drawn', { timeout: 120000 }, async () => {
  const { page, errors } = await open('/roadmap');
  const frame = await frameOf(page, '.rmUnlock');
  const drawn = () => frame.evaluate((body) => [...body.querySelectorAll('.rmTree *')].map((element) => {
    const style = getComputedStyle(element);
    return [element.getAttribute('class'), style.transform, style.scale, style.boxShadow, style.opacity, style.strokeDashoffset, style.filter];
  }));
  const before = { style: await drawn(), shot: await frame.screenshot() };
  await page.mouse.move(...await centreOf(frame.locator('.rmUnlock-arrow')));
  await page.waitForFunction(() => document.querySelector('.front-picture-body:has(.rmUnlock)').hasAttribute('data-beat'), null, { timeout: 5000 });
  const started = (await running(frame)).sort();
  // Every animation of the beat held at 450ms in, between the travels' leaving and their arrival, then let go.
  const travelling = await frame.evaluate((body) => {
    const beat = body.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSAnimation);
    beat.forEach((animation) => { animation.pause(); animation.currentTime = 450; });
    const opacities = [...body.querySelectorAll('.rmTree-travel')].map((travel) => Number(getComputedStyle(travel).opacity));
    beat.forEach((animation) => animation.play());
    return opacities;
  });
  await page.waitForFunction(() => !document.querySelector('.front-picture-body:has(.rmUnlock)').hasAttribute('data-beat'), null, { timeout: 8000 });
  await page.mouse.move(2, 2);
  await page.waitForFunction(() => !document.querySelector('.front-picture-body:has(.rmUnlock)').hasAttribute('data-pointed'), null, { timeout: 5000 });
  await settled(frame);
  const style = await drawn();
  // Chrome keeps a step it scaled on a layer of its own and rasterises its edge a few levels apart; drawn afresh, it is the picture.
  await frame.evaluate((body) => { body.style.display = 'none'; void body.offsetHeight; body.style.display = ''; });
  const after = { style, shot: await frame.screenshot() };
  await page.close();

  assert.deepEqual(errors, []);
  assert.deepEqual(started, ['rm-travel', 'rm-travel', 'rm-travel', 'rm-travel', 'rm-travel-shown', 'rm-travel-shown',
    'wm-blossom', 'wm-pulse-frontier', 'wm-pulse-frontier', 'wm-wake', 'wm-wake']);
  assert.deepEqual(travelling, [1, 1], 'the heads were not on their branches 400ms in');
  assert.deepEqual(after.style, before.style);
  assert.ok(after.shot.equals(before.shot), 'the unlock picture is not drawn as it was before the beat');
});

test('a path card under the pointer stays where it is while its crown breathes from its resting crest, and the breath ends as the pointer leaves', { timeout: 120000 }, async () => {
  const { page, errors } = await open('/roadmap');
  const frame = await frameOf(page, '.rmPaths');
  const card = frame.locator('.rmPaths-card').nth(1);
  const looked = () => card.evaluate((element) => {
    const crown = element.querySelector('.quest-thumb-halo');
    return { translate: getComputedStyle(element).translate, opacity: Number(getComputedStyle(crown).opacity).toFixed(2),
      breath: crown.getAnimations().map((animation) => [animation.animationName, animation.effect.getTiming().iterations, animation.effect.getTiming().delay]) };
  });
  const rest = await looked();
  await page.mouse.move(...await centreOf(card.locator('.rmPaths-title')));
  await drawnTwice(page);
  const hovered = await looked();
  // A quarter of a breath on from its start, read with the breath held there.
  const dipped = await card.evaluate((element) => {
    const crown = element.querySelector('.quest-thumb-halo');
    const [breath] = crown.getAnimations();
    breath.pause();
    breath.currentTime = 600;
    const opacity = Number(getComputedStyle(crown).opacity).toFixed(2);
    breath.play();
    return opacity;
  });
  await page.mouse.move(2, 2);
  await settled(card);
  const left = await looked();
  await page.close();

  assert.deepEqual(errors, []);
  assert.deepEqual(rest, { translate: 'none', opacity: '0.56', breath: [] });
  // Half a breath back, its first frame is the crest, .56, where the crown rests.
  assert.deepEqual([hovered.translate, hovered.breath], ['none', [['quest-halo-breathe', Infinity, -1200]]]);
  assert.ok(Number(dipped) < 0.56 && Number(dipped) > 0.28, `a quarter of a breath on, the crown stands at ${dipped}`);
  assert.deepEqual(left, rest);
});

test('a subtask under the pointer takes the room\'s wash, by day and at night', { timeout: 120000 }, async () => {
  const washes = [];
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await open('/roadmap', { colorScheme });
    const frame = await frameOf(page, '.rmStep');
    const row = frame.locator('.rmStep-subtasks li').nth(2);
    const wash = () => row.evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return [style.opacity, style.backgroundColor, style.inset, style.borderRadius, style.transitionDuration];
    });
    const surfaceHover = await frame.evaluate((body) => {
      const probe = body.querySelector('.rmStep-panel').appendChild(document.createElement('i'));
      probe.style.background = 'var(--surface-hover)';
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    });
    const rest = await wash();
    await page.mouse.move(...await centreOf(row));
    await settled(row);
    washes.push({ colorScheme, surfaceHover, rest, hovered: await wash() });
    await page.close();
    assert.deepEqual(errors, []);
  }
  assert.deepEqual(washes.map(({ colorScheme, rest, hovered }) => [colorScheme, rest[0], hovered]), [
    ['light', '0', ['1', washes[0].surfaceHover, '-7px -8px', '8px', '0.15s']],
    ['dark', '0', ['1', 'rgb(34, 34, 36)', '-7px -8px', '8px', '0.15s']],
  ]);
});

test('under reduced motion a path card\'s crown does not breathe, and a subtask still washes over 150ms', { timeout: 120000 }, async () => {
  const { page, errors } = await open('/roadmap', { reducedMotion: 'reduce' });
  const paths = await frameOf(page, '.rmPaths');
  const card = paths.locator('.rmPaths-card').first();
  await page.mouse.move(...await centreOf(card));
  await settled(card);
  const cardSeen = await card.evaluate((element) => ({ translate: getComputedStyle(element).translate,
    crown: Number(getComputedStyle(element.querySelector('.quest-thumb-halo')).opacity).toFixed(2), animations: element.getAnimations({ subtree: true }).length }));
  const step = await frameOf(page, '.rmStep');
  const row = step.locator('.rmStep-subtasks li').first();
  await page.mouse.move(...await centreOf(row));
  await settled(row);
  const washSeen = await row.evaluate((element) => [getComputedStyle(element, '::before').opacity, getComputedStyle(element, '::before').transitionDuration]);
  await page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual({ cardSeen, washSeen }, { cardSeen: { translate: 'none', crown: '0.56', animations: 0 }, washSeen: ['1', '0.15s'] });
});

test('the room\'s shelf still breathes its crowns from the shared waveform', { timeout: 120000 }, async () => {
  await ready;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/shelf`);
  await page.locator('.quest-card .quest-thumb-halo').first().waitFor({ timeout: 30000 });
  const breath = await page.locator('.quest-card .quest-thumb-halo').first().evaluate((halo) => halo.getAnimations().map((animation) => ({
    name: animation.animationName, iterations: animation.effect.getTiming().iterations, state: animation.playState,
    keyframes: animation.effect.getKeyframes().map(({ offset, opacity }) => [offset, opacity]),
  })));
  await page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(breath, [{ name: 'quest-halo-breathe', iterations: Infinity, state: 'running', keyframes: [[0, '0.28'], [0.5, '0.56'], [1, '0.28']] }]);
});

test('under reduced motion a pointed tree breathes no crown and plays no pulse, blossom, wake or travel', { timeout: 120000 }, async () => {
  const seen = [];
  for (const [path, selector] of [['/', '.rmPicture'], ['/roadmap', '.rmUnlock']]) {
    const { page, errors } = await open(path, { reducedMotion: 'reduce' });
    const frame = await frameOf(page, selector);
    // What runs as the beat begins: the crown's breath and every beat animation would be there.
    await frame.evaluate((body) => {
      window.beats = [];
      new MutationObserver(() => {
        const on = body.hasAttribute('data-beat');
        window.beats.push(on);
        if (on) window.atBeat = body.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSAnimation).map((animation) => animation.animationName);
      }).observe(body, { attributes: true, attributeFilter: ['data-beat'] });
    });
    await page.mouse.move(...await centreOf(frame.locator(`${selector}-arrow`)));
    await page.waitForFunction(() => window.beats.length === 2, null, { timeout: 10000 });
    seen.push({ path, pointed: await frame.evaluate((body) => body.hasAttribute('data-pointed')), beats: await page.evaluate(() => window.beats),
      atBeat: await page.evaluate(() => window.atBeat), running: await running(frame) });
    await page.close();
    assert.deepEqual(errors, []);
  }
  assert.deepEqual(seen, [
    { path: '/', pointed: true, beats: [true, false], atBeat: [], running: [] },
    { path: '/roadmap', pointed: true, beats: [true, false], atBeat: [], running: [] },
  ]);
});

test('the crown\'s glyph takes no pointer: the step under it does, or nothing', { timeout: 120000 }, async () => {
  const { page, errors } = await open('/');
  const frame = await frameOf(page, '.rmPicture');
  const crown = frame.locator('.rmTree-crown');
  const [x, y] = await centreOf(crown);
  const hit = await page.evaluate(([px, py]) => ({ crown: Boolean(document.elementFromPoint(px, py)?.closest('.rmTree-crown')), events: getComputedStyle(document.querySelector('.rmTree-crown')).pointerEvents }), [x, y]);
  await page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(hit, { crown: false, events: 'none' });
});

test('a finger tapping a path card on a hover device leaves the card where it is, its crown still and the picture unpointed', { timeout: 120000 }, async () => {
  const { page, errors } = await open('/roadmap');
  const frame = await frameOf(page, '.rmPaths');
  const card = frame.locator('.rmPaths-card').nth(1);
  const [x, y] = await centreOf(card);
  await page.evaluate(() => { window.lifted = false; addEventListener('pointerup', () => { window.lifted = true; }, true); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => window.lifted, null, { timeout: 10000 });
  await drawnTwice(page);
  const seen = await card.evaluate((element) => ({ hovered: element.matches(':hover'), translate: getComputedStyle(element).translate,
    animations: element.getAnimations({ subtree: true }).length, pointed: element.closest('.front-picture-body').hasAttribute('data-pointed') }));
  await page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual({ translate: seen.translate, animations: seen.animations, pointed: seen.pointed }, { translate: 'none', animations: 0, pointed: false });
});
