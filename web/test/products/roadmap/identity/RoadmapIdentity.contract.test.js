import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { DEMO_BYLINE } = await import('../../../../src/products/roadmap/copy.js');
const { RoadmapIdentity } = await import('../../../../src/products/roadmap/identity/RoadmapIdentity.jsx');

for (const band of ['phone', 'tablet', 'desktop']) {
  const act = () => {};
  const props = {
    band, view: 'board', title: 'Learn to sail', progress: { done: 3, total: 8 },
    onSwitchView: act, onAskAI: act, onShare: act, onNewStep: act, onExport: act,
    onSettings: act, onShortcuts: act, onFork: act, sheet: {},
  };

  test(`RoadmapIdentity contract: ${band} Activity does not change a closed overlay or call its action during render`, () => {
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

  test(`RoadmapIdentity contract: ${band} demo adds exactly one sample badge to the reader presentation`, () => {
    const reader = renderToStaticMarkup(React.createElement(RoadmapIdentity, { ...props, role: 'reader' }));
    const demo = renderToStaticMarkup(React.createElement(RoadmapIdentity, { ...props, role: 'demo' }));
    const badge = `<span class="st-roadmap-sample">${band === 'phone' ? DEMO_BYLINE.phone : DEMO_BYLINE.wide}</span>`;
    const identity = reader.replace('data-role="reader"', 'data-role="demo"');
    const expected = band === 'phone'
      ? identity.replace('<div class="st-roadmap-context">', `${badge}<div class="st-roadmap-context">`)
      : identity.replace('<span class="st-roadmap-progress"', `${badge}<span class="st-roadmap-progress"`);
    assert.equal(demo, expected);
  });
}
