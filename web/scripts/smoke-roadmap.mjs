// The production smoke for the roadmap room: a signed-out reader's walk through the demo, a public roadmap and the landings,
// at phone, tablet and desktop width, and one returning visit through the service worker. It never signs in and never writes,
// and it blocks the event intake and Sentry at the network layer, so it leaves no trace in production analytics.
//
// A walk fails on a page error, a console error, a failed same-origin request, a Graph with no painted pixels, a session whose
// socket never got its reply, any Sentry attempt, a `client_error` beacon, a landing the app never mounted over, or a service
// worker that never took the page or answers a returning visit badly.
//
//   node scripts/smoke-roadmap.mjs --base https://windmill.works [--roadmap t_9e407a96b5330ebe] [--api <origin>]
//
// --roadmap is a public roadmap with at least one step; the default is the one the public gallery lists.
// --api is where a preview build's API lives; production serves it from --base.
// Exit code 0 means every check passed. Results go to stdout, one line per check.

import { chromium } from 'playwright';

const DEFAULT_PUBLIC_ROADMAP = 't_9e407a96b5330ebe';
const BANDS = [
  { name: 'phone', width: 390, height: 844, phone: true },
  { name: 'tablet', width: 744, height: 1133, phone: false },
  { name: 'desktop', width: 1440, height: 900, phone: false },
];
const WAIT_MS = 30000;
const INTAKE = /\/v1\/events(\?|$)/;
const SENTRY_HOSTS = /(^|\.)(sentry\.io|sentry\.invalid)$/;
// Production's edge injects Cloudflare's script on a healthy page, so it counts as analytics and never as a failure.
const CLOUDFLARE_HOST = /(^|\.)cloudflareinsights\.com$/;
// The block itself: that script reports its emptied body as a failed integrity check.
const BLOCKED_SCRIPT_COMPLAINT = /cloudflareinsights\.com/;
// What a signed-out reader's page answers 4xx to by design. Anything else is a failure.
const EXPECTED_REFUSALS = [
  { path: /^\/v1\/me$/, status: 401 },
];
const WRITE_FRAMES = /"t":"(subgraph|progress)"/;
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

function parsedJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// One fresh signed-out browser context, watching everything a reader's page should never do.
class Visit {
  constructor({ browser, band, site, serviceWorkers }) {
    this.browser = browser;
    this.band = band;
    this.site = site;
    this.serviceWorkers = serviceWorkers;
    this.problems = [];
    this.blocked = { intake: 0, sentry: 0, analytics: 0 };
    this.session = { sockets: 0, answered: false };
  }

  async open() {
    const { width, height, phone } = this.band;
    this.context = await this.browser.newContext({
      viewport: { width, height }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 3 : 1,
      reducedMotion: 'reduce', serviceWorkers: this.serviceWorkers,
    });
    await this.context.route(
      (url) => INTAKE.test(url.pathname) || SENTRY_HOSTS.test(url.hostname) || CLOUDFLARE_HOST.test(url.hostname),
      (route) => this.onBlocked(route),
    );
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(WAIT_MS);
    this.page.on('pageerror', (error) => this.problems.push(`pageerror: ${error.message}`));
    this.page.on('console', (message) => this.onConsole(message));
    this.page.on('response', (response) => this.onResponse(response));
    this.page.on('requestfailed', (request) => this.onRequestFailed(request));
    this.page.on('request', (request) => this.onRequest(request));
    this.page.on('websocket', (socket) => this.onSocket(socket));
    return this.page;
  }

