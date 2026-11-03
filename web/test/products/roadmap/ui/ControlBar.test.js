import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ControlBar } = await import('../../../../src/products/roadmap/ui/ControlBar.jsx');

test('ControlBar — Share is offered only with a roadmap to share: no handler, no button', () => {
  const shares = (props) => renderToStaticMarkup(React.createElement(ControlBar, { board: true, ...props })).match(/aria-label="Share roadmap"/g)?.length ?? 0;
  assert.deepEqual([shares({ onShare: () => {} }), shares({})], [1, 0]);
});

test('ControlBar legacy chrome matches its full markup before the identity row', async () => {
  const expected = (await readFile(new URL('ControlBar.legacy.html', import.meta.url), 'utf8')).trimEnd();
  const actual = renderToStaticMarkup(React.createElement(ControlBar, {
    title: 'Learn to sail', onTend() {}, onShare() {}, activityOpen: true, activityUnread: 2, readyCount: 3,
  }));
  assert.equal(actual, expected);
});
