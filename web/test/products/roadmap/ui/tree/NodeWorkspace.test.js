import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('../../../../jsxLoader.mjs', import.meta.url);
const { NodeWorkspace, renderMarkdown, SAFE_URL } = await import('../../../../../src/products/roadmap/ui/tree/NodeWorkspace.jsx');
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
