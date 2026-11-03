import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { hueOf as themeHue } from '../../../../src/products/roadmap/theme.js';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ListView, hueOf } = await import('../../../../src/products/roadmap/list/ListView.jsx');

test('ListView — shelf heading, count and row aria states use the approved words in the full outline', () => {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'course', label: 'Choose a course', color: 'sky', prerequisites: [] },
    { id: 'wind', label: 'Read the wind', color: 'sky', prerequisites: ['course'] },
    { id: 'dock', label: 'Leave the dock', color: 'sky', prerequisites: ['wind'] },
  ] });
  const view = React.createElement(ListView, {
    tree, nodesById: tree.nodesById, states: new Map([['course', 'complete'], ['wind', 'available'], ['dock', 'locked']]),
    prefs: { foldedSections: () => [] }, treeId: tree.id, active: false, onSelect: () => {},
  });
  assert.equal(renderToStaticMarkup(view), readFileSync(new URL('./ListView.html', import.meta.url), 'utf8').trimEnd());
  assert.equal(hueOf, themeHue);
});
