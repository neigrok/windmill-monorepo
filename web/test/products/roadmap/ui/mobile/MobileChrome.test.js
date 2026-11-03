import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register('../../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { MobileChrome } = await import('../../../../../src/products/roadmap/ui/mobile/MobileChrome.jsx');
const { FORK_OFFER, OPEN_STEP, STATE_WORDS } = await import('../../../../../src/products/roadmap/board/copy.js');

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

test('the selected-step bar has the owner action and reader title action with exact shared copy', () => {
  for (const state of ['locked', 'upNext', 'done']) {
    for (const reader of [false, true]) {
      const title = reader
        ? '<button type="button" class="st-graph-step-title">Read the wind</button>'
        : '<span class="st-graph-step-title">Read the wind</span>';
      const expected = '<div class="st-mobile-chrome" style="position:absolute;inset:0;pointer-events:none;z-index:20">'
        + '<div class="st-graph-step-bar" data-graph-step-bar=""><div class="st-graph-step-heading">'
        + title + `<span class="st-graph-step-state">${STATE_WORDS[state]}</span></div>`
        + '<button type="button" class="st-graph-step-primary" data-graph-step-primary="">'
        + (reader ? FORK_OFFER : OPEN_STEP) + '</button></div></div>';
      assert.equal(render({ identity: true, band: 'phone', cameraVisible: false,
        step: { id: 'wind', title: 'Read the wind', state }, onOpenStep() {},
        onFork: reader ? () => {} : null }), expected);
    }
  }
});

test('a selected step never changes legacy or wide chrome', async () => {
  const step = { id: 'wind', title: 'Read the wind', state: 'upNext' };
  assert.equal(render({ step }), render());
  for (const band of ['tablet', 'desktop']) {
    assert.equal(render({ identity: true, band, step }), render({ identity: true, band }));
  }
  assert.equal(render({ identity: true, band: 'phone', view: 'board', step }),
    render({ identity: true, band: 'phone', view: 'board' }));
});
