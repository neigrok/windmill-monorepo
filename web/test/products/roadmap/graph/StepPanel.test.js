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

const choice = (hue, label, checked) => `<button type="button" role="radio" aria-checked="${checked}" tabindex="${checked ? 0 : -1}" class="st-board-draft-kind-choice" style="--draft-kind:var(--kind-${hue});--draft-kind-ring:var(--kind-${hue}-ring)"><span><i aria-hidden="true"></i>${label}${checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>' : ''}</span></button>`;

test('StepPanel — the editor offers six named choices with Manage kinds beside them (08.11): the legend first, then the unnamed hues', () => {
  const html = renderToStaticMarkup(React.createElement(StepPanel, {
    node: { id: 'wind', label: 'Read the wind', color: 'sky' },
    state: 'available',
    prerequisites: [],
    legend: [
      { id: 'build', hue: 'terracotta', label: 'Build' },
      { id: 'learn', hue: 'olive', label: 'Learn' },
      { id: 'milestone', hue: 'gold', label: 'Milestone' },
    ],
  }));
  assert.equal(/<div class="st-step-kind">.*?<\/div><\/div>(?=<div class="st-step-danger")/.exec(html)[0], [
    '<div class="st-step-kind"><div class="st-step-kind-heading"><div class="st-step-heading">Kind</div>',
    '<button type="button" class="st-step-manage-kinds">Manage kinds</button></div>',
    '<div role="radiogroup" aria-label="Kind">',
    choice('terracotta', 'Build', false),
    choice('olive', 'Learn', false),
    choice('gold', 'Milestone', false),
    choice('brick', 'Brick', false),
    choice('sky', 'Sky', true),
    choice('plum', 'Plum', false),
    '</div></div>',
  ].join(''));
});
