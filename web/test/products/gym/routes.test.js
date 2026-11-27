import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gymRoutes } from '../../../src/products/gym/routes.js';
import { gymLandingHead } from '../../../src/products/gym/marketing/landingHead.js';
import { SITE_ORIGIN } from '../../../src/shell/marketing/siteIdentity.js';

const GYM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/products/gym');

test('the frame is handed the chrome it is standing in, off the pathname the caller resolved', () => {
  const bare = [
    ['#/gym', '/'],
    ['#/gym/log', '/gym'],
    ['#/gym/movement/back-squat', '/t/t_abc'],
    ['#/gym', '/apples'],
  ];
  for (const [hash, pathname] of bare) {
    assert.deepEqual(gymRoutes.render({ hash, pathname }).props, { hash, inShell: false }, pathname);
  }

  const inShell = [
    ['#/gym', '/app'],
    ['#/gym', '/app/gym'],
    ['#/gym/movement/back-squat', '/app/gym'],
    ['#/gym/log', '/app/gym/'],
  ];
  for (const [hash, pathname] of inShell) {
    assert.deepEqual(gymRoutes.render({ hash, pathname }).props, { hash, inShell: true }, pathname);
  }

  assert.deepEqual(gymRoutes.render({ hash: '#/gym' }).props, { hash: '#/gym', inShell: false });

  assert.equal(gymRoutes.render({ hash: '#/journal/2026-08-01', pathname: '/app/journal' }), null);
  assert.equal(gymRoutes.render({ hash: '#/app/start', pathname: '/app/roadmap' }), null);
});

test('gym brings the cell the /app home grid draws once it is open', () => {
  assert.notEqual(gymRoutes.shell.HomeCard, undefined);
  assert.notEqual(gymRoutes.shell.HomeCard, null);
  assert.equal(fs.existsSync(path.join(GYM, 'HomeCard.jsx')), true);
  assert.equal(fs.readFileSync(path.join(GYM, 'routes.js'), 'utf8').includes("const HomeCard = lazy(() => import('./HomeCard.jsx')"), true);
});

test('the registry answers for either state of the flag', () => {
  assert.equal(['open', 'pre-open'].includes(gymRoutes.shell.status), true, gymRoutes.shell.status);
  assert.equal(gymRoutes.shell.room, '/app/gym');
  assert.equal(gymRoutes.switchHash, '#/gym');
  assert.equal(gymRoutes.home(), '#/gym');
  assert.equal(gymRoutes.landingAfterSignIn(), '#/gym');
  assert.equal(gymRoutes.shell.landingHref, gymRoutes.landing.href);
});

test('the landing offers the log itself, and no line on it is dated against the flag', () => {
  assert.deepEqual(gymLandingHead.fallback.actions, [
    { href: '#/gym', label: 'Open your training log →' },
    { href: '#how', label: 'See how it works' },
  ]);

  const words = [
    gymLandingHead.title,
    gymLandingHead.description,
    gymLandingHead.ogDescription,
    gymLandingHead.fallback.badge,
    gymLandingHead.fallback.h1,
    gymLandingHead.fallback.sub,
    gymLandingHead.fallback.trust,
    ...gymLandingHead.fallback.notes,
    gymRoutes.label,
    gymRoutes.landing.tagline,
    gymRoutes.landing.root.kind,
    gymRoutes.landing.root.line,
    gymRoutes.landing.root.link.label,
    gymRoutes.landing.root.paragraph,
    ...gymRoutes.landing.root.features.flatMap((feature) => [feature.title, feature.text]),
  ].join('  ');
  for (const dated of ['when it opens', 'In design', 'in design', 'already open', 'coming soon', 'Coming soon']) {
    assert.equal(words.includes(dated), false, dated);
  }

  assert.equal(gymLandingHead.fallback.trust.includes('account'), true);
});

test('the brand root is handed gym’s words and its picture, and its door is gym’s landing', () => {
  const { root } = gymRoutes.landing;
  assert.deepEqual({ kind: root.kind, line: root.line, link: root.link, paragraph: root.paragraph, features: root.features, label: root.picture.label, reserve: root.picture.reserve }, {
    kind: 'training log',
    line: 'A coach that answers from your log.',
    link: { href: '/gym', label: 'See Windmill Gym', to: 'landing' },
    paragraph: 'Ask about your training and the answer comes from your own log, with a receipt of what it read. It proposes a change to your routine, and nothing changes until you apply it. Use Windmill’s Coach, or connect your own assistant to the same log.',
    features: [
      { title: 'It remembers last time', text: 'Each set opens with your target, or last session’s weight and reps, already filled in.' },
      { title: 'Honest progress', text: 'Estimated one-rep max per lift over time, with no invented trend.' },
      { title: 'On your phone', text: 'Sets are logged in the phone app: Android as a direct download, iPhone in\u00A0beta.' },
    ],
    label: 'Composed session',
    reserve: { wide: '506px', narrow: '480px' },
  });
  assert.equal(root.link.href, gymRoutes.landing.href);
  assert.equal(typeof root.picture.Picture, 'object');
  assert.equal(fs.existsSync(path.join(GYM, 'marketing', 'RootPicture.jsx')), true);
});

