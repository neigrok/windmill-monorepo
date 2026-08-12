// The route table is the whole seam between gym and the shell, and this wave gave it two jobs it
// did not have: telling the frame which chrome it is standing in, and bringing the cell the /app
// home grid draws. Both exist so that opening gym — one word on `shell.status` — is a change of
// state and not a change of code.
//
// The third thing pinned here is the landing's words, because they are the part of a product that
// goes stale silently. Every line on /gym used to be dated against `pre-open` ("In design", "when
// it opens", a hero pointing at what was already open), which made them false the moment the flag
// moved — and several of them were already false before it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gymRoutes } from '../../../src/products/gym/routes.js';
import { gymLandingHead } from '../../../src/products/gym/marketing/landingHead.js';
import { SITE_ORIGIN } from '../../../src/shell/marketing/siteIdentity.js';

const GYM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/products/gym');

// ONE ACCOUNT SEAT ON A SCREEN. Outside the shell nothing above GymApp paints anything, so the room
// floats its own seat and switcher; inside /app the shell already draws a seat — the rail's foot on
// a desk, the top bar's on a phone — and a rail that IS the switcher. The frame is TOLD which of
// the two it is in, because the shell resolves the room and the legacy-door upgrade in the same
// render that mounts the component, and a pathname read from inside can still be the pre-upgrade
// one. What arrives here is the pathname the frame actually resolved.
test('the frame is handed the chrome it is standing in, off the pathname the caller resolved', () => {
  const bare = [
    ['#/gym', '/'],
    ['#/gym/log', '/gym'],
    ['#/gym/movement/back-squat', '/t/t_abc'],
    // A pathname that merely starts with the same letters is not the shell.
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

  // A caller with no pathname to give resolves to the bare surface rather than throwing through a
  // render — the shell and the router both pass one today, and neither is this file's to trust.
  assert.deepEqual(gymRoutes.render({ hash: '#/gym' }).props, { hash: '#/gym', inShell: false });

  // Somebody else's URL is still somebody else's.
  assert.equal(gymRoutes.render({ hash: '#/journal/2026-08-01', pathname: '/app/journal' }), null);
  assert.equal(gymRoutes.render({ hash: '#/app/start', pathname: '/app/roadmap' }), null);
});

// AN OPEN PRODUCT WITHOUT A HomeCard IS ABSENT FROM THE GRID, not present in it: chrome/ShellHome
// renders `p.shell.HomeCard` for open products and renders nothing at all when there is none. So a
// gym that opened without this line would disappear from the /app home rather than appear on it —
// the exact opposite of what flipping the flag is for.
test('gym brings the cell the /app home grid draws once it is open', () => {
  assert.notEqual(gymRoutes.shell.HomeCard, undefined);
  assert.notEqual(gymRoutes.shell.HomeCard, null);
  assert.equal(fs.existsSync(path.join(GYM, 'HomeCard.jsx')), true);
  // Lazy, like every other product's: the grid is the first frame after sign-in.
  assert.equal(fs.readFileSync(path.join(GYM, 'routes.js'), 'utf8').includes("const HomeCard = lazy(() => import('./HomeCard.jsx')"), true);
});

// NOTHING HERE PINS WHICH WAY THE FLAG POINTS. Opening a product is a launch decision — the owner's,
// and the phase-1 dogfood gate has never run — so a test asserting 'pre-open' would be one more edit
// standing in the way of a one-line change. What is pinned is that the registry answers for both: the
// word is one of the two the shell knows, and the room, the door and the home it names are the same
// either way. (This used to name accountClosure.test.js as a real blocker on the flip, because it
// asserted at least one product was pre-open. It was fixed on the shell's side and says so in words
// — no test in the suite fails when the word changes. Checked 2026-08-07.)
test('the registry answers for either state of the flag', () => {
  assert.equal(['open', 'pre-open'].includes(gymRoutes.shell.status), true, gymRoutes.shell.status);
  assert.equal(gymRoutes.shell.room, '/app/gym');
  assert.equal(gymRoutes.switchHash, '#/gym');
  assert.equal(gymRoutes.home(), '#/gym');
  assert.equal(gymRoutes.landingAfterSignIn(), '#/gym');
  assert.equal(gymRoutes.shell.landingHref, gymRoutes.landing.href);
});

// ONE DOOR, TRUE IN BOTH STATES. #/gym renders the log today and upgrades in place to /app/gym the
// moment gym opens, so the landing's one verb needs no edit on either side of the flip. The words
// beside it describe what the product does; none of them names a date, a state or an arrival.
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

  // The account is the honest precondition, and it is stated at the door rather than behind it:
  // #/gym answers a visitor with no account with a sign-in pitch and nothing else.
  assert.equal(gymLandingHead.fallback.trust.includes('account'), true);
});

// The build script throws on a missing fallback field or a missing schema key, so the /gym shell is
// only ever as crawlable as this object is complete. An empty `schema` was the pre-open stance —
// "there is nothing to log yet" — and the product it described has been loggable for weeks.
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

// THE COACH'S PAGE IS NOT A ROOM, WHATEVER `status` SAYS. The shell's legacy door matches on a
// PREFIX, so '#/gym/shared/<token>' sits under '#/gym' and would be upgraded into /app/gym the day
// gym opens — drawing a rail, a product switcher and a Sign in seat around one workout, for somebody
// who is not signed in and may not have an account at all. The route table declares the exception
// because the shell may not name a product.
test('the coach link is declared bare, so opening gym never drags it into the room', () => {
  assert.equal(typeof gymRoutes.shell.bare, 'function');
  assert.equal(gymRoutes.shell.bare('#/gym/shared/tok_abc123'), true);

  // Everything that IS a room stays one — including a movement's record, which took the retired
  // statistics hash's place in this list when §H cut the fourth tab. It is the lifter's own page
  // about their own history, so it belongs inside the room like every other position here; only
  // the coach's token, which belongs to somebody with no account, stays out.
  for (const hash of ['#/gym', '#/gym/log', '#/gym/routines', '#/gym/movement/back-squat',
                      '#/gym/backfill', '#/gym/session/ses_1', '#/gym/finish/ses_1']) {
    assert.equal(gymRoutes.shell.bare(hash), false, hash);
  }
});

// ONE SECTION, AND THE SHELL NEVER LEARNS WHOSE IT IS. §I's five rows are registered here and
// composed by a settings page that names no product; the gym reaches nothing of the shell's own to
// place them. It sits in `data` — last, and directly above the account's close — because the export
// row inside it is exactly what that close's consent list means by "export what you want to keep
// first".
test('gym registers its settings as one section, in the slot the account’s close reads', () => {
  assert.equal(Array.isArray(gymRoutes.settingsSections.data), true);
  assert.equal(gymRoutes.settingsSections.data.length, 1);
  assert.equal(typeof gymRoutes.settingsSections.data[0], 'object');
  assert.equal(gymRoutes.settingsSections.main, undefined, 'gym contributes nothing to the product zone');

  // The export door moved INTO the five rows rather than being rebuilt beside them, so the file it
  // used to live in is gone rather than left behind holding a second copy.
  assert.equal(fs.existsSync(path.join(GYM, 'settings', 'GymSettingsSection.jsx')), true);
  assert.equal(fs.existsSync(path.join(GYM, 'settings', 'GymDataSection.jsx')), false);
});
