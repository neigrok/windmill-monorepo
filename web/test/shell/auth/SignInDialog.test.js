import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWith, elementsOf, loadScreen, renderHook, settle, textOf } from '../../products/gym/harness.mjs';

for (const [code, expected] of [[null, 'Check your email'], ['rate_limited', "That's a few links in a row"], ['unreachable', "Can't reach windmill.works"]]) {
  test(`Sign in declaratively retains one title id through ${code ?? 'sent'}`, async (t) => {
    browserWith();
    const { SignInDialog } = await loadScreen('shell/auth/SignInDialog.jsx');
    const view = renderHook(t, () => SignInDialog({ open: true, onClose() {}, onSend: async () => {
      if (code) throw Object.assign(new Error('Fixture refusal'), { code });
    } }));
    const label = view.tree.props.labelledBy;
    const headings = () => elementsOf(view.tree).filter((element) => element.type === 'h2').map((element) => ({ id: element.props.id, text: textOf(element) }));
    assert.deepEqual(headings(), [{ id: label, text: 'Sign in' }]);
    elementsOf(view.tree).find((element) => element.type?.name === 'Input').props.onChange({ target: { value: 'fixture@example.com' } });
    elementsOf(view.tree).find((element) => element.type === 'form').props.onSubmit({ preventDefault() {} });
    await settle();
    assert.equal(view.tree.props.labelledBy, label);
    assert.deepEqual(headings(), [{ id: label, text: expected }]);
    const back = elementsOf(view.tree).find((element) => element.type?.name === 'Button' && textOf(element) === 'Use a different email');
    if (back) {
      back.props.onClick();
      assert.deepEqual(headings(), [{ id: label, text: 'Sign in' }]);
    }
  });
}
