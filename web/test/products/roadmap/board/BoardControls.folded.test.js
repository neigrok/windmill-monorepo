import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { FindStep } = await import('../../../../src/products/roadmap/board/BoardControls.jsx');
const { BoardQuery } = await import('../../../../src/products/roadmap/board/Board.js');

const render = (props) => renderToStaticMarkup(React.createElement(FindStep, { query: new BoardQuery(), onQuery: () => {}, ...props }))
  .replace(/<svg[^>]*>.*?<\/svg>/g, '<svg/>');

test('FindStep folded: an empty query renders the named 44px trigger', () => {
  assert.equal(render({ folded: true }), '<button type="button" class="st-board-find-toggle" aria-label="Find a step" aria-keyshortcuts="/" title="Find a step"><svg/></button>');
});

test('FindStep folded: an active query retains the ordinary field markup', () => {
  const query = new BoardQuery().searchingFor('sail');
  assert.equal(render({ query, folded: true }), render({ query }));
});

test('FindStep default: the existing wide and phone fields keep their markup', () => {
  assert.equal(render(), '<div class="st-board-find st-board-find--wide "><svg/><input class="st-board-find-input" type="search" placeholder="Find a step" aria-label="Find a step" aria-keyshortcuts="/" enterKeyHint="search" autoComplete="off" spellcheck="false" value=""/><kbd class="st-board-keycap" aria-hidden="true">/</kbd></div>');
  assert.equal(render({ phone: true }), '<div class="st-board-find st-board-find--phone "><svg/><input class="st-board-find-input" type="search" placeholder="Find a step" aria-label="Find a step" aria-keyshortcuts="/" enterKeyHint="search" autoComplete="off" spellcheck="false" value=""/></div>');
});
