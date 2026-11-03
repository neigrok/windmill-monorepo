import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { GraphChrome } = await import('../../../../src/products/roadmap/ui/GraphChrome.jsx');
const { COLUMN_TITLES, FORK_OFFER, OPEN_STEP } = await import('../../../../src/products/roadmap/copy.js');

const render = (props = {}) => renderToStaticMarkup(React.createElement(GraphChrome, { onFork() {}, ...props }));

test('the wide chrome renders only the drawn camera controls and never the reader fork pill', async () => {
  const expected = (await readFile(new URL('GraphChrome.wide.html', import.meta.url), 'utf8')).trimEnd();
  for (const band of ['tablet', 'desktop']) {
    assert.equal(render({ band, cameraRight: 408, cameraBottom: 24 }), expected);
  }
});

test('the phone chrome keeps the shipped camera below the row and the reader fork pill', async () => {
  const expected = (await readFile(new URL('GraphChrome.phone.html', import.meta.url), 'utf8')).trimEnd();
  assert.equal(render({ band: 'phone', rowBottom: 108 }), expected);
});

test('the selected-step bar has the owner action and reader title action with exact shared copy', () => {
  for (const state of ['locked', 'upNext', 'done']) {
    for (const reader of [false, true]) {
      const title = reader
        ? '<button type="button" class="st-graph-step-title">Read the wind</button>'
        : '<span class="st-graph-step-title">Read the wind</span>';
      const camera = render({ band: 'phone', onFork: null, rowBottom: 108 }).match(/<div class="st-view-actions".*<\/div>/)[0];
      const expected = '<div class="st-graph-chrome" style="position:absolute;inset:0;pointer-events:none;z-index:20">'
        + '<div class="st-graph-step-bar" data-graph-step-bar=""><div class="st-graph-step-heading">'
        + title + `<span class="st-graph-step-state">${COLUMN_TITLES[state]}</span></div>`
        + '<button type="button" class="st-graph-step-primary" data-graph-step-primary="">'
        + (reader ? FORK_OFFER : OPEN_STEP) + '</button></div>' + camera;
      assert.equal(render({ band: 'phone', rowBottom: 108,
        step: { id: 'wind', title: 'Read the wind', state }, onOpenStep() {},
        onFork: reader ? () => {} : null }), expected);
    }
  }
});

test('a selected step never changes wide or Board chrome', () => {
  const step = { id: 'wind', title: 'Read the wind', state: 'upNext' };
  for (const band of ['tablet', 'desktop']) {
    assert.equal(render({ band, step }), render({ band }));
  }
  assert.equal(render({ band: 'phone', view: 'board', step }), render({ band: 'phone', view: 'board' }));
});
