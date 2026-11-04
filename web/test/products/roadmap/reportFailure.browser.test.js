import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon } from './browserFixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/skilltree.css';
import { BrowsePage } from '/src/products/roadmap/browse/BrowsePage.jsx';
import { TreeSwitcher } from '/src/products/roadmap/identity/TreeSwitcher.jsx';
import { NewTreeBirth } from '/src/products/roadmap/paste/NewTreeBirth.jsx';
import { renameTree, deleteTree } from '/src/products/roadmap/persistence/TreeRegistry.js';
import { QuestShelf } from '/src/products/roadmap/quests/QuestShelf.jsx';
import { YourDataSection } from '/src/products/roadmap/settings/YourDataSection.jsx';
import { fetchTending, startTend, fetchRun } from '/src/products/roadmap/tending/tendingClient.js';
import { BoundaryFailure, reportRoadmapFailure, reportUnexpectedFailure } from '/src/products/roadmap/reportFailure.js';
const rows = [{ id: 't_a', title: 'Learn to sail', done: 3, total: 8, dominantKind: 'sky', origin: 'server' }, { id: 't_b', title: 'Bake bread', done: 0, total: 2, dominantKind: 'olive', origin: 'server' }];
const doors = {
  browse: () => React.createElement(BrowsePage),
  switcher: () => React.createElement(TreeSwitcher, {
    current: rows[0], listTrees: async () => rows, onNew() {},
    onRename: (id, title) => renameTree(id, title), onDelete: (id) => deleteTree(id), onPreviewTitle() {},
  }),
  birth: () => React.createElement(NewTreeBirth),
  quests: () => React.createElement(QuestShelf),
  data: () => React.createElement(YourDataSection),
};
window.issues = [];
window.events = [];
window.mount = (door) => createRoot(document.getElementById('fixture')).render(doors[door]());
window.tend = { fetchTending, startTend, fetchRun };
window.reporting = { BoundaryFailure, reportRoadmapFailure, reportUnexpectedFailure };
window.entryReady = true;
`;
const auth = `
const signedIn = { status: 'signed-in', user: { id: 'u_1', email: 'a@example.com' }, account: null, refresh: async () => {} };
export const useAuth = () => signedIn;
export const AuthProvider = ({ children }) => children;
`;
let server, browser, origin, ready;
function start() {
  ready ??= (async () => {
    server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-report-failure-test`,
      plugins: [{ name: 'report-failure-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/report-failure-entry.js') return '\0report-failure-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0report-failure-beacon';
          if (id.endsWith('/telemetry/sentry.js')) return '\0report-failure-sentry';
          if (id.endsWith('/auth/AuthProvider.jsx')) return '\0report-failure-auth';
        },
        load(id) {
          if (id === '\0report-failure-entry') return entry;
          if (id === '\0report-failure-beacon') return beacon;
          if (id === '\0report-failure-auth') return auth;
          if (id === '\0report-failure-sentry') return 'export function captureError(kind, operation, stack, route) { window.issues.push({ operation, route }); }';
        },
        configureServer(vite) {
          vite.middlewares.use('/report-failure-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="fixture"></div><script type="module" src="/report-failure-entry.js"></script>');
          });
        },
      }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
      server: { host: '127.0.0.1', port: 0 } });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  return ready;
}
after(async () => { await browser?.close(); await server?.close(); });

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

// One fresh page holding `door`, with every API path answered by `answers`: { 'POST /v1/x': reply }, a reply being fulfil
// options, 'abort', or a function of the route.
async function withDoor(door, answers, run) {
  await start();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.route(/\/v1\//, (route) => {
    const request = route.request();
    const answer = answers[`${request.method()} ${new URL(request.url()).pathname}`];
    if (answer === undefined) return route.fulfill(json({ error: 'unexpected' }, 404));
    if (answer === 'abort') return route.abort('failed');
    if (typeof answer === 'function') return answer(route);
    return route.fulfill(answer);
  });
  try {
    await page.goto(`${origin}/report-failure-test`);
    await page.waitForFunction(() => window.entryReady);
    if (door) await page.evaluate((name) => window.mount(name), door);
    await run(page);
    assert.deepEqual(failures, []);
  } finally {
    await context.close();
  }
}

