import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../../emails/reminder.html', import.meta.url), 'utf8');
const text = readFileSync(new URL('../../../../emails/reminder.txt', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../../../emails/README.md', import.meta.url), 'utf8');

// A `{{` that is neither preceded nor followed by a third brace — i.e. the escaping tier.
const DOUBLE_BRACE = /(?<!\{)\{\{(?!\{)/g;

const variablesIn = (source) =>
  [...new Set([...source.matchAll(/\{\{\{(\w+)\}\}\}/g)].map((match) => match[1]))].sort();

test('every variable is triple-braced — raw substitution, no escaping tier', () => {
  assert.deepEqual(html.match(DOUBLE_BRACE), null);
  assert.deepEqual(text.match(DOUBLE_BRACE), null);
});

test('the steps are three fixed slots, never a provider-side repeat', () => {
  for (const source of [html, text]) {
    assert.equal(source.includes('#each'), false);
    assert.equal(source.includes('/each'), false);
    assert.equal(source.includes('{{{step_1_label}}}'), true);
    assert.equal(source.includes('{{{step_2_label}}}'), true);
    assert.equal(source.includes('{{{step_3_label}}}'), true);
  }
  assert.equal(html.includes('{{{step_1_color}}}'), true);
  assert.equal(html.includes('{{{step_2_color}}}'), true);
  assert.equal(html.includes('{{{step_3_color}}}'), true);
});

test('the in-tree remainder and the other-trees line are separate slots in both parts', () => {
  for (const source of [html, text]) {
    assert.equal(source.includes('{{{more_on_tree}}}'), true);
    assert.equal(source.includes('{{{more_ready}}}'), true);
  }
});

test('the README documents exactly the variables the reminder substitutes', () => {
  assert.equal(readme.includes('**reminder**'), true);
  assert.equal(readme.includes('## Dark mode'), true);
  const documented = readme.slice(readme.indexOf('**reminder**'), readme.indexOf('## Dark mode'));
  assert.deepEqual(variablesIn(documented), variablesIn(html + text));
});

test('the text twin carries no whitespace-only and no trailing-whitespace lines', () => {
  assert.deepEqual(text.match(/^[ \t]+$/gm), null);
  assert.deepEqual(text.match(/[ \t]+$/gm), null);
});

test('the footer keeps the promise line and the pause link', () => {
  for (const source of [html, text]) {
    assert.equal(source.includes('You get this once a week, only while a tree has steps ready.'), true);
    assert.equal(source.includes('{{{pause_url}}}'), true);
    assert.equal(source.includes('{{{settings_url}}}'), true);
  }
});

test('the settings link is documented hash-routed — a bare /settings falls through to the SPA root', () => {
  assert.equal(html.includes('https://windmill.works/#/settings'), true);
  assert.equal(/https:\/\/windmill\.works\/settings\b/.test(html), false);
});

test('the mail stays light-only — no dark block to fight Apple Mail with', () => {
  assert.equal(html.includes('prefers-color-scheme'), false);
  assert.equal(html.includes('<meta name="color-scheme" content="light">'), true);
  assert.equal(html.includes('<meta name="supported-color-schemes" content="light">'), true);
});
