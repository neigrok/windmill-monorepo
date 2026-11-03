import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ShortcutsDialog } = await import('../../../../src/products/roadmap/shortcuts/ShortcutsDialog.jsx');

for (const view of ['graph', 'board']) {
  test(`${view} shortcut dialog matches its full markup snapshot`, async () => {
    const previous = globalThis.document;
    globalThis.document = { activeElement: null };
    try {
      const render = (props) => renderToStaticMarkup(React.createElement(ShortcutsDialog, { open: true, onClose() {}, ...props }));
      const expected = (await readFile(new URL(`ShortcutsDialog.${view}.html`, import.meta.url), 'utf8')).trimEnd();
      assert.equal(render({ view }), expected);
      if (view === 'graph') assert.equal(render({}), expected);
    } finally {
      globalThis.document = previous;
    }
  });
}

test('gated Graph shortcut dialog matches its full markup snapshot', async () => {
  const previous = globalThis.document;
  globalThis.document = { activeElement: null };
  try {
    const expected = (await readFile(new URL('ShortcutsDialog.graph-gated.html', import.meta.url), 'utf8')).trimEnd();
    const actual = renderToStaticMarkup(React.createElement(ShortcutsDialog, {
      open: true, onClose() {}, view: 'graph', boardOpen: true,
    }));
    assert.equal(actual, expected);
  } finally {
    globalThis.document = previous;
  }
});