const said = (page) => page.evaluate(() => ({ issues: window.issues, events: window.events }));

const GALLERY = json({ count: 1, entries: [{ id: 't_g', title: 'Learn to sail', done: 1, total: 3, dominantKind: 'sky', forks: 2, updatedAt: 1700000000000 }], nextCursor: '' });

for (const [answer, issues, outcome] of [
  [json({ error: 'boom' }, 500), [{ operation: 'roadmap-fork', route: '#/app' }], 'failed'],
  ['abort', [{ operation: 'roadmap-fork', route: '#/app' }], 'failed'],
  [json({ error: 'nope' }, 403), [], 'failed'],
  [json({ error: 'expired' }, 401), [], 'unauthenticated'],
]) {
  test(`a gallery Fork answered ${answer.status ?? answer} reports ${issues.length} and emits ${outcome}`, async () => {
    await withDoor('browse', { 'GET /v1/gallery': GALLERY, 'POST /v1/trees/t_g/fork': answer }, async (page) => {
      await page.getByRole('button', { name: /Fork/ }).first().click();
      await page.waitForFunction(() => window.events.some((event) => event.props?.outcome));
      assert.deepEqual(await said(page), {
        issues,
        events: [
          { name: 'fork_attempt', props: { mode: 'browse' } },
          { name: 'fork_attempt', props: { mode: 'browse', outcome } },
        ],
      });
    });
  });
}

async function openSwitcher(page) {
  await page.locator('#fixture [aria-haspopup="menu"]').click();
  await page.getByRole('menu').waitFor();
  await page.getByRole('menuitem').first().hover();
}

async function renameFirst(page, title) {
  await openSwitcher(page);
  await page.getByRole('button', { name: 'Rename Learn to sail' }).click();
  await page.getByRole('textbox', { name: 'Tree name' }).fill(title);
  await page.keyboard.press('Enter');
}

test("the switcher's rename event fires once the server took the new name, and not before", async () => {
  let answer;
  const held = new Promise((resolve) => { answer = resolve; });
  await withDoor('switcher', { 'PATCH /v1/trees/t_a': async (route) => { await held; return route.fulfill({ status: 204 }); } }, async (page) => {
    await renameFirst(page, 'Sail far');
    const renames = () => page.evaluate(() => window.events.filter((event) => event.props?.step === 'rename'));
    await page.getByRole('textbox', { name: 'Tree name' }).waitFor({ state: 'detached' });
    assert.deepEqual(await renames(), []);
    answer();
    await page.waitForFunction(() => window.events.some((event) => event.props?.step === 'rename'));
    assert.deepEqual(await said(page), {
      issues: [],
      events: [{ name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } }, { name: 'roadmap_sheet', props: { step: 'rename', door: 'switcher' } }],
    });
  });
});

