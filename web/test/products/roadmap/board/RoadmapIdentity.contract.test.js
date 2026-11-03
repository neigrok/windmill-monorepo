import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { RoadmapIdentity } = await import('../../../../src/products/roadmap/board/RoadmapIdentity.jsx');

for (const band of ['phone', 'tablet', 'desktop']) {
  const act = () => {};
  const props = {
    band, view: 'board', title: 'Learn to sail', progress: { done: 3, total: 8 },
    onSwitchView: act, onAskAI: act, onShare: act, onNewStep: act, onExport: act,
    onSettings: act, onShortcuts: act, onFork: act, sheet: {},
  };

  test(`RoadmapIdentity contract: ${band} accepts Activity without changing any role's markup`, () => {
    let calls = 0;
    for (const role of ['owner', 'reader', 'demo']) {
      const expected = renderToStaticMarkup(React.createElement(RoadmapIdentity, { ...props, role }));
      const actual = renderToStaticMarkup(React.createElement(RoadmapIdentity, {
        ...props, role, onActivity: () => { calls += 1; },
      }));
      assert.equal(actual, expected);
    }
    assert.equal(calls, 0);
  });

  test(`RoadmapIdentity contract: ${band} demo retains the non-owner presentation`, () => {
    const reader = renderToStaticMarkup(React.createElement(RoadmapIdentity, { ...props, role: 'reader' }));
    const demo = renderToStaticMarkup(React.createElement(RoadmapIdentity, { ...props, role: 'demo' }));
    assert.equal(demo, reader.replace('data-role="reader"', 'data-role="demo"'));
  });
}
