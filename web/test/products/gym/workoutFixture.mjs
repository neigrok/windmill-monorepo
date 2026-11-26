import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { hello } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { beacon } from '../roadmap/browserFixture.js';

// A workout on the web (web-device-parity §4): the real account provider and shell over the browser's own engine, its
// copy seeded with the fixture's routine (Upper A) by an earlier visit, and every `/v1` request the test's to answer or to
// hold. Two pages of one context are two tabs of one browser. The page loads the app's fonts, so a screenshot judges its
// type. Its tests are `workout.browser.test.js` and, for the rest, `workoutRest.browser.test.js`; Coach during a workout
// is `coach/coachDuringWorkout.browser.test.js`.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthProvider from '/src/shell/auth/AuthProvider.jsx';
import { SignInDoorProvider } from '/src/shell/auth/SignInDoor.jsx';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
import { registry } from '/src/platform/sync/schema.js';
import { syncSession } from '/src/platform/sync/session.js';
import { createGymApi } from '/src/products/gym/gymRuntime.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';

// The page's Web Audio and buzz, counted rather than heard, so a test can tell what a rest sounded.
window.sounded = { tones: 0, buzzes: [] };
window.AudioContext = class {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  resume() {}
  createOscillator() { return { frequency: {}, connect: (next) => next, start: () => { window.sounded.tones += 1; }, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (next) => next }; }
};
navigator.vibrate = (ms) => { window.sounded.buzzes.push(ms); return true; };
// Settings' Default rest or Rest sound, changed as its row changes it.
window.restSetting = (change) => createGymApi(syncSession.engine).saveRestSetting(change);

