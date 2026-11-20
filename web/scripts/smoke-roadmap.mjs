// The production smoke for the roadmap room, read-only: web/CLAUDE.md says what it walks and what fails it.
//
//   node scripts/smoke-roadmap.mjs --base https://windmill.works [--roadmap t_9e407a96b5330ebe] [--api <origin>]
//
// --roadmap is a public roadmap with at least one step; the default is the public demo.
// --api is where the API and the share pages live: production serves them from --base, a preview build or a local stack
// (serve-built.mjs, which renders no share page) from its backend.
// Exit code 0 means every check passed. Results go to stdout, one line per check.

import { chromium } from 'playwright';
import { installReadOnlyGuard, installRoadmapObserver, settleVisuals, waitForConfirmed } from './roadmap-rig/browser-proof.mjs';

const DEFAULT_PUBLIC_ROADMAP = 't_9e407a96b5330ebe';
const BANDS = [
  { name: 'phone', width: 390, height: 844, phone: true },
  { name: 'tablet', width: 744, height: 1133, phone: false },
  { name: 'desktop', width: 1440, height: 900, phone: false },
];
const WAIT_MS = 30000;
// What a signed-out reader's page answers 4xx to by design. Anything else is a failure.
const EXPECTED_REFUSALS = [
  { path: /^\/v1\/me$/, status: 401 },
];
const ROOT_LANDING_APP = '.rootBand';
const ROADMAP_LANDING_APP = '.beats';
// Every element but the canvas hides for the Graph's shot, so its pixels are what WebGL drew and no caption or chrome.
const CANVAS_ONLY = '* { visibility: hidden !important; } canvas.st-canvas { visibility: visible !important; }';
const GROUND_DISTANCE = 24;
// The share of the canvas far from its commonest colour. A blank one reads 0; a healthy eight-step roadmap reads 2%.
const PAINTED_SHARE = 0.002;

function argumentsOf(argv) {
  const named = new Map();
  for (let index = 2; index < argv.length; index += 2) named.set(argv[index].replace(/^--/, ''), argv[index + 1]);
  const base = (named.get('base') ?? process.env.SMOKE_BASE_URL ?? '').replace(/\/$/, '');
  if (!base) throw new Error('--base <url> is required');
  return {
    base,
    api: (named.get('api') ?? base).replace(/\/$/, ''),
    roadmap: named.get('roadmap') ?? process.env.SMOKE_ROADMAP_ID ?? DEFAULT_PUBLIC_ROADMAP,
  };
}

// One fresh signed-out browser context, watching everything a reader's page should never do.
class Visit {
  constructor({ browser, band, site, serviceWorkers }) {
    this.browser = browser;
    this.band = band;
    this.serviceWorkers = serviceWorkers;
    this.problems = [];
    this.stage = 'navigation';
    this.origins = [new URL(site.base).origin, new URL(site.api).origin];
  }

  async open() {
    const { width, height, phone } = this.band;
    this.context = await this.browser.newContext({
      viewport: { width, height }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 3 : 1,
      reducedMotion: 'reduce', serviceWorkers: this.serviceWorkers,
    });
    this.guard = await installReadOnlyGuard(this.context, { origins: this.origins });
    this.blocked = this.guard.blocked;
    await this.context.addInitScript(installRoadmapObserver, { origins: this.origins });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(WAIT_MS);
    this.page.on('pageerror', () => this.problems.push('page-error'));
    this.page.on('console', (message) => this.onConsole(message));
    this.page.on('response', (response) => this.onResponse(response));
    this.page.on('requestfailed', (request) => this.onRequestFailed(request));
    this.page.on('websocket', (socket) => this.onSocket(socket));
    return this.page;
  }

  onSocket(socket) {
    socket.on('framesent', ({ payload }) => {
      let frame;
      try { frame = JSON.parse(String(payload)); } catch { return; }
      if (['subgraph', 'progress'].includes(frame?.t)) this.problems.push('wrote over the socket');
    });
  }

  // The reply to the session's subscribe: what takes a room from syncing to live.
  async sessionAnswered(treeId) {
    await this.page.evaluate((options) => window.__roadmapProof.waitForBaseline(options), { treeId, reach: 'reader', timeoutMs: WAIT_MS });
  }

