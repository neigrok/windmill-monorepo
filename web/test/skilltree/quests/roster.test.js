// The F4 gate (F5 §03): every starter quest passes the demo's test on itself before it
// ships — one obvious first move, a visible cascade, an honest DAG, no pre-lit status.
// npm test and npm run build both run this suite, so a roster violation refuses the build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROSTER } from '../../../src/skilltree/quests/roster/index.js';
import { SkillTree } from '../../../src/skilltree/model/SkillTree.js';
import { UnlockRules } from '../../../src/skilltree/model/UnlockRules.js';
import { NODE_COLOR_NAMES } from '../../../src/skilltree/theme.js';

const PINNED = [
  { id: 'frontend-path', steps: 24, audience: 'dev' },
  { id: 'rust-from-zero', steps: 21, audience: 'dev' },
  { id: 'ml-foundations', steps: 26, audience: 'dev' },
  { id: 'ship-v1', steps: 14, audience: 'dev' },
  { id: 'learn-to-sail', steps: 17, audience: 'life' },
  { id: 'run-a-10k', steps: 12, audience: 'life' },
  { id: 'room-makeover', steps: 9, audience: 'life' },
  { id: 'personal-finance-reset', steps: 11, audience: 'life' },
  { id: 'learn-watercolor', steps: 13, audience: 'life' },
];

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLOCKISH_ESTIMATE = /\d\s*(?:h|hrs?|hours?|m|mins?|minutes?)\b/i; // "12h 30m" precision is dishonest
const LABEL_MAX = 40;

test('the roster is the nine pinned quests, dev wedge first', () => {
  assert.deepStrictEqual(
    ROSTER.map((quest) => ({ id: quest.id, steps: quest.nodes.length, audience: quest.audience })),
    PINNED,
  );
});

for (const quest of ROSTER) {
  test(`${quest.id} — an honest, plantable quest`, () => {
    const tree = new SkillTree(quest); // throws on duplicate ids, unknown prerequisites, cycles

    const roots = quest.nodes.filter((node) => node.prerequisites.length === 0);
    assert.deepStrictEqual(roots, [quest.nodes[0]], 'exactly one root, and it is nodes[0]');

    const zeroProgress = { completed: new Set(), inProgress: new Set() };
    const atZero = UnlockRules.derive(tree, zeroProgress);
    assert.deepStrictEqual(
      quest.nodes.filter((node) => atZero.get(node.id) === 'available').map((node) => node.id),
      [quest.nodes[0].id],
      'zero progress must light exactly one available node — the root',
    );

    const afterRoot = UnlockRules.derive(tree, { completed: new Set([quest.nodes[0].id]), inProgress: new Set() });
    const cascade = quest.nodes.filter((node) => afterRoot.get(node.id) === 'available');
    assert.ok(cascade.length >= 2, `completing the root unlocks ${cascade.length} step(s) — the cascade must show at least 2`);

    assert.ok(quest.kinds.length >= 2 && quest.kinds.length <= 5, `carries ${quest.kinds.length} kinds — must be 2–5`);
    const hues = quest.kinds.map((kind) => kind.hue);
    assert.equal(new Set(hues).size, hues.length, 'kind hues must be unique');
    for (const hue of hues) assert.ok(NODE_COLOR_NAMES.includes(hue), `"${hue}" is not a palette hue`);
    assert.equal(quest.nodes[0].color, quest.kinds[0].hue, 'kinds[0] is the root\'s kind — the card rule reads it');

    const worn = new Set(quest.nodes.map((node) => node.color));
    for (const node of quest.nodes) assert.ok(hues.includes(node.color), `node "${node.id}" wears a hue no kind names`);
    for (const kind of quest.kinds) assert.ok(worn.has(kind.hue), `kind "${kind.id}" is worn by no node`);

    for (const node of quest.nodes) {
      assert.match(node.id, KEBAB_ID, `node id "${node.id}" is not a kebab-case slug`);
      assert.ok(typeof node.label === 'string' && node.label.length > 0 && node.label.length <= LABEL_MAX,
        `label of "${node.id}" must be 1–${LABEL_MAX} chars`);
      assert.ok(typeof node.description === 'string' && node.description.length > 0,
        `node "${node.id}" carries no description`);
      assert.ok(!('status' in node), `node "${node.id}" seeds a status — quests arrive unlit`);
      assert.ok(!('icon' in node), `node "${node.id}" carries an icon — the plant road crowns the root itself`);
      assert.ok(!('position' in node) && !('x' in node) && !('y' in node),
        `node "${node.id}" carries a position — the radial layout owns placement`);
    }

    assert.ok(typeof quest.estimate === 'string' && quest.estimate.length > 0, 'carries an estimate');
    assert.doesNotMatch(quest.estimate, CLOCKISH_ESTIMATE, `estimate "${quest.estimate}" must stay humble — no digit+h/min`);
  });
}
