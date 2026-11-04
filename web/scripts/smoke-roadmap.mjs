// The production smoke for the roadmap room: a signed-out reader's walk through the demo, a public roadmap and the landings,
// at phone, tablet and desktop width. It never signs in and never writes, and it blocks the event intake and Sentry at the
// network layer, so it leaves no trace in production analytics.
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
const ANALYTICS_HOSTS = /(^|\.)(sentry\.io|sentry\.invalid|cloudflareinsights\.com)$/;
// The block itself: production's edge injects Cloudflare's script, which reports its emptied body as a failed integrity check.
const BLOCKED_SCRIPT_COMPLAINT = /cloudflareinsights\.com/;
// What a signed-out reader's page answers 4xx to by design. Anything else is a failure.
const EXPECTED_REFUSALS = [
  { path: /^\/v1\/me$/, status: 401 },
];
const WRITE_FRAMES = /"t":"(subgraph|progress)"/;

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
  constructor({ browser, band, site }) {
    this.browser = browser;
    this.band = band;
    this.site = site;
    this.problems = [];
    this.blocked = { intake: 0, analytics: 0 };
  }

  async open() {
    const { width, height, phone } = this.band;
    this.context = await this.browser.newContext({
      viewport: { width, height }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 3 : 1,
      reducedMotion: 'reduce', serviceWorkers: 'block',
    });
    await this.context.route((url) => INTAKE.test(url.pathname) || ANALYTICS_HOSTS.test(url.hostname), (route) => {
      const intake = INTAKE.test(new URL(route.request().url()).pathname);
      this.blocked[intake ? 'intake' : 'analytics'] += 1;
      return route.fulfill({ status: intake ? 202 : 200, contentType: 'application/json', body: '{}' });
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(WAIT_MS);
    this.page.on('pageerror', (error) => this.problems.push(`pageerror: ${error.message}`));
    this.page.on('console', (message) => this.onConsole(message));
    this.page.on('response', (response) => this.onResponse(response));
    this.page.on('requestfailed', (request) => this.onRequestFailed(request));
    this.page.on('request', (request) => this.onRequest(request));
    this.page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
      if (WRITE_FRAMES.test(String(payload))) this.problems.push('wrote over the socket');
    }));
    return this.page;
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

async function demoWalk(page, { band, site }) {
  await page.goto(`${site.base}/#/demo`);
  await identity(page, 'demo', 'tree').waitFor();
  await page.locator('.st-roadmap-sample').waitFor();
  await page.locator('canvas.st-canvas').waitFor();
  await switchToBoard(page, 'demo');
  await openFirstStep(page);
  await closeWithBack(page);
  await reopenWithForward(page);
  await closeWithBack(page);
  await openAndCloseFork(page, band);
}

async function publicRoadmapWalk(page, { site }) {
  await page.goto(`${site.base}/t/${site.roadmap}`);
  await identity(page, 'reader', 'tree').waitFor();
  await switchToBoard(page, 'reader');
  for (const control of ['button[aria-label="New step"]', '.st-board-swipe-complete']) {
    if (await page.locator(control).count()) throw new Error(`a reader's Board offers ${control}`);
  }
  await openFirstStep(page);
  for (const action of ['Complete', 'Edit step', 'Reset']) {
    if (await stepDialog(page).getByRole('button', { name: action, exact: true }).count()) throw new Error(`a reader's step offers ${action}`);
  }
  await closeWithBack(page);
}

async function stepLinkWalk(page, { site }) {
  const reply = await page.request.get(`${site.api}/v1/trees/${site.roadmap}`);
  if (!reply.ok()) throw new Error(`the public roadmap answered ${reply.status()}`);
  const { data, visibility } = await reply.json();
  if (visibility !== 'public') throw new Error(`the roadmap is ${visibility}, not public`);
  const step = data.nodes[0];
  await page.goto(`${site.base}/t/${site.roadmap}#?step=${encodeURIComponent(step.id)}`);
  await stepDialog(page).waitFor();
  if (!(await stepDialog(page).innerText()).includes(step.label)) throw new Error(`the link did not land on "${step.label}"`);
}

function landingWalk(path) {
  return async (page, { site }) => {
    await page.goto(`${site.base}${path}`);
    await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0);
    await page.locator('h1').first().waitFor({ state: 'attached' });
  };
}

const WALKS = [
  ['the demo lands on the Graph, its Board opens a step, Back returns, Fork opens and closes', demoWalk],
  ['a public roadmap lands on the Graph and its Board reads read-only', publicRoadmapWalk],
  ['a step link lands on its step', stepLinkWalk],
  ['/roadmap renders', landingWalk('/roadmap')],
  ['/ renders', landingWalk('/')],
];

async function runWalk({ browser, band, site, walk, label }) {
  const visit = new Visit({ browser, band, site });
  const page = await visit.open();
  const started = Date.now();
  try {
    await walk(page, { band, site });
  } catch (error) {
    visit.problems.push(error.message.split('\n')[0]);
  }
  await visit.close();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const failed = visit.problems.length > 0;
  console.log(`${failed ? 'FAIL' : 'ok  '} ${String(band.width).padStart(4)} · ${label} (${seconds}s; blocked ${visit.blocked.intake} beacons, ${visit.blocked.analytics} analytics)`);
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
  await browser.close();
  const failures = results.filter((result) => result.failed).length;
  console.log(`${results.length - failures} of ${results.length} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

await main();
