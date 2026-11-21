import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import sharedRoster from '../../../../../packages/api-contract/roadmap/quests/roster.json' with { type: 'json' };
import { ROSTER } from '../../../../src/products/roadmap/quests/roster.js';
import { ReplicaBirth } from '../../../../src/products/roadmap/room/ReplicaBirth.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { UnlockRules } from '../../../../src/products/roadmap/model/UnlockRules.js';
import { NODE_COLOR_NAMES } from '../../../../src/products/roadmap/theme.js';

test('the shared quests folder holds the roster and its README, and no file left unclaimed', () => {
  const files = readdirSync(new URL('../../../../../packages/api-contract/roadmap/quests/', import.meta.url));
  assert.deepStrictEqual(files.filter((name) => !name.startsWith('.')).sort(), ['README.md', 'roster.json']);
});

test('the shelf offers the nine pinned quests, dev wedge first', () => {
  assert.deepStrictEqual(
    ROSTER.map((quest) => ({ id: quest.id, steps: quest.nodes.length, group: quest.group })),
    [
      { id: 'frontend-path', steps: 24, group: 'dev' },
      { id: 'rust-from-zero', steps: 21, group: 'dev' },
      { id: 'ml-foundations', steps: 26, group: 'dev' },
      { id: 'ship-v1', steps: 14, group: 'dev' },
      { id: 'learn-to-sail', steps: 17, group: 'life' },
      { id: 'run-a-10k', steps: 12, group: 'life' },
      { id: 'room-makeover', steps: 9, group: 'life' },
      { id: 'personal-finance-reset', steps: 11, group: 'life' },
      { id: 'learn-watercolor', steps: 13, group: 'life' },
    ],
  );
});

for (const [index, shared] of sharedRoster.entries()) {
  test(`${shared.id} — the shelf's quest is the shared roster's, and its birth plants the roster's input`, () => {
    const quest = ROSTER[index];
    const birth = ReplicaBirth.creation(quest);
    assert.deepStrictEqual(
      {
        id: quest.id,
        group: quest.group,
        estimate: quest.estimate,
        source: quest.source,
        plants: { title: birth.title, kinds: birth.kinds, steps: birth.steps },
      },
      shared,
    );
  });
}

for (const quest of ROSTER) {
  test(`${quest.id} — an honest, plantable quest`, () => {
    const kebabId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const labelMax = 40;
    const tree = new SkillTree(quest); // throws on duplicate ids, unknown prerequisites, cycles

    const roots = quest.nodes.filter((node) => node.prerequisites.length === 0);
    assert.deepStrictEqual(roots, [quest.nodes[0]], 'exactly one root, and it is nodes[0]');

    const zeroProgress = { completed: new Set() };
    const atZero = UnlockRules.derive(tree, zeroProgress);
    assert.deepStrictEqual(
      quest.nodes.filter((node) => atZero.get(node.id) === 'available').map((node) => node.id),
      [quest.nodes[0].id],
      'zero progress must light exactly one available node — the root',
    );

    const afterRoot = UnlockRules.derive(tree, { completed: new Set([quest.nodes[0].id]) });
    const cascade = quest.nodes.filter((node) => afterRoot.get(node.id) === 'available');
    assert.ok(cascade.length >= 2, `completing the root unlocks ${cascade.length} step(s) — the cascade must show at least 2`);

    assert.ok(quest.kinds.length >= 2 && quest.kinds.length <= 5, `carries ${quest.kinds.length} kinds — must be 2–5`);
    const hues = quest.kinds.map((kind) => kind.hue);
    assert.equal(new Set(hues).size, hues.length, 'kind hues must be unique');
    for (const hue of hues) assert.ok(NODE_COLOR_NAMES.includes(hue), `"${hue}" is not a palette hue`);
    assert.equal(quest.nodes[0].color, quest.kinds[0].hue, 'kinds[0] is the root\'s kind — the card rule reads it');
    const kindIds = quest.kinds.map((kind) => kind.id);
    assert.equal(new Set(kindIds).size, kindIds.length, 'kind ids must be unique');
    for (const kind of quest.kinds) assert.match(String(kind.id), kebabId, `the kind wearing "${kind.hue}" has no kebab-case id of the web's`);

    const worn = new Set(quest.nodes.map((node) => node.color));
    for (const node of quest.nodes) assert.ok(hues.includes(node.color), `node "${node.id}" wears a hue no kind names`);
    for (const kind of quest.kinds) assert.ok(worn.has(kind.hue), `kind "${kind.id}" is worn by no node`);

    assert.deepStrictEqual(quest.nodes.map((node) => node.icon), ['sparkles', ...quest.nodes.slice(1).map(() => undefined)],
      'the root alone wears the birth spark');
    for (const node of quest.nodes) {
      assert.match(node.id, kebabId, `node id "${node.id}" is not a kebab-case slug`);
      assert.ok(typeof node.label === 'string' && node.label.length > 0 && node.label.length <= labelMax,
        `label of "${node.id}" must be 1–${labelMax} chars`);
      assert.ok(typeof node.description === 'string' && node.description.length > 0,
        `node "${node.id}" carries no description`);
      assert.ok(!('status' in node), `node "${node.id}" seeds a status — quests arrive unlit`);
      assert.ok(!('position' in node) && !('x' in node) && !('y' in node),
        `node "${node.id}" carries a position — the layout engine owns placement`);
    }

    assert.ok(typeof quest.estimate === 'string' && quest.estimate.length > 0, 'carries an estimate');
    assert.doesNotMatch(quest.estimate, /\d\s*(?:h|hrs?|hours?|m|mins?|minutes?)\b/i, `estimate "${quest.estimate}" must stay humble — no digit+h/min`);
  });
}
