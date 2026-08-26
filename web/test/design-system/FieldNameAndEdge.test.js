import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { elementsOf, loadScreen, renderHook } from '../products/gym/harness.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');

test('a field’s NAME is its caption; its refusal and its unit are its description', async (t) => {
  const { Input } = await loadScreen('design-system/forms/Input.jsx');
  const drawn = (props) => renderHook(t, () => Input(props)).tree;

  const refused = drawn({
    label: 'Weight',
    value: '900',
    onChange: () => {},
    error: 'Over 500 kg — check the number.',
    describedBy: 'gym-target-decimal',
    trailing: 'kg',
  });
  const nodes = elementsOf(refused);
  const caption = nodes.find((each) => each.type === 'label');
  const field = nodes.find((each) => each.type === 'input');
  const refusal = nodes.find((each) => each.props?.id === `${field.props.id}-refusal`);

  // The caption reaches the field by htmlFor, so nothing else inside the row is read as its name.
  assert.equal(refused.type, 'div', 'the row is not a label wrapped around all three');
  assert.equal(caption.props.htmlFor, field.props.id);
  assert.equal(caption.props.children, 'Weight');
  assert.equal(elementsOf(caption).length, 1, 'the caption holds the caption and nothing else');
  assert.equal(refusal.props.children, 'Over 500 kg — check the number.');
  assert.equal(field.props['aria-describedby'], `${field.props.id}-refusal gym-target-decimal`);
  assert.equal(field.props['aria-invalid'], 'true');
  // The unit rides in the field's row, outside the caption: a description, never half a name.
  assert.equal(elementsOf(caption).some((each) => each.props?.children === 'kg'), false);

  const quiet = drawn({ label: 'Sets', value: '', onChange: () => {} });
  const settled = elementsOf(quiet).find((each) => each.type === 'input');
  assert.equal(settled.props['aria-describedby'], undefined, 'no refusal, no description');
  assert.equal(settled.props['aria-invalid'], undefined);

  // A caller may still name the field itself; the id it hands in is the one the caption points at.
  const named = drawn({ id: 'gym-new-movement', ariaLabel: 'Routine name', value: '', onChange: () => {} });
  const own = elementsOf(named).find((each) => each.type === 'input');
  assert.equal(own.props.id, 'gym-new-movement');
  assert.equal(own.props['aria-label'], 'Routine name');
});

test('the two edges a room may re-hue are tokens, and only gym re-points them', () => {
  // Wave C pointed both at --color-brand, which moved roadmap's and journal's fields off the
  // family's terracotta. They are roles now: the family answers them, and gym answers for itself.
  const input = read('design-system/forms/Input.jsx');
  assert.equal(input.includes("focus ? 'var(--field-focus-edge)' : 'var(--border-default)'"), true);
  assert.equal(/accent-terracotta|--color-brand\b/.test(input), false, 'the component names no hue');

  const tag = read('design-system/core/Tag.jsx');
  assert.equal(tag.includes("selected ? '1px solid var(--chip-selected-edge)'"), true);
  assert.equal(tag.includes("color: selected ? 'var(--color-brand-hover)'"), true, 'the ink is the room’s own already');
  assert.equal(/accent-terracotta/.test(tag), false);

  const tokens = read('styles/tokens/colors.css');
  assert.equal(tokens.includes('--field-focus-edge: var(--accent-terracotta-400);'), true);
  assert.equal(tokens.includes('--chip-selected-edge: var(--accent-terracotta-400);'), true);

  // Exactly one room answers them, and it answers them in both skins.
  const rooms = ['products/gym/gym.css', 'products/roadmap', 'products/journal'];
  const gym = read(rooms[0]);
  assert.equal((gym.match(/--field-focus-edge: var\(--color-brand\);/g) ?? []).length, 2);
  assert.equal((gym.match(/--chip-selected-edge: var\(--color-brand\);/g) ?? []).length, 2);
  const bridge = gym.slice(gym.indexOf('/* ── The bridge —'), gym.indexOf('/* Everything below paints'));
  assert.equal(bridge.includes('--field-focus-edge'), true, 'the re-point is in the bridge, not scattered');
  assert.equal(bridge.includes('--chip-selected-edge'), true);
  for (const room of rooms.slice(1)) {
    const inside = fs.readdirSync(path.join(SRC, room), { recursive: true })
      .filter((each) => typeof each === 'string' && each.endsWith('.css'))
      .map((each) => fs.readFileSync(path.join(SRC, room, each), 'utf8'))
      .join('\n');
    assert.equal(/--field-focus-edge|--chip-selected-edge/.test(inside), false, room);
  }
});

test('a button that stays tappable through its own request says it is busy', async (t) => {
  const { Button } = await loadScreen('design-system/core/Button.jsx');
  const busy = renderHook(t, () => Button({ children: 'Save', ariaBusy: true, onClick: () => {} })).tree;
  assert.equal(busy.props['aria-busy'], 'true');
  const idle = renderHook(t, () => Button({ children: 'Save', onClick: () => {} })).tree;
  assert.equal(idle.props['aria-busy'], undefined);
  // The one place gym asks for it: the note editor's Save, which never goes inert.
  const notes = read('products/gym/notes/Notes.jsx');
  assert.equal(notes.includes('ariaBusy={saving}'), true);
});