for (const [verb, act] of [
  ['rename', (page) => renameFirst(page, 'Sail far')],
  ['delete', async (page) => {
    await openSwitcher(page);
    await page.getByRole('button', { name: 'Delete Learn to sail' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
  }],
]) {
  const method = verb === 'rename' ? 'PATCH' : 'DELETE';
  for (const [answer, issues] of [
    [json({ error: 'boom' }, 500), [{ operation: `roadmap-switcher-${verb}`, route: '#/app' }]],
    ['abort', [{ operation: `roadmap-switcher-${verb}`, route: '#/app' }]],
    [json({ error: 'nope' }, 403), []],
  ]) {
    test(`the switcher's ${verb} answered ${answer.status ?? answer} reports ${issues.length} and emits its failure`, async () => {
      await withDoor('switcher', { [`${method} /v1/trees/t_a`]: answer, 'GET /v1/trees': json({ trees: [] }) }, async (page) => {
        await act(page);
        await page.waitForFunction(() => window.events.some((event) => event.props?.outcome));
        assert.deepEqual(await said(page), {
          issues,
          events: [
            { name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } },
            { name: 'roadmap_sheet', props: { step: verb, door: 'switcher', outcome: 'failed' } },
          ],
        });
      });
    });
  }
}

test("Plant wears its style wherever the composer stands", async () => {
  await withDoor('birth', {}, async (page) => {
    await page.getByRole('button', { name: 'paste a plan' }).click();
    const plant = page.locator('.pc-plant');
    await plant.waitFor();
    assert.deepEqual(await plant.evaluate((button) => {
      const style = getComputedStyle(button);
      return { padding: style.padding, radius: style.borderRadius !== '0px', font: style.fontWeight, border: style.borderStyle };
    }), { padding: '10px 20px', radius: true, font: '800', border: 'none' });
  });
});

test('a blank plant the server fails reports roadmap-plant, emits its failure and shows its error face', async () => {
  await withDoor('birth', { 'POST /v1/trees': json({ error: 'boom' }, 500) }, async (page) => {
    await page.getByRole('textbox', { name: 'Name your roadmap' }).fill('Learn to sail');
    await page.keyboard.press('Enter');
    await page.getByText('Couldn’t plant it just now').waitFor();
    assert.deepEqual(await said(page), {
      issues: [{ operation: 'roadmap-plant', route: '#/app' }],
      events: [{ name: 'roadmap_board_create', props: { step: 'failed', door: 'blank' } }],
    });
  });
});

test('a pasted plan the server fails reports roadmap-plant and emits its failure', async () => {
  await withDoor('birth', { 'POST /v1/trees': json({ error: 'boom' }, 500) }, async (page) => {
    await page.getByRole('button', { name: 'paste a plan' }).click();
    await page.locator('.pc textarea').first().fill('# Sail\n- Rig the boat\n- Read the wind');
    await page.locator('.pc-plant').click();
    await page.getByText('Couldn’t plant it just now').waitFor();
    assert.deepEqual(await said(page), {
      issues: [{ operation: 'roadmap-plant', route: '#/app' }],
      events: [{ name: 'roadmap_board_create', props: { step: 'failed', door: 'import' } }],
    });
  });
});

test('a quest plant the server fails reports roadmap-plant and emits its failure', async () => {
  await withDoor('quests', { 'POST /v1/trees': json({ error: 'boom' }, 500) }, async (page) => {
    await page.locator('.quest-card').first().click();
    await page.waitForFunction(() => window.events.length > 0, undefined, { timeout: 20000 });
    assert.deepEqual(await said(page), {
      issues: [{ operation: 'roadmap-plant', route: '#/app' }],
      events: [{ name: 'roadmap_board_create', props: { step: 'failed', door: 'quest' } }],
    });
  });
});

test('Ask AI reports a failed or lost request and an unreadable answer under one name, never a refusal', async () => {
  const cases = [
    [json({ error: 'boom' }, 500), 1],
    ['abort', 1],
    [{ status: 200, contentType: 'text/html', body: '<!doctype html>' }, 1],
    [json({ error: 'slow down' }, 429), 0],
  ];
  for (const [answer, reported] of cases) {
    await withDoor(null, { 'POST /v1/trees/t_a/tend': answer }, async (page) => {
      assert.equal(await page.evaluate(() => window.tend.startTend('t_a', 'Add a step')), null);
      assert.deepEqual(await said(page), { issues: Array(reported).fill({ operation: 'roadmap-tend', route: '#/app' }), events: [] });
    });
  }
  await withDoor(null, { 'POST /v1/trees/t_a/tend': json({ runId: 'r_1' }, 202) }, async (page) => {
    assert.deepEqual(await page.evaluate(() => window.tend.startTend('t_a', 'Add a step')), { runId: 'r_1' });
    assert.deepEqual(await said(page), { issues: [], events: [] });
  });
});

const TWO_ROADMAPS = json({ trees: [{ id: 't_a', title: 'Learn to sail', updatedAt: 2 }, { id: 't_b', title: 'Bake bread', updatedAt: 1 }] });
const TREE_B = json({ data: { id: 't_b', title: 'Bake bread', nodes: [{ id: 'n', label: 'Knead', prerequisites: [] }], kinds: [] }, visibility: 'private', mine: true });
const exportAnswers = (treeA, progressB = json({ marks: [] })) => ({
  'GET /v1/me': json({ error: 'nope' }, 401),
  'GET /v1/trees': TWO_ROADMAPS,
  'GET /v1/trees/t_a': treeA,
  'GET /v1/trees/t_a/progress': json({ marks: [] }),
  'GET /v1/trees/t_b': TREE_B,
  'GET /v1/trees/t_b/progress': progressB,
});

async function exportAll(page) {
  await page.evaluate(() => {
    window.downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function clicked() { if (this.download) window.downloads.push(this.download); else click.call(this); };
  });
  await page.getByRole('button', { name: 'Export my trees' }).click();
  await page.waitForFunction(() => window.events.length > 0);
  return page.evaluate(() => ({
    note: document.querySelector('#fixture p')?.textContent, downloads: window.downloads, issues: window.issues, events: window.events,
  }));
}

test('Export all with one roadmap failing says how many it got, reports it, and downloads the rest', async () => {
  await withDoor('data', exportAnswers(json({ error: 'boom' }, 500)), async (page) => {
    assert.deepEqual(await exportAll(page), {
      note: 'Exported 1 of 2 roadmaps.',
      downloads: ['windmill-export.zip'],
      issues: [{ operation: 'roadmap-export-load', route: '#/settings' }],
      events: [{ name: 'roadmap_export', props: { outcome: 'partial', door: 'settings' } }],
    });
  });
});

test("Export all keeps a roadmap out of the zip rather than export it with marks it couldn't read", async () => {
  await withDoor('data', exportAnswers(TREE_B, json({ error: 'boom' }, 500)), async (page) => {
    const { note, issues, events } = await exportAll(page);
    assert.deepEqual({ note, issues, events }, {
      note: 'Exported 1 of 2 roadmaps.',
      issues: [{ operation: 'roadmap-export-load', route: '#/settings' }],
      events: [{ name: 'roadmap_export', props: { outcome: 'partial', door: 'settings' } }],
    });
  });
});

test('Export all with every roadmap failing downloads nothing and says it failed', async () => {
  await withDoor('data', { ...exportAnswers(json({ error: 'boom' }, 500)), 'GET /v1/trees/t_b': json({ error: 'boom' }, 500) }, async (page) => {
    assert.deepEqual(await exportAll(page), {
      note: "Couldn't build your export just now — try again.",
      downloads: [],
      issues: [{ operation: 'roadmap-export-load', route: '#/settings' }, { operation: 'roadmap-export-load', route: '#/settings' }],
      events: [{ name: 'roadmap_export', props: { outcome: 'failed', door: 'settings' } }],
    });
  });
});

test('Export all whose download is refused reports roadmap-export and says it failed', async () => {
  await withDoor('data', exportAnswers(TREE_B), async (page) => {
    await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('refused'); }; });
    const { note, issues, events } = await exportAll(page);
    assert.deepEqual({ note, issues, events }, {
      note: "Couldn't build your export just now — try again.",
      issues: [{ operation: 'roadmap-export', route: '#/settings' }],
      events: [{ name: 'roadmap_export', props: { outcome: 'failed', door: 'settings' } }],
    });
  });
});

