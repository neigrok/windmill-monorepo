import test from 'node:test';
import assert from 'node:assert/strict';

import { browserWith, elementsOf, loadScreen, renderHook, textOf } from '../products/gym/harness.mjs';

const choices = [{ value: 'recent', label: '90 days' }, { value: 'all', label: 'All' }];

test('without panels the switch is a row of plain buttons, as a filter is: no tab roles, no tab stops taken away', async (t) => {
  browserWith();
  const { Tabs } = await loadScreen('design-system/navigation/Tabs.jsx');
  const chosen = [];
  const row = renderHook(t, () => Tabs({ tabs: choices, value: 'recent', onChange: (value) => chosen.push(value) }));
  const [list, ...buttons] = elementsOf(row.tree);
  assert.deepEqual([list.type, list.props.role, list.props['aria-label'], list.props.onKeyDown], ['div', undefined, undefined, undefined]);
  assert.deepEqual(buttons.map((button) => [button.type, textOf(button), button.props.role, button.props['aria-selected'], button.props.tabIndex, button.props.type]),
    [['button', '90 days', undefined, undefined, undefined, undefined], ['button', 'All', undefined, undefined, undefined, undefined]]);
  buttons[1].props.onClick();
  assert.deepEqual(chosen, ['all']);
});

test('given panels the switch is a named tablist whose tabs control those panels, and the arrows move the choice', async (t) => {
  browserWith();
  const { Tabs } = await loadScreen('design-system/navigation/Tabs.jsx');
  const chosen = [];
  const row = renderHook(t, () => Tabs({ tabs: [{ value: 'workout', label: 'This workout' }, { value: 'coach', label: 'Coach' }], value: 'workout',
    onChange: (value) => chosen.push(value), variant: 'line', label: 'This workout and Coach', panels: 'side' }));
  const [list, ...tabs] = elementsOf(row.tree);
  assert.deepEqual([list.props.role, list.props['aria-label']], ['tablist', 'This workout and Coach']);
  assert.deepEqual(tabs.map((tab) => [tab.props.role, tab.props.id, tab.props['aria-controls'], tab.props['aria-selected'], tab.props.tabIndex, tab.props.type]),
    [['tab', 'side-workout', 'side-workout-panel', true, 0, 'button'], ['tab', 'side-coach', 'side-coach-panel', false, -1, 'button']]);
  let prevented = 0;
  list.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => { prevented += 1; } });
  list.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented += 1; } });
  assert.deepEqual([chosen, prevented], [['coach'], 1]);
});
