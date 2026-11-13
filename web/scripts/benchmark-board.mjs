// Measures the Board in a production build: how long a roadmap takes to open, how a long Locked column scrolls and what the
// Graph's layout costs under it, in headless Chromium with the CPU throttled. A measuring tool, not a CI gate. Hardware and
// SwiftShader differ, so real-device numbers stay a separate recording.
//
//   npx vite preview --port <port>       a build made with VITE_API_BASE_URL pointing at a local backend
//   node scripts/benchmark-board.mjs --base http://localhost:<port> --api http://localhost:<backend> --cookie <wm_session> \
//     [--rates 4,6] [--json <path>]
//
// --cookie is a session of a throwaway account; it owns the two roadmaps this script plants. Layout shares need names, so
// they read n/a unless --base serves an unminified build, which needs the offline shell's precache budget off too.

import { readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { chromium } from 'playwright';
import { largeRoadmap } from '../test/products/roadmap/fixtures/largeRoadmap.js';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, phone: true },
  { name: 'desktop', width: 1440, height: 900, phone: false },
];
const SETTLE_MS = 2500;
const PROGRESS_CHUNK = 100;
const SCROLL_PX_PER_FRAME = 60;
const SCROLL_FRAMES = 300;
const LAYOUT_FUNCTIONS = /^(layoutTree|layoutPositions)$/;

function argumentsOf(argv) {
  const named = new Map();
  for (let index = 2; index < argv.length; index += 2) named.set(argv[index].replace(/^--/, ''), argv[index + 1]);
  for (const required of ['base', 'api', 'cookie']) if (!named.get(required)) throw new Error(`--${required} is required`);
  return {
    base: named.get('base'), api: named.get('api'), cookie: named.get('cookie'), json: named.get('json'),
    rates: String(named.get('rates') ?? '4,6').split(',').map(Number),
  };
}

const quantile = (values, q) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const round = (value) => Math.round(value);
const longTaskSummary = (durations) => ({ count: durations.length, p95: round(quantile(durations, 0.95)), max: round(Math.max(0, ...durations)) });

// The two roadmaps: 5,000 synthetic steps and the size of the dogfood tree. Planted once per database.
function fixtures() {
  const dogfood = JSON.parse(readFileSync(new URL('../test/products/roadmap/fixtures/dogfood-tree.json', import.meta.url), 'utf8'));
  const large = largeRoadmap(5000, 'mixed');
  return [
    { name: '5,000 steps', id: 't_b0a4d5000000beef', title: 'Five thousand steps', nodes: large.nodes },
    { name: 'dogfood size', id: 't_b0a4d4760000beef', title: dogfood.title, nodes: dogfood.nodes, kinds: dogfood.kinds },
  ];
}

async function callApi(site, method, path, body) {
  const response = await fetch(`${site.api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${site.cookie}`, Origin: site.base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
}

async function callTool(site, session, name, args) {
  const reply = await fetch(`${site.api}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${session.token}`, ...(session.id && { 'Mcp-Session-Id': session.id }) },
    body: JSON.stringify(name === 'initialize'
      ? { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'benchmark-board', version: '0' } } }
      : { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (name === 'initialize') return reply.headers.get('mcp-session-id');
  const { result } = await reply.json();
  if (result?.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
  return result;
}

async function plant(site) {
  const planted = fixtures();
  const key = await callApi(site, 'POST', '/v1/mcp-keys', { name: 'benchmark-board' });
  const session = { token: key.body.token };
  session.id = await callTool(site, session, 'initialize');
  for (const fixture of planted) {
    if ((await callApi(site, 'GET', `/v1/trees/${fixture.id}`)).status !== 200) {
      const nodes = fixture.nodes.map(({ id, label, color, prerequisites, icon, order, description, links }) => ({
        id, label, color, prerequisites: prerequisites ?? [], ...(icon && { icon }), ...(order && { order }), ...(description && { description }), ...(links?.length && { links }),
      }));
      const created = await callApi(site, 'POST', '/v1/trees', { id: fixture.id, title: fixture.title, nodes, kinds: fixture.kinds ?? [] });
      if (created.status !== 200) throw new Error(`planting ${fixture.name} answered ${created.status}`);
    }
    const { body } = await callApi(site, 'GET', `/v1/trees/${fixture.id}/progress`);
    if ((body?.marks ?? []).length > 0) continue;
    const updates = fixture.nodes.filter((node) => node.status === 'complete').map((node) => ({ nodeId: node.id, status: 'complete' }));
    for (let start = 0; start < updates.length; start += PROGRESS_CHUNK) {
      await callTool(site, session, 'roadmap_update_nodes', { treeId: fixture.id, updates: updates.slice(start, start + PROGRESS_CHUNK) });
    }
  }
  return planted;
}

// Runs in the page before anything else: long tasks, input to next paint and the two opening marks. Headless Chromium
// counts events but reports no Event Timing entries, so an input is timed to the task after its next frame.
function installProbes() {
  window.__probe = { longTasks: [], inputs: [], marks: {} };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: 'longtask', buffered: true });
  for (const type of ['click', 'keydown']) {
    window.addEventListener(type, (event) => {
      requestAnimationFrame(() => {
        const after = new MessageChannel();
        after.port1.onmessage = () => window.__probe.inputs.push({ type, start: event.timeStamp, duration: performance.now() - event.timeStamp });
        after.port2.postMessage(0);
      });
    }, true);
  }
  const mark = (name) => { window.__probe.marks[name] ??= performance.now(); };
  const watch = new MutationObserver(() => {
    if (!window.__probe.marks.card && [...document.querySelectorAll('.st-view-layer--board.is-active .st-board-card')].some((card) => card.getClientRects().length > 0)) {
      requestAnimationFrame(() => setTimeout(() => mark('card'), 0));
    }
    if (!window.__probe.marks.row && document.querySelector('.st-roadmap-identity .st-board-switch-option')) {
      requestAnimationFrame(() => setTimeout(() => mark('row'), 0));
    }
  });
  document.addEventListener('DOMContentLoaded', () => watch.observe(document.documentElement, { childList: true, subtree: true }));
}

