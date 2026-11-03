import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ActivityFeed } = await import('../../../../src/products/roadmap/activity/ActivityFeed.jsx');

test('ActivityFeed — Up next leads the feed without changing its Activity section', () => {
  const feed = React.createElement(ActivityFeed, {
    groups: [], count: 0, nodesById: new Map(), nextUp: React.createElement('p', null, 'Read the wind'), readyPill: '1 up next',
  });
  assert.equal(renderToStaticMarkup(feed), readFileSync(new URL('./ActivityFeed.html', import.meta.url), 'utf8').trimEnd());
});
