// The guide's surfaces in a stand-in room, as the guide's browser tests mount them: the entry on the tree and the note
// it opens, served by Vite from the sources and driven in Chromium and WebKit. `open` mounts the room with the options
// a test gives it, and the reads below are what more than one of those files asks of the page.

import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
export const GUIDE = 'One step a week.\nKinds: Learn, Build.\nA step is done on the water.\nAgents: ask first.';
export const ELSEWHERE = 'Two steps a week until the June trip.\nAgents: ask first.';
export const WORDS = ['week', 'Kinds', 'Learn', 'water', 'Agents', 'June', 'trip', 'Written'];
const entry = `
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/skilltree.css';
import '/src/products/roadmap/board/board.css';
import '/src/products/roadmap/sync/sync-notices.css';
import { GuideEntry } from '/src/products/roadmap/guide/GuideEntry.jsx';
import { GuideNote } from '/src/products/roadmap/guide/GuideNote.jsx';
import { useRoomGuide } from '/src/products/roadmap/guide/useGuide.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { TreeDoor } from '/src/products/roadmap/room/useTreeVisit.js';
const root = createRoot(document.getElementById('root'));
window.mount = (options = {}) => {
  window.writes = [];
  window.entered = [];
  if (options.door === 'device') localStorage.setItem('windmill:device-trees', JSON.stringify({ sail: { title: 'Learn to sail', claimed: false, owner: null } }));
  function Room() {
    const [text, setText] = useState(options.guide ?? '');
    const tree = useMemo(() => new SkillTree({ id: 'sail', title: 'Learn to sail', guide: text, nodes: [] }), [text]);
    const [sessionRef] = useState(() => ({ current: { treeId: 'sail', setGuide: (next) => {
      if (options.door) return false;
      window.writes.push(next);
      setText(next);
      return true;
    } } }));
    window.setElsewhere = setText;
    const [room, setRoom] = useState({ band: options.band ?? 'desktop', owner: options.role !== 'reader', shared: Boolean(options.shared), holder: options.holder ?? null });
    window.setRoom = (next) => setRoom((held) => ({ ...held, ...next }));
    const { band, owner, holder } = room;
    const phone = band === 'phone';
    const who = { owner, reader: !owner, shared: room.shared, demo: false, phone };
    const guide = useRoomGuide({ treeId: 'sail', tree, who, holder, deviceLine: options.device ? { text: 'device' } : null, sessionRef });
    const entry = guide && React.createElement(GuideEntry, { guide, band, view: 'graph' });
    const door = holder ? (treeId, by) => { window.entered.push([treeId, by]); return true; } : null;
    return React.createElement(TreeDoor.Provider, { value: door }, React.createElement('div', { className: 'st-root' },
      React.createElement('button', { type: 'button', id: 'step', style: { position: 'absolute', right: 24, bottom: 24 } }, 'Read the wind'),
      phone
        ? React.createElement('div', { className: 'st-board st-board--phone', style: { paddingTop: 112 } }, entry)
        : React.createElement('div', { className: 'st-graph-guide', style: { top: 64 } }, entry),
      guide?.opened && React.createElement(GuideNote, { guide, band, view: 'graph' })));
  }
  flushSync(() => root.render(React.createElement(Room)));
};
window.entryReady = true;
`;

let server, ready, cacheName;
export let origin;
const browsers = new Map();

// Each file that mounts the room starts its host once, at its top: it names the Vite cache the file optimises into, so
// files running side by side never write into one folder, and closes the browsers and the server once its tests are
// done.
export function hostGuideSurfaces({ cache }) {
  cacheName = cache;
  after(async () => {
    for (const browser of browsers.values()) await browser.close();
    await server?.close();
  });
}

export function start() {
  ready ??= (async () => {
    server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-${cacheName}`,
      plugins: [{ name: 'guide-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/guide-entry.js') return '\0guide-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0guide-beacon';
          if (id.endsWith('/telemetry/sentry.js')) return '\0guide-issues';
        },
        load(id) {
          if (id === '\0guide-entry') return entry;
          if (id === '\0guide-beacon') return beacon;
          if (id === '\0guide-issues') return 'export function captureError(product, operation, stack, route, tags) { (window.issues ??= []).push({ operation, stack: !!stack, ...(tags ? { tags } : {}) }); }';
        },
        configureServer(vite) {
          vite.middlewares.use('/guide-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Guide test</title><div id="root"></div><script type="module" src="/guide-entry.js"></script>');
          });
        },
      }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  })();
  return ready;
}

export async function open(options = {}, { engine = chromium, width = 1440, height = 960, reducedMotion = 'no-preference', permissions = [] } = {}) {
  await start();
  if (!browsers.has(engine)) browsers.set(engine, await engine.launch({ headless: true }));
  const page = await browsers.get(engine).newPage({ viewport: { width, height }, reducedMotion, permissions });
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/guide-test`);
    await page.waitForFunction(() => window.entryReady);
    if (options.mount !== false) await page.evaluate((mounted) => window.mount(mounted), options);
  });
  return page;
}

export const settled = (page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
export const events = (page) => page.evaluate(() => (window.events ?? []).filter(({ name }) => name === 'roadmap_guide').map(({ props }) => props));
export const prose = (page) => page.locator('.st-guide-prose');
export const field = (page) => page.locator('.st-guide-field');
export const caretState = (page) => field(page).evaluate((box) => ({ start: box.selectionStart, end: box.selectionEnd, focused: document.activeElement === box }));
export const focusedName = (page) => page.evaluate(() => document.activeElement.getAttribute('aria-label') ?? document.activeElement.className);
export const stepInert = (page) => page.locator('#step').evaluate((step) => Boolean(step.closest('[inert]')));
export const issues = (page) => page.evaluate(() => window.issues ?? []);
// What the browser reports of its connection, as navigator.onLine says it.
export const browserOnline = (page, online) => page.evaluate((value) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value }), online);

// What the page said, apart from the line a browser writes by itself for a request lost or answered with an error.
export function complaintsOf(page) {
  const said = [];
  page.on('pageerror', (error) => said.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) said.push(message.text());
  });
  return said;
}
