import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register('../../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { MobileChrome } = await import('../../../../../src/products/roadmap/ui/mobile/MobileChrome.jsx');

const render = (props = {}) => renderToStaticMarkup(React.createElement(MobileChrome, {
  title: 'Learn to sail', progress: { done: 3, total: 8 }, dominantKind: 'sky', onFork() {}, ...props,
}));

test('MobileChrome without the identity row matches its full legacy markup', async () => {
  const expected = (await readFile(new URL('MobileChrome.legacy.html', import.meta.url), 'utf8')).trimEnd();
  assert.equal(render(), expected);
  assert.equal(render({ identity: false, rowBottom: 120 }), expected);
});

test('the wide identity chrome renders only the drawn camera controls and never the reader fork pill', async () => {
  const expected = (await readFile(new URL('MobileChrome.wide.html', import.meta.url), 'utf8')).trimEnd();
  for (const band of ['tablet', 'desktop']) {
    assert.equal(render({ identity: true, band, cameraRight: 408, cameraBottom: 24 }), expected);
  }
});

test('the phone identity chrome keeps the shipped camera below the row and the reader fork pill', async () => {
  const expected = (await readFile(new URL('MobileChrome.phone.html', import.meta.url), 'utf8')).trimEnd();
  assert.equal(render({ identity: true, band: 'phone', rowBottom: 108 }), expected);
});
