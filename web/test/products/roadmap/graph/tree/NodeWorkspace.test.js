import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('../../../../jsxLoader.mjs', import.meta.url);
const { NodeWorkspace, renderMarkdown, SAFE_URL } = await import('../../../../../src/products/roadmap/graph/tree/NodeWorkspace.jsx');
const { Checklist } = await import('../../../../../src/products/roadmap/graph/tree/Checklist.jsx');
const { Icon } = await import('../../../../../src/design-system/Icon.jsx');

const note = '**Read** the *wind*\nUse [charts](https://example.test/chart?x=1&y=2) and [email](mailto:coach@example.test).\n\n- Watch <water>\n- [Blocked](javascript:alert)\n\n[Relative](/local) [Data](data:text/html,unsafe) [HTTP](HTTP://example.test)';
const noteMarkup = '<p><strong>Read</strong> the <em>wind</em><br/>Use <a href="https://example.test/chart?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">charts</a> and <a href="mailto:coach@example.test" target="_blank" rel="noopener noreferrer">email</a>.</p>'
  + '<ul><li>Watch &lt;water&gt;</li><li>Blocked</li></ul>'
  + '<p>Relative Data <a href="HTTP://example.test" target="_blank" rel="noopener noreferrer">HTTP</a></p>';
const addMarkup = '<div class="st-ws-add"><button type="button" class="st-ws-add-btn" aria-haspopup="menu" aria-expanded="false">'
  + renderToStaticMarkup(React.createElement(Icon, { name: 'plus', size: 14 }))
  + 'Add to this step</button></div>';

test('exported note renderer preserves the complete dialect markup and safe link attributes', () => {
  assert.equal(renderToStaticMarkup(React.createElement(React.Fragment, null, renderMarkdown(note))), noteMarkup);
  assert.deepEqual([
    'https://example.test', 'http://example.test', 'HTTP://example.test', 'mailto:coach@example.test',
    'javascript:alert', 'data:text/html,unsafe', '/local', '//example.test',
  ].map((url) => [url, SAFE_URL.test(url)]), [
    ['https://example.test', true], ['http://example.test', true], ['HTTP://example.test', true], ['mailto:coach@example.test', true],
    ['javascript:alert', false], ['data:text/html,unsafe', false], ['/local', false], ['//example.test', false],
  ]);
});

test('the Graph workspace renders the same exported note inside its controls', () => {
  const markup = renderToStaticMarkup(React.createElement(NodeWorkspace, {
    nodeId: 'wind', workspace: { note, subtasks: [], links: [] }, hue: 'sky',
  }));
  assert.equal(markup, '<div><div class="st-step-heading">Note</div><div class="st-note-body">'
    + noteMarkup + '</div></div>' + addMarkup);
});

test('an empty Graph workspace offers its bootstrap', () => {
  assert.equal(renderToStaticMarkup(React.createElement(NodeWorkspace, {
    nodeId: 'wind', workspace: { note: '', subtasks: [], links: [] }, hue: 'sky',
  })), addMarkup);
  assert.equal(renderToStaticMarkup(React.createElement(React.Fragment, null, renderMarkdown(''))), '');
});

test('the Graph workspace names its list Subtasks, tallies it and offers Add subtask (04.05, 13:6)', () => {
  const icon = (name, size) => renderToStaticMarkup(React.createElement(Icon, { name, size }));
  const markup = renderToStaticMarkup(React.createElement(Checklist, {
    items: [{ id: 'halyard', label: 'Identify the halyard', done: true }, { id: 'sheets', label: 'Name the sheets', done: false }],
    hue: { base: 'var(--kind-sky)', ring: 'var(--kind-sky-ring)' },
  }));
  assert.equal(markup, [
    '<div><div class="st-check-head"><span class="st-step-heading">Subtasks</span><span class="st-check-count">1 of 2</span></div>',
    '<div class="st-check-list" style="--chk-base:var(--kind-sky);--chk-ring:var(--kind-sky-ring)">',
    `<div class="st-check-row"><span class="st-check-box st-check-box--done">${icon('check', 12).replace('stroke="currentColor"', 'stroke="#fff"')}</span>`,
    '<span class="st-check-label st-check-label--done">Identify the halyard</span>',
    `<button type="button" class="st-check-del" aria-label="Remove subtask">${icon('x', 13)}</button></div>`,
    '<div class="st-check-row"><span class="st-check-box "></span><span class="st-check-label ">Name the sheets</span>',
    `<button type="button" class="st-check-del" aria-label="Remove subtask">${icon('x', 13)}</button></div>`,
    `<button type="button" class="st-check-add">${icon('plus', 13)}Add subtask</button></div></div>`,
  ].join(''));
});

// packages/api-contract/roadmap-link-urls.json: the backend takes exactly the link urls this vector marks shown, and
// SAFE_URL shows exactly those.
test('a link url is shown exactly when the shared vector says the server takes it', () => {
  const vector = JSON.parse(readFileSync(new URL('../../../../../../packages/api-contract/roadmap-link-urls.json', import.meta.url), 'utf8'));
  assert.equal(vector.cases.length, 17);
  assert.deepEqual(vector.cases.map((one) => [one.url, SAFE_URL.test(one.url)]), vector.cases.map((one) => [one.url, one.shown]));
});