window.seed = async ({ response, rows }) => {
  const timing = { send: { wall: Date.now(), mono: 0, boot: 'seed' }, recv: { wall: Date.now(), mono: 0, boot: 'seed' } };
  const engine = await BrowserSyncEngine.open({ registry, document: null, window: null,
    navigator: { onLine: false, locks: navigator.locks, storage: navigator.storage },
    transport: { request: async () => ({ response, timing }) }, telemetry: { failure() {}, event() {} } });
  await engine.signIn('A');
  await engine.write(null, (device) => {
    rows.forEach((row, index) => device.activeReplica.putConfirmed('self/gym', { ...row, seq: index + 1 }));
    device.activeReplica.cursors['self/gym'] = { ...device.activeReplica.cursorOf('self/gym'), booted: true };
  }, ['self/gym']);
  engine.close();
};
window.drawnSets = () => syncSession.engine.observe('self/gym').getSnapshot().drawn.filter((record) => record.t === 'set' && record.life?.[0] !== 'dead');
window.engineOpen = () => Boolean(syncSession.engine);
// This tab's engine writes wait until releaseCommits(), so a test can order two tabs' writes.
window.holdCommits = () => {
  const engine = syncSession.engine;
  const commit = engine.commit;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  engine.commit = async (...args) => { await held; return commit.apply(engine, args); };
  window.releaseCommits = () => { engine.commit = commit; release(); };
};
// This tab's next \`count\` rack settles, a write of device rows alone that names an offer, throw as a bug would.
window.failSettles = (count) => {
  const engine = syncSession.engine;
  const commit = engine.commit.bind(engine);
  engine.commit = (scope, body, ...rest) => commit(scope, typeof body !== 'function' ? body : (views) => {
    const decided = body(views);
    const gesture = decided?.gesture;
    const settles = gesture && gesture.changes.length === 0 && Object.keys(gesture.opts?.local ?? {}).some((key) => key.startsWith('offer:'));
    if (settles && count > 0) { count -= 1; throw new Error('the settle broke'); }
    return decided;
  }, ...rest);
};
// The room follows the address as the app's navigation does: a screen that moves sets the hash.
function Room() {
  const [hash, setHash] = React.useState(window.location.hash);
  React.useEffect(() => {
    const moved = () => setHash(window.location.hash);
    window.addEventListener('hashchange', moved);
    return () => window.removeEventListener('hashchange', moved);
  }, []);
  return React.createElement(Shell, { location: { pathname: '/app/gym', hash, search: '' } });
}
window.mount = () => {
  createRoot(document.getElementById('root')).render(React.createElement(AuthProvider, null,
    React.createElement(SignInDoorProvider, null, React.createElement(Room))));
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-gym-live-test`,
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
    plugins: [{ name: 'gym-live-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/gym-live-entry.js') return '\0gym-live-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0gym-live-events';
        if (id.endsWith('/telemetry/sentry.js')) return '\0gym-live-issues';
      },
      load(id) {
        if (id === '\0gym-live-entry') return entry;
        if (id === '\0gym-live-events') return beacon;
        if (id === '\0gym-live-issues') return 'export function captureError(product, operation) { (window.issues ??= []).push(operation); }';
      },
      configureServer(vite) {
        vite.middlewares.use('/gym-live', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Windmill</title><link rel="icon" href="/favicon.svg" type="image/svg+xml" /><div id="root"></div><script type="module" src="/gym-live-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'react-dom', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

export const stamp = '1:0:srv';
export const entries = [
  { exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 100 }, { reps: 5, weightKg: 100 }], restSeconds: 180 },
  { exerciseId: 'dumbbell-bench-press', sets: [{ reps: 8, weightKg: 16 }, { reps: 8, weightKg: 16 }, { reps: 8, weightKg: 16 }], restSeconds: 120 },
  { exerciseId: 'pull-up', sets: [{ reps: 8, weightKg: 10 }, { reps: 8, weightKg: 10 }, { reps: 8, weightKg: 10 }], restSeconds: 120 },
];

// A browser whose copy holds Upper A, signed in as A; `/v1/sync/push` is held unless `pushes` collects it.
export async function browserWith(t, { width = 1440, height = 1000, pushes = null, rows = [], colorScheme = 'light' } = {}) {
  await ready;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme });
  context.setDefaultTimeout(20000);
  t.after(() => context.close());
  await context.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/me') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":{"id":"A","name":"Ann"}}' });
    if (path === '/v1/sync/hello') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(hello({ state: ServerState.empty({ epoch: 'gym-live', accounts: { A: { name: 'A' } } }), registry, account: 'A', serverTime: Date.now() }).body) });
    }
    if (path === '/v1/sync/push' && pushes) pushes.push(route.request().postData() ?? '');
    return undefined;
  });
  const first = await context.newPage();
  await first.goto(`${origin}/gym-live#/gym`);
  await first.waitForFunction(() => window.entryReady);
  await first.evaluate((seed) => window.seed(seed), {
    response: hello({ state: ServerState.empty({ epoch: 'gym-live', accounts: { A: { name: 'A' } } }), registry, account: 'A', serverTime: Date.now() }),
    rows: [{ t: 'routine', id: 'routineUpperA', born: stamp, life: ['alive', stamp],
      f: { name: ['Upper A', stamp], position: [0, stamp], entries: [entries, stamp] } }, ...rows],
  });
  await first.close();
  const tab = async (hash = '#/gym') => {
    const page = await context.newPage();
    await page.goto(`${origin}/gym-live${hash}`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate((at) => window.mount(at), hash);
    return page;
  };
  return { context, tab };
}

export const ledger = (page) => page.locator('.gym-live-row.is-logged .gym-live-reading').allTextContents();
export const loggable = (page) => page.locator('.gym-live-rack button[type="submit"]:not([aria-disabled="true"])').waitFor();
export const steps = (page, name) => page.evaluate((wanted) => (window.events ?? []).filter((event) => event.name === wanted).map((event) => event.props), name);
export const engineOpen = (page) => page.waitForFunction(() => window.engineOpen());
export const said = (page) => page.locator('.gym-toast-slot').textContent();
