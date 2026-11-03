import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { StepPanel, ReadOnlyStateChip } = await import('../../../../src/products/roadmap/graph/StepPanel.jsx');

test('StepPanel — the available reader chip uses Up next with the same open state glyph', () => {
  const chip = React.createElement(ReadOnlyStateChip, { state: 'available', hue: { ring: 'var(--kind-olive-ring)' } });
  assert.equal(renderToStaticMarkup(chip),
    '<span style="display:inline-flex;align-items:center;gap:var(--space-2);padding:4px 11px;border-radius:var(--radius-full);font-size:var(--text-sm);font-weight:700;white-space:nowrap;background:transparent;border:1.5px solid var(--kind-olive-ring);color:var(--kind-olive-ring)"><span style="width:8px;height:8px;border-radius:50%;box-shadow:inset 0 0 0 2px var(--kind-olive-ring);flex-shrink:0" aria-hidden="true"></span>Up next</span>');
});


for (const state of ['available', 'complete', 'locked']) {
  test(`StepPanel — editor ${state} preserves the full panel and approved state copy`, () => {
    const props = {
      node: { id: 'sail', label: 'Set sail', color: 'sky' }, state,
      prerequisites: state === 'locked' ? [{ id: 'wind', label: 'Read the wind', complete: false }] : [],
    };
    assert.equal(renderToStaticMarkup(React.createElement(StepPanel, props)),
      readFileSync(new URL(`StepPanel.${state}.html`, import.meta.url), 'utf8').trimEnd());
  });
}
