import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { TreeSwitcher } = await import('../../../../src/products/roadmap/identity/TreeSwitcher.jsx');
const props = {
  current: { id: 'sail', title: 'Learn to sail', done: 3, total: 8, dominantKind: 'sky' },
  listTrees: async () => [], onNew() {},
};

test('TreeSwitcher matches its full markup', async () => {
  const expected = (await readFile(new URL('TreeSwitcher.html', import.meta.url), 'utf8')).trimEnd();
  assert.equal(renderToStaticMarkup(React.createElement(TreeSwitcher, props)), expected);
});
