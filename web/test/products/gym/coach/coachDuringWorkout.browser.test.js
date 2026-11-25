import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { hello, pull } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../../packages/api-contract/sync/reference/server/push.js';
import { Refusal } from '../../../../../packages/api-contract/sync/reference/server/admit.js';
import { Draft } from '../../../../src/platform/domain-kit/drafts.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { Instant } from '../../../../src/platform/domain-kit/time.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals } from '../../../../src/products/gym/domain/gymRules.js';
import { Routine, RoutineEntry, RoutineValue, SetTarget } from '../../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Session, TrainingSet, TrainingSetValue } from '../../../../src/products/gym/domain/training.js';
import { AppendSet, DeleteSet } from '../../../../src/products/gym/domain/trainingActions.js';
import { StartWorkout } from '../../../../src/products/gym/domain/workoutRack.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { beacon, withBrowserErrors } from '../../roadmap/browserFixture.js';

register('../../../jsxLoader.mjs', import.meta.url);
const { CoachTurns } = await import('../../../../src/products/gym/coach/coachTurns.js');
const { GymProfile } = await import('../../../../src/products/gym/coach/profile.js');
const { GymTurnTelemetry } = await import('../../../../src/products/gym/coach/turnTelemetry.js');

// Coach during a workout (web-device-parity §4, WD7) in Chromium: the real account provider and shell over the browser's own
// engine, every `/v1` request answered by the engine's reference server, which a phone of the same account (the domain
// harness) writes to as well, the phone having started Upper A. Coach's AI service is played: each round is the next of
// `window.aiRounds`, calls to Coach's abilities or its words, held while `window.aiGate` waits. `WM_COACH_SHOTS` names a
// folder for WD7's states at 1440 and 390.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthProvider from '/src/shell/auth/AuthProvider.jsx';
import { SignInDoorProvider } from '/src/shell/auth/SignInDoor.jsx';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { syncSession } from '/src/platform/sync/session.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';

let root = null;
const draw = () => root.render(React.createElement(AuthProvider, null, React.createElement(SignInDoorProvider, null,
  React.createElement(Shell, { location: { pathname: '/app/gym', hash: window.location.hash, search: '' } }))));
window.mount = (hash) => {
  window.location.hash = hash;
  root = createRoot(document.getElementById('root'));
  draw();
  window.addEventListener('hashchange', draw);
};
const gym = () => syncSession.engine.observe('self/gym').getSnapshot();
window.openWorkout = () => gym().drawn.find((record) => record.t === 'session' && !record.f?.finishedAt?.[0])?.id ?? null;
window.thread = (title) => gym().drawn.find((record) => record.t === 'thread' && record.f?.title?.[0] === title)?.id ?? null;
window.unsent = () => Object.values(gym().outbox).reduce((sum, count) => sum + count, 0);
window.kick = () => syncSession.engine.kick();
// This tab's engine writes wait until releaseCommits(), so a test can order two tabs' writes.
window.holdCommits = () => {
  const engine = syncSession.engine;
  const commit = engine.commit;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  engine.commit = async (...args) => { await held; return commit.apply(engine, args); };
  window.releaseCommits = () => { engine.commit = commit; release(); };
};
window.entryReady = true;
`;
const playedAi = `
const allowance = { tier: 'free', period: 'calendar_month_utc', limit: '1', used: '0', reserved: '0', remaining: '1', resetsAt: null,
  budgetResetsAt: null, code: 'ok', capabilities: { text: { large: 'large', medium: 'medium', small: 'small' }, transcription: false } };
