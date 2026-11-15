import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// The mic in a journal room of its own, with the account, the plan, telemetry and the microphone faked at their seams
// and every server door answered by the test. The recorder hands over a real, decodable recording.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/journal/journal.css';
import { TalkButton } from '/src/products/journal/talk/TalkButton.jsx';
window.written = [];
window.signInDoors = 0;
// Under StrictMode, as main.jsx renders the app: every effect mounts, unmounts and mounts again. Leaving the room
// renders another in its place, as the app's own navigation does.
const journal = (theme) => React.createElement(React.StrictMode, null,
  React.createElement('div', { className: 'journal-root', 'data-theme': theme, 'data-brand': 'journal' },
    React.createElement('div', { className: 'journal-tools' },
      React.createElement(TalkButton, {
        onTranscript: (text) => window.written.push(text),
        onNeedSignIn: () => { window.signInDoors += 1; },
      }))));
let reactRoot;
window.mount = (theme) => { reactRoot = createRoot(document.getElementById('fixture')); reactRoot.render(journal(theme)); };
window.leaveRoom = () => reactRoot.render(React.createElement('p', null, 'gym room'));
window.backToRoom = (theme) => reactRoot.render(journal(theme));
`;
const auth = `
import { useSyncExternalStore } from 'react';
const listeners = new Set();
window.authRefreshes = 0;
window.recheckFinds = null;
window.account = { status: 'signed-in', user: { id: 'u_1' },
  refresh: async () => { window.authRefreshes += 1; return window.recheckFinds; } };
window.signIn = (status) => { window.account = { ...window.account, status }; listeners.forEach((listener) => listener()); };
export const useAuth = () => useSyncExternalStore(
  (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => window.account);
`;
const entitlements = `
window.refreshes = 0;
const plan = { loading: false, windmillOne: true, refresh: async () => { window.refreshes += 1; } };
export const useEntitlements = () => plan;
`;
const beacon = `
export function track(name, props) { window.events.push({ name, props }); }
export function reportError(error) { window.issues.push({ operation: 'client-error', tags: { error: String(error) } }); }
export function routeFamily() { return '/app/journal'; }
`;
const sentry = 'export function captureError(kind, operation, stack, route, tags) { window.issues.push({ operation, tags }); }';

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-talk-test`,
    plugins: [{ name: 'talk-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/talk-entry.js') return '\0talk-entry';
        if (id.endsWith('/auth/AuthProvider.jsx')) return '\0talk-auth';
        if (id.endsWith('/billing/EntitlementsProvider.jsx')) return '\0talk-entitlements';
        if (id.endsWith('/telemetry/beacon.js')) return '\0talk-beacon';
        if (id.endsWith('/telemetry/sentry.js')) return '\0talk-sentry';
      },
      load(id) {
        return { '\0talk-entry': entry, '\0talk-auth': auth, '\0talk-entitlements': entitlements,
          '\0talk-beacon': beacon, '\0talk-sentry': sentry }[id];
      },
      configureServer(vite) {
        vite.middlewares.use('/talk-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="fixture"></div><script type="module" src="/talk-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0 } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { await ready; await browser?.close(); await server?.close(); });

// A microphone and recorder the test drives: a press opens the one, a second press stops the other, and the take is a
// two-second WAV whose loudness rises and falls.
function fakeMicrophone() {
  window.events = [];
  window.issues = [];
  window.microphones = 0;
  window.released = 0;
  const rate = 8000;
  const samples = rate * 2;
  const bytes = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at, word) => [...word].forEach((letter, index) => bytes.setUint8(at + index, letter.charCodeAt(0)));
  text(0, 'RIFF'); bytes.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true); bytes.setUint32(24, rate, true);
  bytes.setUint32(28, rate * 2, true); bytes.setUint16(32, 2, true); bytes.setUint16(34, 16, true); text(36, 'data');
  bytes.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const swell = Math.abs(Math.sin((index / samples) * Math.PI * 5));
    bytes.setInt16(44 + index * 2, Math.round(Math.sin((index / rate) * 2 * Math.PI * 220) * swell * 20000), true);
  }
  window.recording = new Blob([bytes.buffer], { type: 'audio/webm' });
  // `window.holdMicrophone` keeps the browser's own question open until `window.grantMicrophone()`.
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => {
      window.microphones += 1;
      if (window.holdMicrophone) await new Promise((resolve) => { window.grantMicrophone = resolve; });
      return { getTracks: () => [{ stop() { window.released += 1; } }] };
    },
  } });
  window.MediaRecorder = class {
    static isTypeSupported(mime) { return mime === 'audio/webm'; }
    constructor(_stream, options) { this.mimeType = options?.mimeType ?? ''; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() {
      if (this.state !== 'recording') return;
      this.state = 'inactive';
      this.ondataavailable({ data: window.recording });
      this.onstop();
    }
  };
}