function layoutShare(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const selfMicros = new Map();
  profile.samples.forEach((id, index) => selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0)));
  const named = profile.nodes.some((node) => LAYOUT_FUNCTIONS.test(node.callFrame.functionName));
  if (!named) return null;
  const underLayout = (id) => {
    for (let at = id; at !== undefined; at = parents.get(at)) if (LAYOUT_FUNCTIONS.test(byId.get(at).callFrame.functionName)) return true;
    return false;
  };
  let busy = 0;
  let layout = 0;
  for (const [id, micros] of selfMicros) {
    const name = byId.get(id).callFrame.functionName;
    if (name === '(idle)' || name === '(program)') continue;
    busy += micros;
    if (underLayout(id)) layout += micros;
  }
  return { layoutMs: round(layout / 1000), busyMs: round(busy / 1000), share: Math.round((layout / busy) * 100) / 100 };
}

async function scrollLocked(page, phone) {
  if (phone) await page.getByRole('tab', { name: /^Locked,/ }).click();
  return page.evaluate(async ({ pixels, frames }) => {
    const card = document.querySelector('[data-column="locked"] .st-board-card, .st-board-phone-pane.is-shown .st-board-card');
    let scroller = card;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    const started = performance.now();
    const intervals = [];
    let maxCards = 0;
    let last = started;
    let frame = 0;
    await new Promise((resolve) => {
      const tick = (now) => {
        intervals.push(now - last);
        last = now;
        scroller.scrollTop += pixels;
        maxCards = Math.max(maxCards, document.querySelectorAll('.st-board-card').length);
        frame += 1;
        if (frame >= frames || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return { started, ended: performance.now(), intervals: intervals.slice(1), maxCards, scrolled: scroller.scrollTop, height: scroller.scrollHeight };
  }, { pixels: SCROLL_PX_PER_FRAME, frames: SCROLL_FRAMES });
}

async function inputToPaint(page, act, type) {
  const before = await page.evaluate(() => performance.now());
  await act();
  await page.waitForTimeout(1200);
  const inputs = await page.evaluate(({ since, wanted }) => window.__probe.inputs.filter((input) => input.start >= since && input.type === wanted), { since: before, wanted: type });
  return round(Math.max(0, ...inputs.map((input) => input.duration)));
}

async function measureOne({ browser, site, fixture, viewport, rate }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.phone, hasTouch: viewport.phone,
    deviceScaleFactor: viewport.phone ? 2 : 1, serviceWorkers: 'block',
  });
  await context.addCookies([{ name: 'wm_session', value: site.cookie, domain: new URL(site.base).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(installProbes);
  const page = await context.newPage();
  page.setDefaultTimeout(180000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });

  await page.goto(`${site.base}/#/app/${fixture.id}`);
  await page.locator('.st-view-layer--board.is-active .st-board-card:visible').first().waitFor();
  await page.locator('.st-roadmap-identity .st-board-switch-option').first().waitFor();
  await page.waitForFunction(() => window.__probe.marks.card && window.__probe.marks.row);
  await page.waitForTimeout(SETTLE_MS * Math.max(1, rate / 2));
  const { profile } = await cdp.send('Profiler.stop');
  const opened = await page.evaluate(() => ({ marks: window.__probe.marks, longTasks: window.__probe.longTasks, ended: performance.now() }));
  await cdp.send('HeapProfiler.collectGarbage');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));

  const scroll = await scrollLocked(page, viewport.phone);
  const scrollTasks = await page.evaluate(({ from, to }) => window.__probe.longTasks.filter((task) => task.start >= from && task.start <= to).map((task) => task.duration), { from: scroll.started, to: scroll.ended });

  if (viewport.phone) await page.getByRole('tab', { name: /^Up next,/ }).click();
  await page.waitForTimeout(400);
  const upNext = viewport.phone ? page.locator('.st-board-phone-pane.is-shown .st-board-card').first() : page.locator('[data-column="upNext"] .st-board-card').first();
  const openCard = await inputToPaint(page, () => upNext.click(), 'click');
  if (viewport.phone) await page.goBack();
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  let completeCard = null;
  if (viewport.phone) {
    await page.locator('.st-board-phone-pane.is-shown .st-board-swipe-complete').first().focus();
    completeCard = await inputToPaint(page, () => page.keyboard.press('Enter'), 'click');
  } else {
    await upNext.focus();
    completeCard = await inputToPaint(page, () => page.keyboard.press('c'), 'keydown');
  }
  await page.locator('.st-board-toast-undo').click({ timeout: 8000 }).catch(() => {});
  await cdp.detach();
  await context.close();

  return {
    roadmap: fixture.name, viewport: viewport.name, cpuThrottle: rate, machineLoad: Math.round(loadavg()[0]),
    openMs: { firstCard: round(opened.marks.card), rowInteractive: round(opened.marks.row) },
    openLongTasks: longTaskSummary(opened.longTasks.map((task) => task.duration)),
    heapMb: Math.round((metrics.JSHeapUsedSize / (1024 * 1024)) * 10) / 10,
    scroll: {
      frames: scroll.intervals.length, scrolledPx: round(scroll.scrolled), columnPx: round(scroll.height),
      frameP50: round(quantile(scroll.intervals, 0.5)), frameP95: round(quantile(scroll.intervals, 0.95)),
      longTasks: longTaskSummary(scrollTasks), maxCardsInDom: scroll.maxCards,
    },
    inputToPaintMs: { openCard, completeCard },
    layoutOfOpen: layoutShare(profile),
  };
}

function line(result) {
  const { openMs, openLongTasks, heapMb, scroll, inputToPaintMs, layoutOfOpen } = result;
  const layout = layoutOfOpen ? `${layoutOfOpen.layoutMs}ms of ${layoutOfOpen.busyMs}ms busy, ${Math.round(layoutOfOpen.share * 100)}%` : 'n/a (minified)';
  return `${result.roadmap} · ${result.viewport} · ${result.cpuThrottle}× · machine load ${result.machineLoad}
  open: first card ${openMs.firstCard}ms, row interactive ${openMs.rowInteractive}ms; long tasks ${openLongTasks.count}, p95 ${openLongTasks.p95}ms, max ${openLongTasks.max}ms; heap ${heapMb}MB
  scroll: ${scroll.frames} frames over ${scroll.scrolledPx}px of ${scroll.columnPx}px; rAF p50 ${scroll.frameP50}ms, p95 ${scroll.frameP95}ms; long tasks ${scroll.longTasks.count}, p95 ${scroll.longTasks.p95}ms, max ${scroll.longTasks.max}ms; at most ${scroll.maxCardsInDom} cards in the DOM
  input to next paint: open a card ${inputToPaintMs.openCard}ms, complete a card ${inputToPaintMs.completeCard}ms
  layout of the open: ${layout}`;
}

async function main() {
  const site = argumentsOf(process.argv);
  const roadmaps = await plant(site);
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
  const results = [];
  for (const fixture of roadmaps) {
    for (const viewport of VIEWPORTS) {
      for (const rate of site.rates) {
        const result = await measureOne({ browser, site, fixture, viewport, rate });
        results.push(result);
        console.log(line(result));
      }
    }
  }
  await browser.close();
  if (site.json) writeFileSync(site.json, `${JSON.stringify(results, null, 2)}\n`);
}

await main();