test('the /gym shell carries a complete no-JS body and asserts the application it is a page for', () => {
  for (const field of ['accent', 'badge', 'h1', 'sub', 'actions', 'trust', 'notes']) {
    assert.equal(Boolean(gymLandingHead.fallback[field]), true, field);
  }
  assert.equal(gymLandingHead.schema.length, 1);
  assert.equal(gymLandingHead.schema[0]['@type'], 'SoftwareApplication');
  assert.equal(gymLandingHead.schema[0].url, `${SITE_ORIGIN}/gym`);
  assert.equal(gymLandingHead.schema[0].isAccessibleForFree, true);
  assert.equal(gymLandingHead.path, '/gym');
  assert.equal(gymLandingHead.module, 'src/products/gym/marketing/GymLanding.jsx');
});

test('the share link is declared bare, so opening gym never drags it into the room', () => {
  assert.equal(typeof gymRoutes.shell.bare, 'function');
  assert.equal(gymRoutes.shell.bare('#/gym/shared/tok_abc123'), true);

  for (const hash of ['#/gym', '#/gym/log', '#/gym/routines', '#/gym/movement/back-squat',
                      '#/gym/backfill', '#/gym/session/ses_1', '#/gym/finish/ses_1', '#/gym/coach',
                      '#/gym/notes']) {
    assert.equal(gymRoutes.shell.bare(hash), false, hash);
  }
});

test('gym registers its settings as one section, in the product zone and never beside the account’s close', () => {
  assert.equal(Array.isArray(gymRoutes.settingsSections.main), true);
  assert.equal(gymRoutes.settingsSections.main.length, 1);
  assert.equal(typeof gymRoutes.settingsSections.main[0], 'object');
  assert.equal(gymRoutes.settingsSections.data, undefined, 'gym’s dials and its Notes door are the product’s, not the account’s');

  assert.equal(fs.existsSync(path.join(GYM, 'settings', 'GymSettingsSection.jsx')), true);
  assert.equal(fs.existsSync(path.join(GYM, 'settings', 'GymDataSection.jsx')), false);
});

test('gym hands the engine its sign-in hooks: the saved workouts and the drafts the account refused are its device work', () => {
  const { sync } = gymRoutes;
  assert.deepEqual(Object.keys(sync).sort(), ['adoptDeviceRows', 'liveHint', 'onPushResult', 'pendingDeviceWork', 'prepare',
    'seatWillChange', 'signInWork', 'signOutBegins', 'signOutForgets'], 'gym answers no sign-in question by itself: it asks whenever the account holds gym records');
  const copy = { session: { id: 'copyA001' }, sets: [] };
  const rows = { 'rack:adoption': { copyA001: copy }, 'rack:workoutDrafts': { 'import:a': { status: 'accepted' }, 'correction:b': { status: 'refused' } },
    runningTurn: { message: 'm1' } };
  assert.deepEqual({
    both: sync.pendingDeviceWork('gym', rows),
    accepted: sync.pendingDeviceWork('gym', { ...rows, 'rack:workoutDrafts': { 'import:a': { status: 'accepted' }, 'import:c': { status: 'pending' } } }),
    none: sync.pendingDeviceWork('gym', { runningTurn: { message: 'm1' } }),
    journal: sync.pendingDeviceWork('journal', rows),
  }, { both: ['rack:adoption', 'rack:workoutDrafts'], accepted: ['rack:adoption'], none: [], journal: [] });
});

test('a sign-in joining the account\'s dormant replica merges the saved workouts and drafts entry by entry, the account\'s standing on an entry both hold', () => {
  const { adoptDeviceRows } = gymRoutes.sync;
  const incoming = { 'rack:adoption': { copyB: 'browser B', copyA: 'browser A' }, 'rack:workoutDrafts': { 'import:b': 'browser draft' },
    'rack:rest': 'browser rest', picture: 'browser picture' };
  const kept = { 'rack:adoption': { copyA: 'account A' }, 'rack:rest': 'account rest' };
  assert.deepEqual(adoptDeviceRows('gym', incoming, kept), {
    'rack:adoption': { copyB: 'browser B', copyA: 'account A' }, 'rack:workoutDrafts': { 'import:b': 'browser draft' },
    'rack:rest': 'account rest', picture: 'browser picture',
  });
  assert.equal(adoptDeviceRows('journal', incoming, kept), undefined);
});

test('on the engine, a browser\'s saved workouts join the account beside those its dormant replica keeps', async (t) => {
  const { BrowserSyncEngine } = await import('../../../src/platform/sync/engine.js');
  const { environment } = await import('../../platform/sync/fakes.js');
  const env = environment();
  const { pendingDeviceWork, adoptDeviceRows } = gymRoutes.sync;
  // No connection, so the sign-out decides at once with nothing to flush.
  const engine = await BrowserSyncEngine.open({ ...env.options, navigator: { ...env.options.navigator, onLine: false }, pendingDeviceWork, adoptDeviceRows });
  t.after(() => engine.close());
  const keep = (copies) => engine.write(null, (device) => { device.activeReplica.device.gym = { ...device.activeReplica.device.gym, 'rack:adoption': copies }; });
  env.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  await keep({ accountCopy: { session: { id: 'accountCopy' }, sets: [] } });
  await engine.beginSignOut();
  assert.equal((await engine.finishSignOut({ choice: 'keep' })).complete, true);
  await keep({ browserCopy: { session: { id: 'browserCopy' }, sets: [] } });
  assert.equal((await engine.signIn('A')).complete, true);
  assert.deepEqual(Object.keys(engine.readDeviceRows('gym')['rack:adoption']).sort(), ['accountCopy', 'browserCopy']);
});