const ended = (stop, parts) => ({ id: 9, event: 'ended', data: { stop, message: { role: 'assistant', parts, carry: 'c' }, charged: '0', allowance: null } });
let calls = 0;
export class AiClient {
  connected() { return true; }
  clearPass() {}
  async allowance() { return allowance; }
  async text({ onText }) {
    if (window.aiGate) await window.aiGate;
    const round = (window.aiRounds ?? []).shift();
    if (!round) throw new Error('no round left to play');
    if (round.calls) return ended('tool_calls', round.calls.map((call) => ({ toolCall: { id: 'toolu_' + (calls += 1), name: call.name, input: call.input } })));
    await onText?.(round.text);
    return ended('completed', [{ text: round.text }]);
  }
  async result() { throw new Error('no result to play'); }
}
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-gym-coach-workout-test`,
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
    plugins: [{ name: 'gym-coach-workout-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/gym-coach-workout-entry.js') return '\0gym-coach-workout-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0gym-coach-workout-events';
        if (id.endsWith('/telemetry/sentry.js')) return '\0gym-coach-workout-issues';
        if (id.endsWith('/platform/ai/client.js')) return '\0gym-coach-workout-ai';
      },
      load(id) {
        if (id === '\0gym-coach-workout-entry') return entry;
        if (id === '\0gym-coach-workout-events') return beacon;
        if (id === '\0gym-coach-workout-issues') return 'export function captureError(product, operation) { (window.issues ??= []).push(operation); }';
        if (id === '\0gym-coach-workout-ai') return playedAi;
      },
      configureServer(vite) {
        vite.middlewares.use('/gym-coach-workout', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Windmill</title><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/gym-coach-workout-entry.js"></script>');
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

const entries = [
  { exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 100 }, { reps: 5, weightKg: 100 }], restSeconds: 180 },
  { exerciseId: 'dumbbell-bench-press', sets: [{ reps: 8, weightKg: 16 }, { reps: 8, weightKg: 16 }, { reps: 8, weightKg: 16 }], restSeconds: 120 },
  { exerciseId: 'pull-up', sets: [{ reps: 8, weightKg: 10 }, { reps: 8, weightKg: 10 }, { reps: 8, weightKg: 10 }], restSeconds: 120 },
];
// Coach's change to Upper A's open workout: the belt off the pull-ups and face pulls at the end, two suggested changes; and
// the routine's for next time, face pulls added.
const lighter = [entries[0], entries[1], { ...entries[2], sets: entries[2].sets.map((set) => ({ ...set, weightKg: 0 })) },
  { exerciseId: 'face-pull', sets: [{ reps: 15, weightKg: 15 }, { reps: 15, weightKg: 15 }] }];
const question = 'My shoulder feels off on bench today. Should I change anything?';
const answer = 'Finish your last bench set as planned if it feels fine. For today, take the added weight off pull-ups and add face pulls at the end.';
const pullUp = new Id('pull-up', Exercise);

// Account A on the reference server, its phone the domain harness, which started Upper A ten minutes ago.
async function account(t) {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: Session.scope, start: Date.now() - 600_000 });
  t.after(() => phone.close());
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  const upper = new RoutineValue(new Id('routineUpperA', Routine), 'Upper A', 0, entries.map((each) => new RoutineEntry(new Id(each.exerciseId, Exercise),
    each.sets.map((set) => new SetTarget(set.reps, set.weightKg)), each.restSeconds)));
  assert.equal((await phone.runner.save(Draft.new(upper), GymRefusals)).result.kind, 'saved');
  assert.equal((await phone.runner.run(StartWorkout({ id: new Id('phoneWorkout0001', Session), routineId: upper.id }))).kind, 'committed');
  await phone.sync();
  return phone;
}

// The phone's Coach asked about its open workout, answering with its change to it over a played AI service; the thread it
// opened, once the log holds it.
async function phoneAsks(phone) {
  const rounds = [{ calls: [{ name: 'propose_workout_change', input: { id: 'coach-names-it', sessionId: 'phoneWorkout0001', entries: lighter, summary: '' } }] },
    { text: answer }];
  const ended = (stop, parts) => ({ id: 9, event: 'ended', data: { stop, message: { role: 'assistant', parts, carry: 'c' }, charged: '0', allowance: null } });
  const ai = { connected: () => true, clearPass() {}, result: async () => { throw new Error('no result to play'); },
    allowance: async () => ({ tier: 'free', period: 'calendar_month_utc', limit: '1', used: '0', reserved: '0', remaining: '1', resetsAt: null,
      budgetResetsAt: null, code: 'ok', capabilities: { text: { large: 'large', medium: 'medium', small: 'small' }, transcription: false } }),
    text: async () => {
      const round = rounds.shift();
      return round.calls ? ended('tool_calls', round.calls.map((call, at) => ({ toolCall: { id: `toolu_${at}`, name: call.name, input: call.input } })))
        : ended('completed', [{ text: round.text }]);
    } };
  let serial = 0;
  const profile = new GymProfile();
  const turns = new CoachTurns({ engine: phone.engine, ai, profile, appBaseUrl: 'https://windmill.works', online: () => true, now: () => 0, textEvery: 0,
    runtime: { now: () => 0, newId: () => `call${String(++serial).padStart(18, '0')}`, withLock: (_id, _options, body) => body(true) },
    telemetry: new GymTurnTelemetry({ catalog: profile.catalog, event() {}, report() {} }) });
  const turn = await turns.send({ question });
  while (turns.running) await turns.running.done;
  await phone.sync();
  return turn.thread.record;
}

// The phone's clock brought to the page's, so what it stamps after reading the page's records is not ahead of the server.
const catchUp = (phone) => phone.advance(Date.now() - phone.world.now);

// A pull-up the phone logs, then sends; the page hears of it on its next pull.
async function phoneLogsPullUp(phone) {
  await catchUp(phone);
  const set = new TrainingSetValue(new Id('phonePullUp00001', TrainingSet), new Id('phoneWorkout0001', Session), pullUp, 10, 8, new Instant(phone.world.now));
  assert.equal((await phone.runner.run(AppendSet(set))).kind, 'committed');
  await phone.sync();
  return set.id;
}

// A browser of its own whose `/v1` the reference server answers over `phone`'s state, signed in as A. `log.refuse`, while set,
// is what the log's gym answers the next Apply of a workout proposal instead: `{ code, detail }`; `log.hold`, while set, a
// promise every push waits on before the log reads it.
async function visit(t, phone, { hash = '#/gym/workout', width = 1440, height = 1000, colorScheme = 'light' } = {}) {
  await ready;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme });
  context.setDefaultTimeout(20000);
  t.after(() => context.close());
  const log = { refuse: null, hold: null };
  await context.routeWebSocket(/\/v1\//, () => {});
  await context.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/v1/me') return json(200, { user: { id: 'A', name: 'Ann' } });
    if (path === '/v1/sync/hello') {
      const answered = hello({ state: phone.world.server, registry, account: 'A', serverTime: Date.now() });
      return json(answered.status, answered.body);
    }
    if (path === '/v1/sync/push' || path === '/v1/sync/pull') {
      if (path.endsWith('push')) await log.hold;
      const product = Object.create(phone.world.product);
      if (log.refuse) {
        const { code, detail } = log.refuse;
        product.applyWorkoutProposal = () => { log.refuse = null; throw new Refusal(code, detail); };
      }
      const out = (path.endsWith('push') ? push : pull)({ state: phone.world.server, registry, product, account: 'A', request: request.postDataJSON(), serverNow: Date.now() });
      phone.world.server = out.state;
      return json(out.response.status, out.response.body);
    }
    return undefined;
  });
  const tab = async (at = hash) => {
    const page = await context.newPage();
    await page.goto(`${origin}/gym-coach-workout`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate((where) => window.mount(where), at);
    return page;
  };
  return { context, tab, log, page: await tab() };
}

const loggable = (page) => page.locator('.gym-live-rack button[type="submit"]:not([aria-disabled="true"])').waitFor();
const steps = (page, name) => page.evaluate((wanted) => (window.events ?? []).filter((event) => event.name === wanted).map((event) => event.props), name);
const told = (page, name, count) => page.waitForFunction(({ wanted, count }) => (window.events ?? []).filter((event) => event.name === wanted).length >= count,
  { wanted: name, count });
// Coach answers the next question with a change to the open workout, `plan`, with `routine` the routine's change too, then
// its words.
const proposes = (page, { plan = lighter, routine = false } = {}) => page.evaluate(({ plan, nextTime, words }) => {
  const workout = { name: 'propose_workout_change', input: { id: 'coach-names-it', sessionId: window.openWorkout(), entries: plan, summary: '' } };
  const upper = { name: 'propose_routine_change', input: { id: 'coach-names-it', routineId: 'routineUpperA', name: 'Upper A', entries: nextTime, summary: '' } };
  window.aiRounds = [{ calls: nextTime ? [workout, upper] : [workout] }, { text: words }];
}, { plan, nextTime: routine ? [...entries, lighter[3]] : null, words: answer });
const ask = async (scope, words = question) => {
  const field = scope.getByRole('textbox', { name: 'Ask about your training', exact: true });
  await field.fill(words);
  await field.press('Enter');
};
const newChats = [{ screen: 'coach', action: 'new_chat', door: 'workout', outcome: 'ok' }];
const decided = (target, action, extra = {}) => ({ screen: 'coach', target, action, outcome: 'decided', ...extra });

test('Chromium: at a desk Coach opens in the rail beside the rack and keeps its conversation through a flip of the tabs; its change applied there is told once the log takes it (WD7.1, WD7.2)', async (t) => {
  const phone = await account(t);
  const { page } = await visit(t, phone);
  await withBrowserErrors(page, async () => {
    await loggable(page);
    const tablist = page.getByRole('tablist', { name: 'This workout and Coach', exact: true });
    assert.deepEqual(await tablist.getByRole('tab').allTextContents(), ['This workout', 'Coach']);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((tab) => Boolean(document.getElementById(tab.getAttribute('aria-controls'))))),
      [true, true], 'each tab controls a panel that exists');
    await page.getByRole('tab', { name: 'Coach', exact: true }).click();
    const coach = page.getByRole('tabpanel', { name: 'Coach', exact: true });
    await proposes(page, { routine: true });
    await ask(coach);
    const workout = coach.getByRole('region', { name: 'This workout', exact: true });
    await workout.getByRole('button', { name: 'Apply', exact: true }).waitFor();
    assert.equal(await workout.locator('header').innerText(), 'This workout\n2 suggested changes · now');
    const routine = coach.getByRole('region', { name: 'Upper A', exact: true });
    assert.equal(await routine.locator('header').innerText(), 'Upper A\n1 suggested change · next time');
    assert.deepEqual(await workout.locator('.gym-coach-proposal-line').allInnerTexts(), ['Load\n10 kg\n0 kg', 'Sets\n2', 'Reps\n15', 'Load\n15 kg'],
      'a line that stays the same is left out');
    const fills = await Promise.all([workout, routine].map((card) => card.getByRole('button', { name: /^(Reject|Apply)$/ }).evaluateAll((buttons) =>
      buttons.map((button) => getComputedStyle(button).backgroundColor))));
    assert.equal(fills[0][0], fills[1][0], 'Reject is the same quiet button on both');
    assert.equal(fills[1][1], fills[1][0], 'the routine\'s Apply steps back while a workout is open');
    assert.notEqual(fills[0][1], fills[0][0], 'this workout\'s card holds the one prominent Apply');
    assert.equal(await page.getByRole('button', { name: 'Log set', exact: true }).isVisible(), true, 'the rack stays beside Coach');

    const shown = () => page.evaluate(() => ['workout', 'coach'].map((panel) => document.getElementById(`gym-live-side-${panel}-panel`).checkVisibility()));
    assert.deepEqual(await shown(), [false, true]);
    await page.getByRole('tab', { name: 'This workout', exact: true }).click();
    assert.deepEqual(await shown(), [true, false], 'the tab shows its panel alone');
    await page.getByRole('tab', { name: 'Coach', exact: true }).click();
    await workout.getByRole('button', { name: 'Apply', exact: true }).waitFor();
    assert.deepEqual(await steps(page, 'gym_action'), newChats, 'a flip of the tabs keeps the conversation and starts no chat');

    await workout.getByRole('button', { name: 'Apply', exact: true }).click();
    await coach.getByText('Applied · this workout', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Applied · this workout', 'the settled line takes the focus');
    assert.equal(await routine.getByRole('button', { name: 'Apply', exact: true }).count(), 1, 'the routine card is decided on its own');
    await told(page, 'gym_proposal_outcome', 1);
    await page.getByRole('tab', { name: 'This workout', exact: true }).click();
    await page.locator('.gym-live-movement').filter({ hasText: 'Face Pull' }).waitFor();
    assert.equal(await page.locator('.gym-live-movement').filter({ hasText: 'Pull Up' }).locator('.gym-live-movement-scheme').textContent(), '3 × 8 · bodyweight');
    await page.waitForTimeout(500);
    assert.deepEqual(await steps(page, 'gym_proposal_outcome'), [decided('workout', 'apply')]);
    assert.deepEqual(await page.evaluate(() => window.issues ?? []), []);
  });
});

test('Chromium: crossing from a desk to a phone keeps the conversation, opens no sheet and starts no chat, and the phone\'s Coach reopens on it while its change waits', async (t) => {
  const phone = await account(t);
  const { page } = await visit(t, phone);
  await withBrowserErrors(page, async () => {
    await loggable(page);
    await page.getByRole('tab', { name: 'Coach', exact: true }).click();
    await proposes(page);
    await ask(page.getByRole('tabpanel', { name: 'Coach', exact: true }));
    await page.getByRole('region', { name: 'This workout', exact: true }).getByRole('button', { name: 'Apply', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await loggable(page);
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole('dialog').count(), 0, 'no sheet opens without a gesture');
    await page.getByRole('button', { name: 'Coach', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Coach', exact: true });
    await sheet.getByRole('region', { name: 'This workout', exact: true }).getByRole('button', { name: 'Apply', exact: true }).waitFor();
    assert.equal(await sheet.getByText(question, { exact: true }).count(), 1, 'the sheet reopens on the conversation whose change waits');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await sheet.waitFor({ state: 'detached' });
    await page.getByRole('tabpanel', { name: 'Coach', exact: true }).getByText(question, { exact: true }).waitFor();
    assert.deepEqual(await steps(page, 'gym_action'), newChats);
  });
});

test('Chromium: on a phone Coach is a sheet at its large detent; Reject settles its card and takes the focus, Close leaves the rack as it was, and the next Coach opens a fresh chat (WD7.1 · 390)', async (t) => {
  const phone = await account(t);
  const { page } = await visit(t, phone, { width: 390, height: 844 });
  await withBrowserErrors(page, async () => {
    await loggable(page);
    await page.getByRole('button', { name: 'Log set', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
    assert.equal(await page.getByRole('tab').count(), 0, 'a phone has no rail to hold the tabs');
    await page.getByRole('button', { name: 'Coach', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Coach', exact: true });
    await sheet.waitFor();
    assert.deepEqual(await page.evaluate(() => { const box = document.querySelector('dialog.wm-sheet').getBoundingClientRect(); return [box.top, box.bottom]; }), [60, 844]);
    assert.equal(await sheet.getByRole('link', { name: 'History', exact: true }).getAttribute('href'), '#/gym/coach/threads');
    await proposes(page);
    await ask(sheet);
    const card = sheet.getByRole('region', { name: 'This workout', exact: true });
    await card.getByRole('button', { name: 'Reject', exact: true }).waitFor();
    assert.equal(await sheet.locator('.gym-coach-stamp').count(), 0, 'no day stamp over a workout');
    const field = await sheet.getByRole('textbox', { name: 'Ask about your training', exact: true }).boundingBox();
    assert.ok(field.y + field.height <= 844, 'the composer stays at the sheet\'s foot');
    await card.getByRole('button', { name: 'Reject', exact: true }).click();
    await sheet.getByText('Rejected · this workout', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Rejected · this workout');
    await told(page, 'gym_proposal_outcome', 1);
    assert.deepEqual(await steps(page, 'gym_proposal_outcome'), [decided('workout', 'reject')]);
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Coach', 'focus is back on Coach');
    assert.equal(await page.locator('.gym-live-row.is-logged').count(), 1);
    assert.equal(await page.locator('.gym-live-movement-title').textContent(), 'Back Squat', 'the movement in hand is the one it was');
    await page.getByRole('button', { name: 'Coach', exact: true }).click();
    await sheet.waitFor();
    assert.equal(await sheet.getByText(question, { exact: true }).count(), 0, 'with nothing waiting, the next Coach is a fresh chat');
    assert.deepEqual(await steps(page, 'gym_action'), [...newChats, ...newChats]);
  });
});

test('Chromium: Coach closed mid-answer reopens on the answer still running, and a question asked meanwhile is refused busy and kept, then sent once the answer ends', async (t) => {
  const phone = await account(t);
  const { page } = await visit(t, phone, { width: 390, height: 844 });
  await withBrowserErrors(page, async () => {
    await loggable(page);
    await page.getByRole('button', { name: 'Coach', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Coach', exact: true });
    await page.evaluate((words) => {
      window.aiGate = new Promise((resolve) => { window.releaseAi = resolve; });
      window.aiRounds = [{ text: words }, { text: 'Second answer.' }];
    }, answer);
    await ask(sheet, 'First question?');
    await told(page, 'gym_ask_started', 1);
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Coach', exact: true }).click();
    await sheet.getByText('First question?', { exact: true }).waitFor();
    assert.equal(await sheet.getByRole('button', { name: 'Stop response', exact: true }).count(), 1, 'its Stop stands beside the turn it stops');
    await ask(sheet, 'Second question?');
    await sheet.getByText('Coach is answering another message. Try again when it finishes.', { exact: true }).waitFor();
    assert.equal(await sheet.getByRole('textbox', { name: 'Ask about your training', exact: true }).inputValue(), 'Second question?', 'the question is kept');
    await page.evaluate(() => { window.aiGate = null; window.releaseAi(); });
    await sheet.getByText(answer, { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('dialog.wm-sheet')?.innerText.includes('Coach is answering another message'));
    await sheet.getByRole('textbox', { name: 'Ask about your training', exact: true }).press('Enter');
    await sheet.getByText('Second answer.', { exact: true }).waitFor();
    assert.deepEqual(await steps(page, 'gym_action'), newChats);
  });
});

test('Chromium: a change the copy holds out of date says why in one sentence, its refused Apply is told once, and once its cause is undone it stands ready again (WD7.3)', async (t) => {
  const phone = await account(t);
  const { page } = await visit(t, phone);
  await withBrowserErrors(page, async () => {
    await loggable(page);
    await page.getByRole('tab', { name: 'Coach', exact: true }).click();
    const coach = page.getByRole('tabpanel', { name: 'Coach', exact: true });
    await proposes(page);
    await ask(coach);
    const card = coach.getByRole('region', { name: 'This workout', exact: true });
    await card.getByRole('button', { name: 'Apply', exact: true }).waitFor();
    await page.waitForFunction(() => window.unsent() === 0);
    // The phone logs a pull-up; this tab's Apply waits until the copy has heard of it, so its own rules refuse it.
    const set = await phoneLogsPullUp(phone);
    await page.evaluate(() => window.holdCommits());
    await card.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.evaluate(() => window.kick());
    await card.getByText('You logged Pull Up since this suggestion. Nothing was applied.', { exact: true }).waitFor();
    await page.evaluate(() => window.releaseCommits());
    await told(page, 'gym_proposal_outcome', 1);
    assert.equal(await card.locator('header').innerText(), 'This workout\nOut of date');
    assert.equal(await card.getByRole('button').count(), 0, 'no buttons');
    assert.deepEqual(await steps(page, 'gym_proposal_outcome'), [{ screen: 'coach', target: 'workout', action: 'apply', outcome: 'failed', reason: 'workout-moved' }]);
    // The phone deletes that pull-up: the copy reads the change as current again, and so does its card.
    await catchUp(phone);
    assert.equal((await phone.runner.run(DeleteSet(set))).kind, 'committed');
    await phone.leave();
    await phone.sync();
    await page.evaluate(() => window.kick());
    await card.getByRole('button', { name: 'Apply', exact: true }).waitFor();
    assert.equal(await card.locator('header').innerText(), 'This workout\n2 suggested changes · now');
  });
});

for (const [refusal, sentence, reason] of [
  [{ code: 'invalid' }, 'This change sets a load below what one of its movements allows. Nothing was applied.', 'invalid'],
  [{ code: 'plan-logged', detail: { exerciseId: 'pull-up' } }, 'You logged Pull Up since this suggestion. Nothing was applied.', 'workout-moved'],
]) {
  test(`Chromium: an Apply the log refuses as ${refusal.code} stands out of date with its one sentence, never pending again, and is told once, by the page that made it`, async (t) => {
    const phone = await account(t);
    const { page, tab, log } = await visit(t, phone);
    await withBrowserErrors(page, async () => {
      await loggable(page);
      await page.getByRole('tab', { name: 'Coach', exact: true }).click();
      const coach = page.getByRole('tabpanel', { name: 'Coach', exact: true });
      await proposes(page);
      await ask(coach);
      const card = coach.getByRole('region', { name: 'This workout', exact: true });
      await card.getByRole('button', { name: 'Apply', exact: true }).waitFor();
      await page.waitForFunction(() => window.unsent() === 0);
      log.refuse = refusal;
      await card.getByRole('button', { name: 'Apply', exact: true }).click();
      await card.getByText(sentence, { exact: true }).waitFor();
      await told(page, 'gym_proposal_outcome', 1);
      assert.equal(await card.getByRole('button').count(), 0);
      assert.equal(await page.locator('.gym-toast-slot').textContent(), '', 'the room says nothing of it');
      const other = await tab(`#/gym/coach/threads/${await page.evaluate((title) => window.thread(title), question)}`);
      await other.getByRole('region', { name: 'This workout', exact: true }).getByText(sentence, { exact: true }).waitFor();
      await page.reload();
      await page.waitForFunction(() => window.entryReady);
      await page.evaluate(() => window.mount('#/gym/workout'));
      await loggable(page);
      await page.waitForTimeout(800);
      assert.deepEqual({ reloaded: await steps(page, 'gym_proposal_outcome'), other: await steps(other, 'gym_proposal_outcome') }, { reloaded: [], other: [] },
        'a reload and another tab tell nothing of it');
    });
  });
}