  ours(url) {
    return this.origins.includes(new URL(url).origin);
  }

  expectedRefusal(url, status) {
    const { pathname } = new URL(url);
    return EXPECTED_REFUSALS.some((refusal) => refusal.path.test(pathname) && (status === undefined || refusal.status === status));
  }

  onConsole(message) {
    if (message.type() !== 'error') return;
    const { url } = message.location();
    if (url && this.ours(url) && this.expectedRefusal(url)) return;
    this.problems.push('console-error');
  }

  onResponse(response) {
    const url = response.url();
    if (!this.ours(url) || response.status() < 400 || this.expectedRefusal(url, response.status())) return;
    this.problems.push(`http-response-${response.status()}`);
  }

  onRequestFailed(request) {
    const url = request.url();
    if (!this.ours(url) || request.failure()?.errorText === 'net::ERR_ABORTED') return;
    this.problems.push('http-request-failed');
  }

  // Leaving the page while the routes still stand, so the flush on page hide meets the block too.
  async close() {
    await this.page.goto('about:blank');
    await this.context.close();
    if (this.guard.clientErrors) this.problems.push('a client_error beacon');
    if (this.blocked.sentry) this.problems.push('a Sentry attempt');
    if (this.guard.writes.length) this.problems.push('an HTTP mutation was blocked');
  }
}

const identity = (page, role, view) => page.locator(`.st-roadmap-identity[data-role="${role}"][data-view="${view}"]`);
const boardCards = (page) => page.locator('.st-view-layer--board.is-active .st-board-card:visible');
const stepDocument = (page) => page.locator('.st-board-step-layer article');

async function paintedShare(page) {
  const shot = await page.locator('canvas.st-canvas').screenshot({ style: CANVAS_ONLY, animations: 'allow', scale: 'css' });
  const blank = await page.context().newPage();
  const share = await blank.evaluate(async ({ png, groundDistance }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const drawing = canvas.getContext('2d');
    drawing.drawImage(bitmap, 0, 0);
    const { data } = drawing.getImageData(0, 0, bitmap.width, bitmap.height);
    const colours = new Map();
    for (let at = 0; at < data.length; at += 4) {
      const colour = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];
      colours.set(colour, (colours.get(colour) ?? 0) + 1);
    }
    const [ground] = [...colours.entries()].reduce((most, entry) => (entry[1] > most[1] ? entry : most));
    const channels = [ground >> 16, (ground >> 8) & 255, ground & 255];
    let painted = 0;
    for (let at = 0; at < data.length; at += 4) {
      if (channels.some((channel, index) => Math.abs(data[at + index] - channel) > groundDistance)) painted += 1;
    }
    return painted / (data.length / 4);
  }, { png: shot.toString('base64'), groundDistance: GROUND_DISTANCE });
  await blank.close();
  return share;
}

async function graphPainted(page) {
  await page.locator('canvas.st-canvas').waitFor();
  await page.evaluate(settleVisuals);
  await waitForConfirmed(() => paintedShare(page), (share) => share >= PAINTED_SHARE,
    { timeoutMs: WAIT_MS, intervalMs: 250, label: 'painted-roadmap' });
}

async function appMounted(page, selector) {
  await page.locator(selector).first().waitFor({ state: 'attached' })
    .catch(() => { throw new Error('the app never mounted over the no-JS body'); });
}

async function switchToBoard(page, role) {
  await page.locator('.st-roadmap-identity button[aria-label="Board"]').click();
  await identity(page, role, 'board').waitFor();
  await boardCards(page).first().waitFor();
  await page.evaluate(settleVisuals);
}

// Opens the first card's step and answers the step the card named.
async function openFirstStep(page) {
  const card = boardCards(page).first();
  const titleLabel = card.locator('.st-board-card-title');
  const step = { id: await card.getAttribute('data-step-id'), label: (await titleLabel.innerText()).trim() };
  await titleLabel.click();
  await stepDocument(page).waitFor();
  await page.evaluate(settleVisuals);
  const shown = (await stepDocument(page).innerText()).trim();
  if (!shown.includes(step.label)) throw new Error('the step page does not name the selected step');
  if (!(await page.evaluate(() => window.location.hash)).includes('step=')) throw new Error('the open step is not in the address');
  return step;
}

