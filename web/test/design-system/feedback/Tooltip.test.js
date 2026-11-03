import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { elementsOf, renderHook, textOf } from '../../products/gym/harness.mjs';

register('../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { Tooltip } = await import('../../../src/design-system/feedback/Tooltip.jsx');

test('Tooltip preserves its default wrapper and trigger when temporarily disabled', () => {
  const render = (props) => renderToStaticMarkup(React.createElement(Tooltip, { label: 'More', ...props },
    React.createElement('button', { type: 'button' }, 'More')));
  const markup = '<span style="position:relative;display:inline-flex"><button type="button">More</button></span>';
  assert.equal(render({}), markup);
  assert.equal(render({ disabled: false }), markup);
  assert.equal(render({ disabled: true }), markup);
});


test('Tooltip controlled opening uses the shared bubble and end-aligned bottom placement', () => {
  const child = React.createElement('button', { type: 'button' }, 'More');
  const markup = renderToStaticMarkup(React.createElement(Tooltip, {
    label: 'More detail', open: true, side: 'bottom', align: 'end',
  }, child));
  assert.equal(markup, '<span style="position:relative;display:inline-flex"><button type="button">More</button><span role="tooltip" style="position:absolute;top:100%;right:0;margin-top:8px;padding:6px 10px;background:var(--surface-inverse);color:var(--neutral-0);font-family:var(--font-body);font-size:var(--text-xs);font-weight:600;border-radius:var(--radius-md);white-space:nowrap;box-shadow:var(--shadow-md);animation:wm-fade-in-up var(--duration-fast) var(--ease-soft);z-index:20">More detail</span></span>');
  for (const props of [{ open: false }, { open: true, disabled: true }]) {
    assert.equal(renderToStaticMarkup(React.createElement(Tooltip, { label: 'More detail', ...props }, child)),
      '<span style="position:relative;display:inline-flex"><button type="button">More</button></span>');
  }
});


test('Tooltip keeps its hover behavior by default and controlled opening ignores hover state', (t) => {
  const props = { label: 'More detail', children: React.createElement('button', null, 'More') };
  const view = renderHook(t, () => Tooltip(props));
  const bubbles = () => elementsOf(view.tree).filter((element) => element.props.style?.position === 'absolute').map(textOf);
  assert.deepEqual(bubbles(), []);
  view.tree.props.onMouseEnter();
  assert.deepEqual(bubbles(), ['More detail']);
  view.tree.props.onMouseLeave();
  assert.deepEqual(bubbles(), []);
  props.open = false;
  view.redraw();
  view.tree.props.onMouseEnter();
  assert.deepEqual(bubbles(), []);
  props.open = true;
  view.redraw();
  view.tree.props.onMouseLeave();
  assert.deepEqual(bubbles(), ['More detail']);
});