test('Chromium: a phone\'s workout proposal stands in History with its card in each tab; an Apply in each of two at once tells one decision, from the page whose Apply reached the log', async (t) => {
  const phone = await account(t);
  const thread = await phoneAsks(phone);
  const { page: one, tab, log } = await visit(t, phone, { hash: `#/gym/coach/threads/${thread}` });
  const two = await tab();
  const card = (page) => page.getByRole('region', { name: 'This workout', exact: true });
  const apply = (page) => card(page).getByRole('button', { name: 'Apply', exact: true });
  await withBrowserErrors(one, async () => {
    for (const page of [one, two]) await apply(page).waitFor();
    assert.equal(await card(one).locator('header').innerText(), 'This workout\n2 suggested changes · now');
    assert.deepEqual(await one.locator('.gym-coach-turn.is-lifter .gym-coach-bubble').allInnerTexts(), [question], 'the phone\'s question stands above its answer');
    // Tab two's Apply is tapped first and lands second, while tab one's is still on its way to the log.
    let reach;
    log.hold = new Promise((resolve) => { reach = resolve; });
    await two.evaluate(() => window.holdCommits());
    await apply(two).click();
    await apply(one).click();
    await one.waitForFunction(() => window.unsent() === 1);
    await two.evaluate(() => window.releaseCommits());
    for (const page of [one, two]) await page.getByText('Applied · this workout', { exact: true }).waitFor();
    assert.deepEqual([await steps(one, 'gym_proposal_outcome'), await steps(two, 'gym_proposal_outcome')], [[], []], 'nothing is told before the log answers');
    log.hold = null;
    reach();
    await told(one, 'gym_proposal_outcome', 1);
    await two.waitForTimeout(800);
    assert.deepEqual({ one: await steps(one, 'gym_proposal_outcome'), two: await steps(two, 'gym_proposal_outcome') },
      { one: [decided('workout', 'apply')], two: [] });
    await phone.sync();
    assert.deepEqual(phone.drawn(Session).find((session) => session.id.record === 'phoneWorkout0001').plan.entries.map((entry) => entry.json), lighter,
      'the phone\'s workout runs the change');
  });
});

