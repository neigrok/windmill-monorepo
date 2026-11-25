// The settings page on each seat: signed out it opens on the browser's own copy, with the product sections that run on it in
// the page's order, and signed in it is the account's page it has always been.

import test from 'node:test';
import assert from 'node:assert/strict';

import { gymRoutes } from '../../../src/products/gym/routes.js';
import { journalRoutes } from '../../../src/products/journal/routes.js';
import { roadmapRoutes } from '../../../src/products/roadmap/routes.js';
import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

// The page as the reader meets it, top to bottom: the heading, each line and button, and each section by its name, a
// product's sections by the registration they come from.
async function page(t, auth) {
  const { SettingsPage } = await loadScreen('shell/settings/SettingsPage.jsx');
  const sectionNames = new Map([
    [gymRoutes.settingsSections.main[0], 'gym · Your training log'],
    [roadmapRoutes.settingsSections.main[0], 'roadmap · Reminder'],
    [roadmapRoutes.settingsSections.main[1], 'roadmap · Tending'],
    [roadmapRoutes.settingsSections.data[0], 'roadmap · Your roadmaps'],
    [journalRoutes.settingsSections.data[0], 'journal · Your journal'],
  ]);
  const opened = [];
  const view = renderHook(t, () => SettingsPage({ inShell: true }), { context: { ...auth, open: () => opened.push('door') } });
  assert.equal(view.tree.props.bare, true);
  const read = elementsOf(view.tree.props.children).flatMap((element) => {
    if (element.type === 'h1') return [`# ${textOf(element)}`];
    if (element.type === 'p') return [textOf(element)];
    if (element.props.variant) return [`[${textOf(element.props.children)}] ${element.props.variant} ${element.props.size}`];
    if (element.props.sections) return element.props.sections.map((section) => sectionNames.get(section) ?? 'an unnamed section');
    if (typeof element.type === 'function') return [element.type.name];
    return [];
  });
  const signIn = elementsOf(view.tree.props.children).find((element) => element.props.variant === 'primary');
  return { read, signIn: () => { signIn.props.onClick(); return opened; } };
}

test('signed out, the page opens on the browser\'s copy: a way to sign in, then training log, roadmaps and journal', async (t) => {
  const { read, signIn } = await page(t, { status: 'ghost', user: null });
  assert.deepEqual(read, [
    '# Settings',
    'Sign in for your profile, sessions and connected tools.',
    '[Sign in] primary sm',
    'gym · Your training log',
    'roadmap · Your roadmaps',
    'journal · Your journal',
  ]);
  assert.deepEqual(signIn(), ['door']);
});

test('signed in, the page is the account\'s: its own sections around every product section, in their zones', async (t) => {
  const { read } = await page(t, { status: 'signed-in', user: { id: 'A', name: 'Ada', email: 'ada@example.com' } });
  assert.deepEqual(read, [
    '# Account settings',
    'ProfileSection',
    'roadmap · Reminder',
    'roadmap · Tending',
    'gym · Your training log',
    'ConnectedToolsSection',
    'ApiKeysSection',
    'SessionsSection',
    'FeedbackSection',
    'roadmap · Your roadmaps',
    'journal · Your journal',
    'CloseAccountSection',
  ]);
});

test('while the seat is unknown the page holds its title alone, the account\'s where this browser last held one', async (t) => {
  assert.deepEqual((await page(t, { status: 'loading', user: null })).read, ['# Settings']);
  assert.deepEqual((await page(t, { status: 'loading', user: { id: 'A', email: 'ada@example.com' } })).read, ['# Account settings']);
});
