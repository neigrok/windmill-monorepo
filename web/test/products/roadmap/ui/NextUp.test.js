import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { NextUp } = await import('../../../../src/products/roadmap/ui/NextUp.jsx');

test('NextUp — blocked copy retains its empty-state structure', () => {
  assert.equal(renderToStaticMarkup(React.createElement(NextUp, { plan: { mode: 'blocked' } })),
    '<div class="st-nextup st-nextup--empty"><p class="st-nextup-line">Nothing up next yet</p></div>');
});

test('NextUp — the overflow keeps its action and retires a deleted featured step', () => {
  const plan = { mode: 'featured', featured: [{ id: 'deleted' }], overflow: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(renderToStaticMarkup(React.createElement(NextUp, { plan, nodesById: new Map(), states: new Map() })),
    '<div class="st-nextup"><div class="st-nextup-rows"></div><button type="button" class="st-nextup-more">+ 2 more up next</button></div>');
});
