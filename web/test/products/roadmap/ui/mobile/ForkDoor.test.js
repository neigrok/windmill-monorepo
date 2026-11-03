import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register('../../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ForkDoor } = await import('../../../../../src/products/roadmap/ui/mobile/ForkDoor.jsx');

const render = (props = {}) => renderToStaticMarkup(React.createElement(ForkDoor, {
  open: true, treeId: 'sail', stepCount: 8, onClose() {}, ...props,
}));

for (const presentation of ['sheet', 'dialog']) {
  test(`ForkDoor ${presentation} preserves its full legacy markup and ignores drawn`, async (t) => {
    const document = globalThis.document;
    globalThis.document = { activeElement: null };
    t.after(() => {
      if (document === undefined) delete globalThis.document;
      else globalThis.document = document;
    });
    const expected = (await readFile(new URL(`ForkDoor.${presentation}.html`, import.meta.url), 'utf8')).trimEnd();
    assert.equal(render({ presentation }), expected);
    assert.equal(render({ presentation, drawn: false }), expected);
    assert.equal(render({ presentation, drawn: true }), expected);
    assert.equal(render({ presentation, open: false }), '');
    if (presentation === 'sheet') assert.equal(render(), expected);
  });
}
