import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { KindChoice } = await import('../../../../src/products/roadmap/board/BoardControls.jsx');

const kinds = [{ hue: 'sky', label: 'Learn' }, { hue: 'olive', label: 'Practice' }];

test('KindChoice — selected markup matches the composer kind group', () => {
  const markup = renderToStaticMarkup(React.createElement(KindChoice, { kinds, value: 'sky', label: 'Kind', onChoose: () => {} }));
  assert.equal(markup, '<div role="radiogroup" aria-label="Kind"><button type="button" role="radio" aria-checked="true" tabindex="0" class="st-board-draft-kind-choice" style="--draft-kind:var(--kind-sky);--draft-kind-ring:var(--kind-sky-ring)"><span><i aria-hidden="true"></i>Learn<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg></span></button><button type="button" role="radio" aria-checked="false" tabindex="-1" class="st-board-draft-kind-choice" style="--draft-kind:var(--kind-olive);--draft-kind-ring:var(--kind-olive-ring)"><span><i aria-hidden="true"></i>Practice</span></button></div>');
});

test('KindChoice — null leaves every kind unchecked and the first kind tabbable', () => {
  const markup = renderToStaticMarkup(React.createElement(KindChoice, { kinds, value: null, label: 'Kind', onChoose: () => {} }));
  assert.equal(markup, '<div role="radiogroup" aria-label="Kind"><button type="button" role="radio" aria-checked="false" tabindex="0" class="st-board-draft-kind-choice" style="--draft-kind:var(--kind-sky);--draft-kind-ring:var(--kind-sky-ring)"><span><i aria-hidden="true"></i>Learn</span></button><button type="button" role="radio" aria-checked="false" tabindex="-1" class="st-board-draft-kind-choice" style="--draft-kind:var(--kind-olive);--draft-kind-ring:var(--kind-olive-ring)"><span><i aria-hidden="true"></i>Practice</span></button></div>');
});

for (const follow of [undefined, false]) {
  test(`KindChoice — arrows wrap focus${follow === false ? ' without choosing' : ' and choose by default'}`, () => {
    const chosen = [];
    const focused = [];
    const prevented = [];
    const group = KindChoice({ kinds, value: 'sky', label: 'Kind', onChoose: (hue) => chosen.push(hue), follow });
    const buttons = group.props.children;
    const currentTarget = { parentElement: { querySelectorAll: () => kinds.map((kind) => ({ focus: () => focused.push(kind.hue) })) } };
    for (const [index, key] of [[0, 'ArrowRight'], [1, 'ArrowDown'], [0, 'ArrowLeft'], [1, 'ArrowUp'], [0, 'Escape']]) {
      buttons[index].props.onKeyDown({ key, currentTarget, preventDefault: () => prevented.push(key) });
    }
    assert.deepEqual(focused, ['olive', 'sky', 'olive', 'sky']);
    assert.deepEqual(prevented, ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']);
    assert.deepEqual(chosen, follow === false ? [] : ['olive', 'sky', 'olive', 'sky']);
    buttons[1].props.onClick();
    assert.deepEqual(chosen, follow === false ? ['olive'] : ['olive', 'sky', 'olive', 'sky', 'olive']);
  });
}