  onBlocked(route) {
    const request = route.request();
    const { hostname, pathname } = new URL(request.url());
    if (INTAKE.test(pathname)) {
      this.blocked.intake += 1;
      const beacon = parsedJson(request.postData());
      if (beacon?.events?.some((event) => event.name === 'client_error')) this.problems.push('a client_error beacon');
      return route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
    }
    if (SENTRY_HOSTS.test(hostname)) {
      this.blocked.sentry += 1;
      const report = parsedJson(String(request.postData()).split('\n')[2]);
      this.problems.push(`a Sentry report: ${report?.exception?.values?.[0]?.value ?? 'unreadable'}`);
    } else {
      this.blocked.analytics += 1;
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  }

  onSocket(socket) {
    this.session.sockets += 1;
    socket.on('framesent', ({ payload }) => {
      if (WRITE_FRAMES.test(String(payload))) this.problems.push('wrote over the socket');
    });
    socket.on('framereceived', ({ payload }) => {
      const frame = parsedJson(String(payload));
      if (frame?.t === 'subgraph' && frame.intent === 'delta') this.session.answered = true;
    });
  }

  // The reply to the session's subscribe: what takes a room from syncing to live.
  async sessionAnswered() {
    const deadline = Date.now() + WAIT_MS;
    while (!this.session.answered && Date.now() < deadline) await this.page.waitForTimeout(200);
    if (this.session.answered) return;
    throw new Error(this.session.sockets > 0 ? "the session's socket never got its reply" : 'the session never opened a socket');
  }

  ours(url) {
    return url.startsWith(this.site.base) || url.startsWith(this.site.api);
  }

  expectedRefusal(url, status) {
    const { pathname } = new URL(url);
    return EXPECTED_REFUSALS.some((refusal) => refusal.path.test(pathname) && (status === undefined || refusal.status === status));
  }

  onConsole(message) {
    if (message.type() !== 'error') return;
    const { url } = message.location();
    if (url && this.ours(url) && this.expectedRefusal(url)) return;
    if (BLOCKED_SCRIPT_COMPLAINT.test(message.text())) return;
    this.problems.push(`console error: ${message.text().slice(0, 300)}`);
  }

  onResponse(response) {
    const url = response.url();
    if (!this.ours(url) || response.status() < 400 || this.expectedRefusal(url, response.status())) return;
    this.problems.push(`${response.status()} ${response.request().method()} ${new URL(url).pathname}`);
  }

  onRequestFailed(request) {
    const url = request.url();
    if (!this.ours(url) || request.failure()?.errorText === 'net::ERR_ABORTED') return;
    this.problems.push(`request failed: ${request.method()} ${new URL(url).pathname} ${request.failure()?.errorText}`);
  }

  onRequest(request) {
    const url = request.url();
    if (!this.ours(url) || INTAKE.test(new URL(url).pathname) || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    this.problems.push(`wrote: ${request.method()} ${new URL(url).pathname}`);
  }

  // Leaving the page while the routes still stand, so the flush on page hide meets the block too.
  async close() {
    await this.page.goto('about:blank');
    await this.context.close();
  }
}

const identity = (page, role, view) => page.locator(`.st-roadmap-identity[data-role="${role}"][data-view="${view}"]`);
const boardCards = (page) => page.locator('.st-view-layer--board.is-active .st-board-card:visible');
const stepDialog = (page) => page.locator('.st-board-step-layer [role="dialog"]');

async function paintedShare(page) {
  const shot = await page.locator('canvas.st-canvas').screenshot({ style: CANVAS_ONLY, animations: 'allow' });
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
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await paintedShare(page) >= PAINTED_SHARE) return;
    await page.waitForTimeout(500);
  }
  throw new Error('the Graph painted nothing');
}

async function appMounted(page, selector) {
  await page.locator(selector).first().waitFor({ state: 'attached' })
    .catch(() => { throw new Error(`the app never mounted: no ${selector} over the no-JS body`); });
}

async function switchToBoard(page, role) {
  await page.locator('.st-roadmap-identity button[aria-label="Board"]').click();
  await identity(page, role, 'board').waitFor();
  await boardCards(page).first().waitFor();
}

async function openFirstStep(page) {
  const card = boardCards(page).first();
  const title = (await card.locator('.st-board-card-title').innerText()).trim();
  await card.click();
  await stepDialog(page).waitFor();
  const shown = (await stepDialog(page).innerText()).trim();
  if (!shown.includes(title)) throw new Error(`the step page does not name "${title}"`);
  if (!(await page.evaluate(() => window.location.hash)).includes('step=')) throw new Error('the open step is not in the address');
}

async function closeWithBack(page) {
  await page.goBack();
  await stepDialog(page).waitFor({ state: 'detached' });
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
  await stepDialog(page).waitFor();
}

async function demoWalk(page, { band, site, visit }) {
  await page.goto(`${site.base}/#/demo`);
  await identity(page, 'demo', 'tree').waitFor();
  await page.locator('.st-roadmap-sample').waitFor();
  await graphPainted(page);
  await visit.sessionAnswered();
  await switchToBoard(page, 'demo');
  await openFirstStep(page);
  await closeWithBack(page);
  await reopenWithForward(page);
  await closeWithBack(page);
  await openAndCloseFork(page, band);
}