test('a lost request reports only while someone is watching; a refusal, a browser refusing storage and a judged failure never do', async () => {
  await withDoor(null, {}, async (page) => {
    const reported = await page.evaluate(() => {
      const { BoundaryFailure, reportRoadmapFailure, reportUnexpectedFailure } = window.reporting;
      const lands = (failure, { hidden = false, offline = false } = {}) => {
        Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
        Object.defineProperty(navigator, 'onLine', { value: !offline, configurable: true });
        window.issues.length = 0;
        reportUnexpectedFailure('roadmap-share', failure);
        return window.issues.length;
      };
      const judged = () => {
        window.issues.length = 0;
        reportRoadmapFailure('roadmap-load', new BoundaryFailure('read failed'));
        return window.issues.length;
      };
      return {
        serverFailure: lands({ status: 500 }),
        refusal: lands({ status: 403 }),
        lostWatched: lands({ status: 0 }),
        lostHidden: lands({ status: 0 }, { hidden: true }),
        lostOffline: lands({ status: 0 }, { offline: true }),
        anyOtherException: lands(new TypeError('boom')),
        storageSecurity: lands(new DOMException('no', 'SecurityError')),
        storageQuota: lands(new DOMException('no', 'QuotaExceededError')),
        judged: judged(),
      };
    });
    assert.deepEqual(reported, {
      serverFailure: 1, refusal: 0, lostWatched: 1, lostHidden: 0, lostOffline: 0, anyOtherException: 1, storageSecurity: 0, storageQuota: 0, judged: 0,
    });
  });
});
