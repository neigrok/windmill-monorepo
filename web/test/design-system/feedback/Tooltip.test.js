import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

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
