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
window.mount = (theme) => createRoot(document.getElementById('fixture')).render(
  React.createElement('div', { className: 'journal-root', 'data-theme': theme, 'data-brand': 'journal' },
    React.createElement('div', { className: 'journal-tools' },
      React.createElement(TalkButton, {
        onTranscript: (text) => window.written.push(text),
        onNeedSignIn: () => { window.signInDoors += 1; },
      }))));
`;
const auth = `
import { useSyncExternalStore } from 'react';
const listeners = new Set();
window.account = { status: 'signed-in', user: { id: 'u_1' } };
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
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => { window.microphones += 1; return { getTracks: () => [{ stop() { window.released += 1; } }] }; },
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
const renewing = { environment: 'production', allowlisted: false, plan: 'windmill_one', accessUntil: Date.UTC(2026, 11, 4),
  governing: { autoRenew: true }, others: [], manage: null, purchasable: [], offer: null };

// A room whose server answers each take from `takes`, in order, the allowance read with `allowance` and the plan with
// `plan`. Time stands still until the test moves it.
async function room(t, { theme = 'dark', allowance = read('ok', { remaining: '6.000000000' }), plan = renewing, takes = [] } = {}) {
  await ready;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC', locale: 'en-US' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sent = [];
  await page.addInitScript(fakeMicrophone);
  await page.clock.install({ time: Date.UTC(2026, 10, 15, 14, 2) });
  await page.clock.pauseAt(Date.UTC(2026, 10, 15, 14, 2));
  await page.route(/\/v1\/ai\/allowance$/, (route) => route.fulfill({ status: allowance ? 200 : 503,
    json: allowance ?? { code: 'ai_allowance_disabled', error: 'AI allowances are not enabled.' } }));
  await page.route(/\/v1\/subscription$/, (route) => route.fulfill({ status: 200, json: plan }));
  await page.route(/\/v1\/journal\/transcribe$/, async (route) => {
    sent.push({ type: route.request().headers()['content-type'], bytes: route.request().postDataBuffer()?.length ?? 0 });
    const answer = takes.shift();
    if (answer === 'unreachable') return route.abort('internetdisconnected');
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

test('a busy allowance offers Try again, which sends the kept take once more and writes it down', async (t) => {
  const busy = { status: 503, body: { code: 'concurrency_exhausted', reason: 'unavailable', error: 'busy',
    allowance: read('concurrency_exhausted') } };
  const talk = await room(t, { allowance: null, takes: [busy, { status: 200, body: { text: ' rain all morning ' } }] });

  await talk.talk(12);
  await talk.page.locator('.journal-talk-take').waitFor();
  assert.deepEqual(await talk.shown(), {
    state: 'Another AI request is still in progress.', detail: 'Try again when it finishes.', take: '0:12',
    kept: 'Held in this tab only.', acts: ['Try again', 'Download recording'], undo: null,
  });

  await talk.page.getByRole('button', { name: 'Try again' }).click();
  await talk.sheet.waitFor({ state: 'detached' });

  assert.deepEqual(await talk.page.evaluate(() => window.written), ['rain all morning']);
  assert.deepEqual(talk.sent, [{ type: 'audio/webm', bytes: 32044 }, { type: 'audio/webm', bytes: 32044 }]);
  assert.equal(await talk.guarded(), false);
  assert.equal(await talk.page.locator('.journal-talk-tool.has-take').count(), 0);
  assert.deepEqual(await talk.events(), [
    { name: 'journal_talk_refused', props: { code: 'concurrency_exhausted', reason: 'unavailable', moment: 'take' } },
    { name: 'journal_talk_take', props: { action: 'retry' } },
    { name: 'journal_talk_retry', props: { outcome: 'written' } },
  ]);
});

test('signed out mid-take, the face opens the sign-in door and, signed back in, offers the send again', async (t) => {
  const talk = await room(t, { takes: [{ status: 401, body: { error: 'sign in to talk' } }] });

  await talk.talk(5);
  await talk.page.locator('.journal-talk-take').waitFor();
  await talk.page.evaluate(() => window.signIn('signed-out'));
  assert.deepEqual((await talk.shown()).acts, ['Sign in', 'Download recording']);
  await talk.page.getByRole('button', { name: 'Sign in' }).click();
  assert.equal(await talk.page.evaluate(() => window.signInDoors), 1);

  await talk.page.evaluate(() => window.signIn('signed-in'));

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
  assert.deepEqual((await talk.events()).slice(1), [
    { name: 'journal_talk_take', props: { action: 'retry' } },
    { name: 'journal_talk_retry', props: { outcome: 'refused' } },
    { name: 'journal_talk_refused', props: { code: 'status_403', reason: 'none', moment: 'take' } },
  ]);
});
