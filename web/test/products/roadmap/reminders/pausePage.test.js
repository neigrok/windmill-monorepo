// The pause door, held to what it can actually know. The server answers 204 whether or not the
// token matched — deliberately, so a guessed link is no oracle — which means this page only ever
// learns that it ASKED. A headline saying the reminder is off would be a claim it cannot back.
// The other two assertions are the GET-safety contract: the secret rides in the fragment, and
// nothing is sent until a person presses the button, because mail apps and corporate link
// scanners open every URL in an email on their own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../../../public/pause.html', import.meta.url), 'utf8');

test('the done state claims only what the page can know — that it asked', () => {
  assert.equal(page.includes('<h1>Pause requested</h1>'), true);
  assert.equal(page.includes('Reminders paused'), false);
});

test('the pause is bound to a click and never runs on load', () => {
  assert.equal(page.includes("button.addEventListener('click', send)"), true);
  assert.equal(page.includes("retry.addEventListener('click', send)"), true);
  assert.equal(/(^|[^.\w])send\(\)\s*;/m.test(page), false);
});

test('the token is read from the fragment, never the query string', () => {
  assert.equal(page.includes('location.hash'), true);
  assert.equal(page.includes('location.search'), false);
});