async function publicRoadmapWalk(page, { site, visit }) {
  await page.goto(`${site.base}/t/${site.roadmap}`);
  await identity(page, 'reader', 'tree').waitFor();
  await graphPainted(page);
  await visit.sessionAnswered();
  await switchToBoard(page, 'reader');
  for (const control of ['button[aria-label="New step"]', '.st-board-swipe-complete']) {
    if (await page.locator(control).count()) throw new Error(`a reader's Board offers ${control}`);
  }
  await openFirstStep(page);
  for (const action of ['Complete', 'Edit step', 'Reset']) {
    if (await stepDialog(page).getByRole('button', { name: action, exact: true }).count()) throw new Error(`a reader's step offers ${action}`);
  }
  await closeWithBack(page);
  await reopenWithForward(page);
  await closeWithBack(page);
}

async function stepLinkWalk(page, { site, visit }) {
  const reply = await page.request.get(`${site.api}/v1/trees/${site.roadmap}`);
  if (!reply.ok()) throw new Error(`the public roadmap answered ${reply.status()}`);
  const { data, visibility } = await reply.json();
  if (visibility !== 'public') throw new Error(`the roadmap is ${visibility}, not public`);
  const step = data.nodes[0];
  await page.goto(`${site.base}/t/${site.roadmap}#?step=${encodeURIComponent(step.id)}`);
  await stepDialog(page).waitFor();
  if (!(await stepDialog(page).innerText()).includes(step.label)) throw new Error(`the link did not land on "${step.label}"`);
  await visit.sessionAnswered();
}

function landingWalk(path, app) {
  return async (page, { site }) => {
    await page.goto(`${site.base}${path}`);
    await appMounted(page, app);
    await page.locator('h1').first().waitFor({ state: 'attached' });
  };
}

// Every other walk blocks the worker, and a broken one first hurts whoever comes back: this walk lets it take the page and
// prime its shell, then returns to the brand landing and a room through it.
async function returningVisitWalk(page, { site, visit }) {
  await page.goto(`${site.base}/`);
  await appMounted(page, ROOT_LANDING_APP);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
    .catch(() => { throw new Error('the service worker never took the page'); });
  await page.waitForFunction(async () => (await caches.keys()).some((name) => name.startsWith('windmill-generation-')))
    .catch(() => { throw new Error('the service worker never primed its offline shell'); });
  const landing = await page.goto(`${site.base}/`);
  if (!landing.fromServiceWorker()) throw new Error('the returning visit did not come through the service worker');
  if (!landing.ok()) throw new Error(`the service worker answered a returning visit with ${landing.status()}`);
  await appMounted(page, ROOT_LANDING_APP);
  await page.goto(`${site.base}/t/${site.roadmap}`);
  await identity(page, 'reader', 'tree').waitFor();
  await graphPainted(page);
  await visit.sessionAnswered();
}

const WALKS = [
  ['the demo lands on the Graph, its Board opens a step, Back returns, Fork opens and closes', demoWalk],
  ['a public roadmap lands on the Graph, its Board reads read-only, and Back and Forward walk its step', publicRoadmapWalk],
  ['a step link lands on its step', stepLinkWalk],
  ['/roadmap mounts its app', landingWalk('/roadmap', ROADMAP_LANDING_APP)],
  ['/ mounts its app', landingWalk('/', ROOT_LANDING_APP)],
];

async function runWalk({ browser, band, site, walk, label, serviceWorkers = 'block' }) {
  const visit = new Visit({ browser, band, site, serviceWorkers });
  const page = await visit.open();
  const started = Date.now();
  try {
    await walk(page, { band, site, visit });
  } catch (error) {
    visit.problems.push(error.message.split('\n')[0]);
  }
  await visit.close();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const failed = visit.problems.length > 0;
  console.log(`${failed ? 'FAIL' : 'ok  '} ${String(band.width).padStart(4)} · ${label} (${seconds}s; blocked ${visit.blocked.intake} beacons, ${visit.blocked.sentry} Sentry, ${visit.blocked.analytics} analytics)`);
  for (const problem of visit.problems) console.log(`       ${problem}`);
  return { blocked: visit.blocked, failed };
}

async function main() {
  const site = argumentsOf(process.argv);
  console.log(`Smoke against ${site.base} with public roadmap ${site.roadmap}`);
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  for (const band of BANDS) {
    for (const [label, walk] of WALKS) results.push(await runWalk({ browser, band, site, walk, label }));
  }
  results.push(await runWalk({
    browser, band: BANDS.at(-1), site, walk: returningVisitWalk, serviceWorkers: 'allow',
    label: 'a returning visit through the service worker reaches the landing and a room',
  }));
  await browser.close();
  const failures = results.filter((result) => result.failed).length;
  console.log(`${results.length - failures} of ${results.length} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

await main();