const read = (code, { reserved = '0.000000000', remaining = '0.000000000', resetsAtMs = Date.UTC(2026, 11, 3, 9, 14) } = {}) => ({
  code, currency: 'USD', period: 'billing_period', tier: 'windmill_one', configured: true, limit: '7.000000000',
  used: '7.000000000', reserved, remaining, resetsAtMs, budgetResetsAtMs: resetsAtMs, status: code === 'ok' ? 'available' : 'exhausted',
});
const spent = { status: 429, body: { code: 'subject_exhausted', reason: 'allowance_exhausted',
  error: 'your AI allowance is fully used or reserved', allowance: read('subject_exhausted') } };
const renewing = { windmillOne: true, environment: 'production', allowlisted: false, plan: 'windmill_one',
  accessUntil: Date.UTC(2026, 11, 4), governing: { autoRenew: true }, others: [], manage: null, purchasable: [],
  offer: null };

// A room whose server answers each take from `takes`, in order — an answer, 'unreachable', or a function the route is
// handed — the allowance read with `allowance` and the plan with `plan`. Time stands still until the test moves it.
async function room(t, { theme = 'dark', allowance = read('ok', { remaining: '6.000000000' }), plan = renewing, takes = [], reads = null } = {}) {
  await ready;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC', locale: 'en-US' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sent = [];
  await page.addInitScript(fakeMicrophone);
  await page.clock.install({ time: Date.UTC(2026, 10, 15, 14, 0) });
  await page.clock.pauseAt(Date.UTC(2026, 10, 15, 14, 2));
  await page.route(/\/v1\/ai\/allowance$/, async (route) => {
    await reads;
    await route.fulfill({ status: allowance ? 200 : 503,
      json: allowance ?? { code: 'ai_allowance_disabled', error: 'AI allowances are not enabled.' } });
  });
  await page.route(/\/v1\/subscription$/, (route) => route.fulfill({ status: 200, json: plan }));
  await page.route(/\/v1\/journal\/transcribe$/, async (route) => {
    sent.push({ type: route.request().headers()['content-type'], bytes: route.request().postDataBuffer()?.length ?? 0 });
    const answer = takes.shift();
    if (answer === 'unreachable') return route.abort('internetdisconnected');
    if (typeof answer === 'function') return answer(route);
    return route.fulfill({ status: answer.status, json: answer.body });
  });
  await page.goto(`${origin}/talk-test`);
  // The page's own timers stand still with its clock, so the entry is awaited as a module rather than polled for.
  await page.evaluate(async (value) => { await import('/talk-entry.js'); window.mount(value); }, theme);
  const mic = page.locator('.journal-talk-tool');
  await mic.waitFor();
  return {
    page, mic, sent, errors,
    sheet: page.locator('.journal-talk-sheet'),
    // One take of `seconds`, pressed in and pressed out.
    talk: async (seconds = 102) => {
      await mic.click();
      await page.locator('.journal-talk-tool.is-recording').waitFor();
      await page.clock.runFor(seconds * 1000);
      await mic.click();
    },
    events: () => page.evaluate(() => window.events),
    focused: () => page.evaluate(() => {
      const element = document.activeElement;
      return element === document.body ? 'body' : element.getAttribute('aria-label') ?? element.textContent;
    }),
    issues: () => page.evaluate(() => window.issues),
    shown: () => page.evaluate(() => ({
      state: document.querySelector('.journal-talk-state')?.textContent ?? null,
      detail: document.querySelector('.journal-talk-detail')?.textContent ?? null,
      take: document.querySelector('.journal-talk-length')?.textContent ?? null,
      kept: document.querySelector('.journal-talk-kept')?.textContent ?? null,
      acts: [...document.querySelectorAll('.journal-talk-act')].map((act) => act.textContent),
      undo: document.querySelector('.journal-talk-undo')?.textContent ?? null,
    })),
    guarded: () => page.evaluate(() => {
      const leaving = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(leaving);
      return leaving.defaultPrevented;
    }),
  };
}