test('Chromium: Coach during a workout at 1440 and 390, for the boards (WD7)', { skip: !process.env.WM_COACH_SHOTS }, async (t) => {
  const shot = (page, name) => page.screenshot({ path: `${process.env.WM_COACH_SHOTS}/${name}.png` });
  const reading = (page, at) => page.evaluate((end) => {
    const scroller = document.querySelector('.gym-coach.is-workout .gym-coach-reading');
    scroller.scrollTop = end ? scroller.scrollHeight : 0;
  }, at === 'end');
  // Upper A under way as the boards draw it: two sets of bench press logged, the third in hand.
  const underWay = async (page) => {
    await loggable(page);
    await page.getByRole('button', { name: 'Dumbbell Bench Press, 2 of 3', exact: true }).click();
    await page.locator('.gym-live-movement-title').filter({ hasText: 'Dumbbell Bench Press' }).waitFor();
    for (let set = 0; set < 2; set += 1) {
      await loggable(page);
      await page.getByRole('button', { name: 'Log set', exact: true }).click();
      await page.waitForFunction((count) => document.querySelectorAll('.gym-live-row.is-logged').length === count, set + 1);
    }
  };

  const { page: wide } = await visit(t, await account(t), { width: 1440, height: 1240, colorScheme: 'dark' });
  await underWay(wide);
  await wide.getByRole('tab', { name: 'Coach', exact: true }).click();
  await proposes(wide, { routine: true });
  const rail = wide.getByRole('tabpanel', { name: 'Coach', exact: true });
  await ask(rail);
  await rail.getByRole('region', { name: 'Upper A', exact: true }).getByRole('button', { name: 'Apply', exact: true }).waitFor();
  await wide.mouse.click(5, 600);
  await wide.waitForTimeout(1300);
  await reading(wide, 'top');
  await shot(wide, 'wd7.1-1440');
  // The rail's foot at a laptop's heights: the composer clear of the tabs above it.
  for (const height of [1000, 900]) {
    await wide.setViewportSize({ width: 1440, height });
    await wide.waitForTimeout(400);
    await reading(wide, 'end');
    await shot(wide, `wd7.1-1440x${height}`);
  }

  const phone = await account(t);
  const { page: narrow } = await visit(t, phone, { width: 390, height: 844, colorScheme: 'dark' });
  await underWay(narrow);
  await narrow.getByRole('button', { name: 'Coach', exact: true }).click();
  const sheet = narrow.getByRole('dialog', { name: 'Coach', exact: true });
  await proposes(narrow, { routine: true });
  await ask(sheet);
  const workout = sheet.getByRole('region', { name: 'This workout', exact: true });
  await workout.getByRole('button', { name: 'Apply', exact: true }).waitFor();
  await narrow.evaluate(() => document.activeElement?.blur());
  await reading(narrow, 'top');
  await shot(narrow, 'wd7.1-390');

  // Out of date (WD7.3): a pull-up the phone logs while the card waits.
  await phoneLogsPullUp(phone);
  await narrow.evaluate(() => window.kick());
  await workout.getByText('You logged Pull Up since this suggestion. Nothing was applied.', { exact: true }).waitFor();
  await reading(narrow, 'top');
  await shot(narrow, 'wd7.3-390');

  // Applied (WD7.2): Coach opened again, a fresh chat, and its change, which leaves the logged pull-ups as they stand, applied.
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await sheet.waitFor({ state: 'detached' });
  await narrow.getByRole('button', { name: 'Coach', exact: true }).click();
  await proposes(narrow, { plan: [entries[0], entries[1], entries[2], lighter[3]], routine: true });
  await ask(sheet);
  await sheet.getByRole('region', { name: 'This workout', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click();
  await sheet.getByText('Applied · this workout', { exact: true }).waitFor();
  await narrow.evaluate(() => document.activeElement?.blur());
  await reading(narrow, 'top');
  await shot(narrow, 'wd7.2-390');
});