async function closeWithBack(page) {
  await page.goBack();
  await stepDocument(page).waitFor({ state: 'detached' });
  if ((await page.evaluate(() => window.location.hash)).includes('step=')) throw new Error('Back left the step in the address');
  await boardCards(page).first().waitFor();
}

// Opens the Fork door, sees its email field and leaves without submitting.
async function openAndCloseFork(page, band) {
  const fork = band.phone
    ? page.locator('.st-board-phone-notices button', { hasText: 'Fork this tree' })
    : page.locator('.st-roadmap-identity .st-roadmap-fork');
  await fork.click();
  const door = page.locator('[role="dialog"]').filter({ has: page.locator('input[type="email"]') });
  await door.waitFor();
  await page.keyboard.press('Escape');
  await door.waitFor({ state: 'detached' });
}

async function reopenWithForward(page) {
  await page.goForward();
  await stepDocument(page).waitFor();
}

async function demoWalk(page, { band, site, visit }) {
  await page.goto(`${site.base}/#/demo`);
  visit.stage = 'graph';
  await identity(page, 'demo', 'tree').waitFor();
  await page.locator('.st-roadmap-sample').waitFor();
  await graphPainted(page);
  visit.stage = 'subscription-baseline';
  await visit.sessionAnswered(DEFAULT_PUBLIC_ROADMAP);
  visit.stage = 'board';
  await switchToBoard(page, 'demo');
  visit.stage = 'step';
  await openFirstStep(page);
  visit.stage = 'history';
  await closeWithBack(page);
  await reopenWithForward(page);
  await closeWithBack(page);
  visit.stage = 'fork-door';
  await openAndCloseFork(page, band);
}

async function publicRoadmapWalk(page, { site, visit, found }) {
  await page.goto(`${site.base}/t/${site.roadmap}`);
  visit.stage = 'graph';
  await identity(page, 'reader', 'tree').waitFor();
  await graphPainted(page);
  visit.stage = 'subscription-baseline';
  await visit.sessionAnswered(site.roadmap);
  visit.stage = 'reader-board';
  await switchToBoard(page, 'reader');
  for (const control of ['button[aria-label="New step"]', '.st-board-swipe-complete']) {
    if (await page.locator(control).count()) throw new Error(`a reader's Board offers ${control}`);
  }
  visit.stage = 'reader-step';
  found.step = await openFirstStep(page);
  for (const action of ['Complete', 'Edit step', 'Reset']) {
    if (await stepDocument(page).getByRole('button', { name: action, exact: true }).count()) throw new Error(`a reader's step offers ${action}`);
  }
  visit.stage = 'history';
  await closeWithBack(page);
  await reopenWithForward(page);
  await closeWithBack(page);
}

// The server renders a roadmap's share page for crawlers: one it can read names its own address as canonical, and a
// public one lets them index it. Any other id gets the app's shell as it is.
async function stepLinkWalk(page, { site, visit, found }) {
  visit.stage = 'share-page';
  const share = await page.request.get(`${site.api}/t/${site.roadmap}`);
  if (!share.ok()) throw new Error(`the share page answered ${share.status()}`);
  const head = await share.text();
  const canonical = head.match(/<link rel="canonical" href="([^"]*)" \/>/)?.[1] ?? '';
  const robots = head.match(/<meta name="robots" content="([^"]*)" \/>/)?.[1] ?? '';
  if (!canonical.endsWith(`/t/${site.roadmap}`) || !robots.startsWith('index')) throw new Error('the roadmap is not public');
  visit.stage = 'step-link';
  const { step } = found;
  if (!step) throw new Error('the public roadmap walk opened no step');
  await page.goto(`${site.base}/t/${site.roadmap}#?step=${encodeURIComponent(step.id)}`);
  await stepDocument(page).waitFor();
  if (!(await stepDocument(page).innerText()).includes(step.label)) throw new Error('the link did not land on its step');
  visit.stage = 'subscription-baseline';
  await visit.sessionAnswered(site.roadmap);
  visit.stage = 'step-settlement';
  await page.evaluate(settleVisuals);
}