// The page's own ICU decides the space before the day half (a narrow no-break one since ICU 72).
const twelve = (talk, clock) => talk.page.evaluate((shown) => shown.replace(' ',
  new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h12' }).format(0).replace(/\d/g, '').slice(0, 1)), clock);

test('a spent allowance keeps the take in the sheet, behind the dot, and through × with Undo; then holds the mic shut', async (t) => {
  const talk = await room(t, { takes: [spent] });

  await talk.talk();
  await talk.page.locator('.journal-talk-take').waitFor();

  assert.deepEqual(await talk.shown(), {
    state: 'You have used all of your AI allowance.',
    detail: `You can use Talk again on Dec 3 at ${await twelve(talk, '9:14 AM')}.`,
    take: '1:42',
    kept: 'Held in this tab only.',
    acts: ['Download recording', 'Close'],
    undo: null,
  });
  assert.deepEqual(talk.sent, [{ type: 'audio/webm', bytes: 32044 }]);
  const download = talk.page.locator('a.journal-talk-act');
  assert.equal(await download.getAttribute('download'), 'talk-2026-11-15-1402.webm');
  assert.match(await download.getAttribute('href'), /^blob:/);
  const bars = await talk.page.locator('.journal-talk-wave span').evaluateAll((spans) => spans.map((span) => span.offsetHeight));
  assert.deepEqual(bars, Array(5).fill([8, 15, 18, 15, 8]).flat(), 'the waveform is the take’s own five swells');
  assert.equal(await talk.guarded(), true, 'leaving the page asks first while a take is held');

  await download.click();
  await talk.page.getByRole('button', { name: 'Close' }).click();
  assert.equal(await talk.sheet.count(), 0);
  assert.equal(await talk.mic.getAttribute('aria-label'), 'Talk — a recording is waiting');
  assert.equal(await talk.page.locator('.journal-talk-tool.has-take').count(), 1);

  await talk.mic.click();
  assert.equal((await talk.shown()).take, '1:42', 'the next press reopens the kept take, not a new recording');
  assert.equal(await talk.page.locator('.journal-talk-tool.has-take').count(), 0);

  await talk.page.getByRole('button', { name: 'Discard recording' }).click();
  assert.deepEqual(await talk.shown(), {
    state: 'You have used all of your AI allowance.',
    detail: `You can use Talk again on Dec 3 at ${await twelve(talk, '9:14 AM')}.`,
    take: null, kept: null, acts: ['Close'], undo: 'Recording discarded · Undo',
  });
  await talk.page.getByRole('button', { name: 'Undo' }).click();
  assert.equal((await talk.shown()).take, '1:42');

  await talk.page.getByRole('button', { name: 'Discard recording' }).click();
  await talk.page.clock.runFor(6000);
  assert.equal((await talk.shown()).undo, null);
  assert.equal(await talk.guarded(), false, 'a discarded take no longer holds the page');
  await talk.page.getByRole('button', { name: 'Close' }).click();
  assert.equal(await talk.page.locator('.journal-talk-tool.has-take').count(), 0);

  await talk.mic.click();
  assert.deepEqual(await talk.shown(), {
    state: 'You have used all of your AI allowance.',
    detail: `You can use Talk again on Dec 3 at ${await twelve(talk, '9:14 AM')}.`,
    take: null, kept: null, acts: ['Close'], undo: null,
  });
  assert.equal(await talk.page.evaluate(() => window.microphones), 1, 'the remembered refusal opens no microphone');
  assert.deepEqual(await talk.events(), [
    { name: 'journal_talk_refused', props: { code: 'subject_exhausted', reason: 'allowance_exhausted', moment: 'take' } },
    { name: 'journal_talk_take', props: { action: 'download' } },
    { name: 'journal_talk_take', props: { action: 'close' } },
    { name: 'journal_talk_take', props: { action: 'discard' } },
    { name: 'journal_talk_take', props: { action: 'undo' } },
    { name: 'journal_talk_take', props: { action: 'discard' } },
    { name: 'journal_talk_refused', props: { code: 'subject_exhausted', reason: 'allowance_exhausted', moment: 'remembered' } },
  ]);
  assert.deepEqual(await talk.issues(), []);
  assert.deepEqual(talk.errors, []);
});

test('an allowance read that is spent says so before any take, and a plan that ends names no date', async (t) => {
  const talk = await room(t, { allowance: read('subject_exhausted'), plan: { ...renewing, governing: { autoRenew: false } } });

  await talk.mic.click();
  await talk.page.locator('.journal-talk-refused').waitFor();

  assert.deepEqual(await talk.shown(), {
    state: 'You have used all of your AI allowance.', detail: null, take: null, kept: null, acts: ['Close'], undo: null,
  });
  assert.equal(await talk.page.evaluate(() => window.microphones), 0);
  assert.deepEqual(talk.sent, []);
  assert.deepEqual(await talk.events(), [
    { name: 'journal_talk_refused', props: { code: 'subject_exhausted', reason: 'allowance_exhausted', moment: 'before_take' } },
  ]);
});

test('an allowance held or busy offers Try again, which sends the kept take once more and writes it down', async (t) => {
  const held = { status: 429, body: { code: 'subject_exhausted', reason: 'allowance_exhausted',
    error: 'your AI allowance is fully used or reserved', allowance: read('subject_exhausted', { reserved: '0.060000000' }) } };
  const busy = { status: 503, body: { code: 'concurrency_exhausted', reason: 'unavailable', error: 'busy',
    allowance: read('concurrency_exhausted') } };
  const talk = await room(t, { allowance: null, takes: [held, busy, { status: 200, body: { text: ' rain all morning ' } }] });

  await talk.talk(12);
  await talk.page.locator('.journal-talk-take').waitFor();
  assert.deepEqual(await talk.shown(), {
    state: 'The rest of your AI allowance is held by an earlier request whose cost is not yet confirmed.',
    detail: 'It frees when that request’s cost is confirmed, at most 10 minutes after it began.', take: '0:12',
    kept: 'Held in this tab only.', acts: ['Try again', 'Download recording'], undo: null,
  });

  await talk.page.getByRole('button', { name: 'Try again' }).click();
  await talk.page.locator('.journal-talk-state', { hasText: 'every slot' }).waitFor();
  assert.deepEqual(await talk.shown(), {
    state: 'Your earlier AI requests hold every slot you have.',
    detail: 'Each frees when its cost is confirmed, at most 10 minutes after it began.', take: '0:12',
    kept: 'Held in this tab only.', acts: ['Try again', 'Download recording'], undo: null,
  });

  await talk.page.getByRole('button', { name: 'Try again' }).click();
  await talk.sheet.waitFor({ state: 'detached' });

  assert.deepEqual(await talk.page.evaluate(() => window.written), ['rain all morning']);
  assert.deepEqual(talk.sent, Array(3).fill({ type: 'audio/webm', bytes: 32044 }));
  assert.equal(await talk.guarded(), false);
  assert.equal(await talk.page.locator('.journal-talk-tool.has-take').count(), 0);
  assert.deepEqual(await talk.events(), [
    { name: 'journal_talk_refused', props: { code: 'subject_exhausted', reason: 'held', moment: 'take' } },
    { name: 'journal_talk_take', props: { action: 'retry' } },
    { name: 'journal_talk_refused', props: { code: 'concurrency_exhausted', reason: 'unavailable', moment: 'take' } },
    { name: 'journal_talk_retry', props: { outcome: 'refused' } },
    { name: 'journal_talk_take', props: { action: 'retry' } },
    { name: 'journal_talk_take', props: { action: 'written' } },
    { name: 'journal_talk_retry', props: { outcome: 'written' } },
  ]);
  assert.deepEqual(await talk.issues(), []);
  assert.deepEqual(talk.errors, []);
});

// The server is the authority on the session: its 401 asks for sign-in even while the account still reads signed in,
// and has the account check itself.
test('signed out mid-take, the face opens the sign-in door and, signed back in, offers the send again', async (t) => {
  const talk = await room(t, { takes: [{ status: 401, body: { error: 'sign in to talk' } }] });

  await talk.talk(5);
  await talk.page.locator('.journal-talk-take').waitFor();
  assert.deepEqual((await talk.shown()).acts, ['Sign in', 'Download recording']);
  assert.equal(await talk.page.evaluate(() => window.authRefreshes), 1);
  await talk.page.evaluate(() => window.signIn('signed-out'));
  assert.deepEqual((await talk.shown()).acts, ['Sign in', 'Download recording']);
  await talk.page.getByRole('button', { name: 'Sign in' }).click();
  assert.equal(await talk.page.evaluate(() => window.signInDoors), 1);

  await talk.page.evaluate(() => window.signIn('signed-in'));
  await talk.page.getByRole('button', { name: 'Try again' }).waitFor();

  assert.deepEqual(await talk.shown(), {
    state: 'You’re signed out.', detail: 'Sign in, then send it again.', take: '0:05', kept: 'Held in this tab only.',
    acts: ['Try again', 'Download recording'], undo: null,
  });
});

test('no answer keeps the take, Try again waits for the browser to be online, and the loss reaches Sentry', async (t) => {
  const talk = await room(t, { takes: ['unreachable', { status: 403, body: { error: 'talk is part of Windmill One' } }] });

  await talk.talk(5);
  await talk.page.locator('.journal-talk-take').waitFor();
  assert.deepEqual((await talk.shown()).state, 'Couldn’t reach Windmill.');
  await talk.page.context().setOffline(true);
  assert.equal(await talk.page.getByRole('button', { name: 'Try again' }).isDisabled(), true);
  await talk.page.context().setOffline(false);
  await talk.page.getByRole('button', { name: 'Try again' }).click();
  await talk.page.getByText('Talk is part of Windmill One').waitFor();

  assert.deepEqual(await talk.shown(), {
    state: 'Talk is part of Windmill One', detail: null, take: '0:05', kept: 'Held in this tab only.',
    acts: ['Download recording', 'Close'], undo: null,
  });
  assert.equal(await talk.page.evaluate(() => window.refreshes), 1, 'a lapsed plan re-syncs so the mic re-locks');
  assert.deepEqual(await talk.issues(), [{ operation: 'journal-talk-transcribe', tags: { failure: 'unreachable' } }]);
  // The retry's outcome and the face it brought are told in whichever order the render lands.
  const told = (await talk.events()).map((event) => JSON.stringify(event));
  assert.deepEqual([told[0], told[1], ...told.slice(2).sort()], [
    JSON.stringify({ name: 'journal_talk_refused', props: { code: 'unreachable', reason: 'none', moment: 'take' } }),
    JSON.stringify({ name: 'journal_talk_take', props: { action: 'retry' } }),
    JSON.stringify({ name: 'journal_talk_refused', props: { code: 'status_403', reason: 'none', moment: 'take' } }),
    JSON.stringify({ name: 'journal_talk_retry', props: { outcome: 'refused' } }),
  ]);
});

// The take lives in the tab, not the room: leaving for another room and coming back finds it behind the dot, and
// leaving the page still asks first.
test('a kept take survives leaving the journal room and coming back', async (t) => {
  const talk = await room(t, { takes: [spent] });
  await talk.talk(5);
  await talk.page.locator('.journal-talk-take').waitFor();
  const href = await talk.page.locator('a.journal-talk-act').getAttribute('href');
  await talk.page.getByRole('button', { name: 'Close' }).click();
  const alive = () => talk.page.evaluate(async (url) => { try { await (await fetch(url)).arrayBuffer(); return true; } catch { return false; } }, href);

  await talk.page.evaluate(() => window.leaveRoom());
  await talk.page.getByText('gym room').waitFor();
  const away = { mic: await talk.mic.count(), guarded: await talk.guarded(), alive: await alive() };
  await talk.page.evaluate(() => window.backToRoom('dark'));
  await talk.page.locator('.journal-talk-tool.has-take').waitFor();
  await talk.mic.click();

  assert.deepEqual(away, { mic: 0, guarded: true, alive: true });
  assert.equal(await talk.page.locator('a.journal-talk-act').getAttribute('href'), href);
  assert.deepEqual((await talk.shown()).acts, ['Download recording', 'Close']);
  assert.equal(await talk.page.evaluate(() => window.microphones), 1);
});

// The room is left while the take is with the server. The refusal still keeps it, and its event is told only when a
// sheet first shows it; nothing leaks, and leaving the page asked all along.
test('a refusal that lands after the room was left keeps the take, told only once a sheet shows it', async (t) => {
  let answer;
  const answered = new Promise((resolve) => { answer = resolve; });
  const talk = await room(t, { takes: [async (route) => { await answered; await route.fulfill({ status: 502, json: { error: 'the transcriber could not answer' } }); }] });
  await talk.page.evaluate(() => {
    window.urls = { made: 0, revoked: 0 };
    const make = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.urls.made += 1; return make(blob); };
    URL.revokeObjectURL = (url) => { window.urls.revoked += 1; return revoke(url); };
  });
  await talk.talk(5);
  await talk.page.getByText('Writing it down…').waitFor();
  const guardedWhileWriting = await talk.guarded();

  await talk.page.evaluate(() => window.leaveRoom());
  await talk.page.getByText('gym room').waitFor();
  answer();
  await talk.page.waitForFunction(() => window.urls.made === 1);
  const eventsAway = await talk.events();
  await talk.page.evaluate(() => window.backToRoom('dark'));
  await talk.page.locator('.journal-talk-tool.has-take').waitFor();
  await talk.mic.click();
  await talk.page.locator('.journal-talk-take').waitFor();

  assert.equal(guardedWhileWriting, true);
  assert.deepEqual(eventsAway, []);
  assert.equal((await talk.shown()).state, 'The transcriber could not answer.');
  assert.deepEqual(await talk.events(), [
    { name: 'journal_talk_refused', props: { code: 'status_502', reason: 'none', moment: 'take' } },
  ]);
  await talk.page.getByRole('button', { name: 'Discard recording' }).click();
  await talk.page.clock.runFor(6000);
  assert.deepEqual(await talk.page.evaluate(() => window.urls), { made: 1, revoked: 1 });
  assert.equal(await talk.guarded(), false);
  assert.deepEqual(talk.errors, []);
});

// Default 5: nothing retries on its own, but once the day's audio has refilled the kept take offers to go again.
test('a take refused until a time offers Try again once that time has come', async (t) => {
  const ration = { status: 429, body: { code: 'voice_ration_spent', error: 'talk has had its turn for now', retryAtMs: Date.UTC(2026, 10, 15, 14, 12) } };
  const talk = await room(t, { takes: [ration, { status: 200, body: { text: 'the second time' } }] });
  await talk.talk(5);
  await talk.page.locator('.journal-talk-take').waitFor();
  const before = (await talk.shown()).acts;

  await talk.page.clock.runFor(10 * 60 * 1000);
  await talk.page.getByRole('button', { name: 'Try again' }).waitFor();
  const after = (await talk.shown()).acts;
  await talk.page.getByRole('button', { name: 'Try again' }).click();
  await talk.sheet.waitFor({ state: 'detached' });

  assert.deepEqual(before, ['Download recording', 'Close']);
  assert.deepEqual(after, ['Try again', 'Download recording']);
  assert.deepEqual(await talk.page.evaluate(() => window.written), ['the second time']);
  assert.equal(talk.sent.length, 2);
});

// The state line is the sheet's polite live region, and focus follows the person through the refused face.
test('focus moves through the refused face and its state line is announced', async (t) => {
  const busy = { status: 503, body: { code: 'voice_busy', error: 'voice is busy right now' } };
  const talk = await room(t, { takes: [busy, busy] });
  await talk.talk(5);
  await talk.page.locator('.journal-talk-take').waitFor();
  const onRefusal = await talk.focused();
  const live = await talk.page.locator('.journal-talk-state').getAttribute('role');
  await talk.page.getByRole('button', { name: 'Discard recording' }).click();
  const onDiscard = await talk.focused();
  await talk.page.getByRole('button', { name: 'Undo' }).click();
  await talk.page.locator('.journal-talk-take').waitFor();
  const onUndo = await talk.focused();
  await talk.page.getByRole('button', { name: 'Try again' }).click();
  await talk.page.getByText('Talk is busy right now.').waitFor();
  const onFailedRetry = await talk.focused();

  assert.deepEqual({ live, onRefusal, onDiscard, onUndo, onFailedRetry },
    { live: 'status', onRefusal: 'Try again', onDiscard: 'Undo', onUndo: 'Play recording', onFailedRetry: 'Try again' });
});

// The mic is asked only after the allowance and plan are read; until then the sheet does not claim to be waiting on it.
test('"Waiting for the microphone…" shows only once the microphone is asked', async (t) => {
  let readsAnswer;
  const reads = new Promise((resolve) => { readsAnswer = resolve; });
  const talk = await room(t, { reads, takes: [] });
  await talk.page.evaluate(() => { window.holdMicrophone = true; });

  await talk.mic.click();
  await talk.sheet.waitFor();
  const reading = { state: (await talk.shown()).state, microphones: await talk.page.evaluate(() => window.microphones) };
  readsAnswer();
  await talk.page.getByText('Waiting for the microphone…').waitFor();
  const asking = await talk.page.evaluate(() => window.microphones);
  await talk.page.evaluate(() => window.grantMicrophone());
  await talk.page.locator('.journal-talk-tool.is-recording').waitFor();

  assert.deepEqual(reading, { state: 'Talk', microphones: 0 });
  assert.equal(asking, 1);
});

// A 401 the account's own check finds was a blip — the session is valid — goes back to offering the send.
test('a 401 whose re-check finds the session valid offers Try again', async (t) => {
  const talk = await room(t, { takes: [{ status: 401, body: { error: 'sign in to talk' } }] });
  await talk.page.evaluate(() => { window.recheckFinds = { id: 'u_1' }; });

  await talk.talk(5);
  await talk.page.getByRole('button', { name: 'Try again' }).waitFor();

  assert.deepEqual((await talk.shown()).acts, ['Try again', 'Download recording']);
  assert.equal(await talk.page.evaluate(() => window.authRefreshes), 1);
});

// A success whose body is not a transcript is a failure Sentry hears of, said as the transcriber's, with the take kept.
test('a 200 that is not a transcript keeps the take as the transcriber’s failure and reports it', async (t) => {
  const talk = await room(t, { takes: [(route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>proxy</html>' })] });

  await talk.talk(5);
  await talk.page.locator('.journal-talk-take').waitFor();

  assert.deepEqual((await talk.shown()).state, 'The transcriber could not answer.');
  assert.deepEqual((await talk.shown()).acts, ['Try again', 'Download recording']);
  assert.deepEqual(await talk.issues(), [{ operation: 'journal-talk-transcribe', tags: { failure: 'unreadable', status: '200' } }]);
});

// The happy path tells telemetry the take was written, and nothing else.
test('a written take is told as written', async (t) => {
  const talk = await room(t, { takes: [{ status: 200, body: { text: 'rain all morning' } }] });

  await talk.talk(5);
  await talk.sheet.waitFor({ state: 'detached' });

  assert.deepEqual(await talk.page.evaluate(() => window.written), ['rain all morning']);
  assert.deepEqual(await talk.events(), [{ name: 'journal_talk_take', props: { action: 'written' } }]);
});

// By night the kept line and the take's length clear the 4.5:1 floor for small text on the card.
test('the kept line and the take’s length clear 4.5:1 at night', async (t) => {
  const talk = await room(t, { takes: [spent] });
  await talk.talk(5);
  await talk.page.locator('.journal-talk-take').waitFor();

  const ratios = await talk.page.evaluate(() => {
    const channels = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = (rgb) => {
      const [r, g, b] = rgb.map((value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const card = luminance(channels(getComputedStyle(document.querySelector('.journal-talk-sheet')).backgroundColor));
    return ['.journal-talk-kept', '.journal-talk-length', '.journal-talk-detail'].map((selector) => {
      const line = luminance(channels(getComputedStyle(document.querySelector(selector)).color));
      return Math.round(((Math.max(line, card) + 0.05) / (Math.min(line, card) + 0.05)) * 100) / 100;
    });
  });

  assert.ok(ratios.slice(0, 2).every((ratio) => ratio >= 4.5), `kept and length: ${ratios}`);
});
