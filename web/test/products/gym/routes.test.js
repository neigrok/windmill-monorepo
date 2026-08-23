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
    gymRoutes.landing.summary,
  ].join('  ');
  for (const dated of ['when it opens', 'In design', 'in design', 'already open', 'coming soon', 'Coming soon']) {
    assert.equal(words.includes(dated), false, dated);
  }

  assert.equal(gymLandingHead.fallback.trust.includes('account'), true);
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

test('the coach link is declared bare, so opening gym never drags it into the room', () => {
  assert.equal(typeof gymRoutes.shell.bare, 'function');
  assert.equal(gymRoutes.shell.bare('#/gym/shared/tok_abc123'), true);

  for (const hash of ['#/gym', '#/gym/log', '#/gym/routines', '#/gym/movement/back-squat',
                      '#/gym/backfill', '#/gym/session/ses_1', '#/gym/finish/ses_1']) {
    assert.equal(gymRoutes.shell.bare(hash), false, hash);
  }
});

test('gym registers its settings as one section, in the slot the account’s close reads', () => {
  assert.equal(Array.isArray(gymRoutes.settingsSections.data), true);
  assert.equal(gymRoutes.settingsSections.data.length, 1);
  assert.equal(typeof gymRoutes.settingsSections.data[0], 'object');
  assert.equal(gymRoutes.settingsSections.main, undefined, 'gym contributes nothing to the product zone');

  assert.equal(fs.existsSync(path.join(GYM, 'settings', 'GymSettingsSection.jsx')), true);
  assert.equal(fs.existsSync(path.join(GYM, 'settings', 'GymDataSection.jsx')), false);
});