function landingWalk(path, app) {
  return async (page, { site, visit }) => {
    await page.goto(`${site.base}${path}`);
    visit.stage = 'landing-mount';
    await appMounted(page, app);
    await page.locator('h1').first().waitFor({ state: 'attached' });
    await page.evaluate(settleVisuals);
  };
}

// Every other walk blocks the worker; this one lets it take the page and prime its shell, then comes back to a landing and a room through it.
async function returningVisitWalk(page, { site, visit }) {
  await page.goto(`${site.base}/`);
  visit.stage = 'landing-mount';
  await appMounted(page, ROOT_LANDING_APP);
  visit.stage = 'service-worker-control';
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
    .catch(() => { throw new Error('the service worker never took the page'); });
  const primed = () => page.evaluate(async () => (await caches.keys()).some((name) => name.startsWith('windmill-generation-')));
  visit.stage = 'service-worker-shell';
  await waitForConfirmed(primed, (value) => value, { timeoutMs: WAIT_MS, intervalMs: 250, label: 'service-worker-shell' });
  visit.stage = 'returning-landing';
  const landing = await page.goto(`${site.base}/`);
  if (!landing.fromServiceWorker()) throw new Error('the returning visit did not come through the service worker');
  if (!landing.ok()) throw new Error(`the service worker answered a returning visit with ${landing.status()}`);
  await appMounted(page, ROOT_LANDING_APP);
  visit.stage = 'returning-roadmap';
  await page.goto(`${site.base}/t/${site.roadmap}`);
  await identity(page, 'reader', 'tree').waitFor();
  await graphPainted(page);
  visit.stage = 'subscription-baseline';
  await visit.sessionAnswered(site.roadmap);
}

// In this order on each band: the step link lands on the step the public roadmap's Board opened (`found`).
const WALKS = [
  ['the demo lands on the Graph, its Board opens a step, Back returns, Fork opens and closes', demoWalk],
  ['a public roadmap lands on the Graph, its Board reads read-only, and Back and Forward walk its step', publicRoadmapWalk],
  ['a step link lands on its step', stepLinkWalk],
  ['/roadmap mounts its app', landingWalk('/roadmap', ROADMAP_LANDING_APP)],
  ['/ mounts its app', landingWalk('/', ROOT_LANDING_APP)],
];

async function runWalk({ browser, band, site, walk, label, found = {}, serviceWorkers = 'block' }) {
  const visit = new Visit({ browser, band, site, serviceWorkers });
  const page = await visit.open();
  const started = Date.now();
  try {
    await walk(page, { band, site, visit, found });
  } catch {
    visit.problems.push(`walk-failed-at-${visit.stage}`);
  }
  await visit.close();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const failed = visit.problems.length > 0;
  console.log(`${failed ? 'FAIL' : 'ok  '} ${String(band.width).padStart(4)} · ${label} (${seconds}s; blocked ${visit.blocked.intake} beacons, ${visit.blocked.sentry} Sentry, ${visit.blocked.analytics} analytics)`);
  for (const problem of new Set(visit.problems)) console.log(`       ${problem} (${visit.problems.filter((value) => value === problem).length})`);
  return { blocked: visit.blocked, failed };
}

async function main() {
  const site = argumentsOf(process.argv);
  console.log('Smoke roadmap checks');
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  try {
    for (const band of BANDS) {
      const found = {};
      for (const [label, walk] of WALKS) results.push(await runWalk({ browser, band, site, walk, label, found }));
    }
    results.push(await runWalk({
      browser, band: BANDS.at(-1), site, walk: returningVisitWalk, serviceWorkers: 'allow',
      label: 'a returning visit through the service worker reaches the landing and a room',
    }));
  } finally {
    await browser.close();
  }
  const failures = results.filter((result) => result.failed).length;
  console.log(`${results.length - failures} of ${results.length} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

await main().catch(() => {
  console.error('FAIL smoke-infrastructure');
  process.exitCode = 1;
});
