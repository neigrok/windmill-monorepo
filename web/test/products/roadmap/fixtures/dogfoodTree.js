// The Windmill dogfood layout fixture (476 steps, 618 links, 9 roots), slimmed to what layout and
// progress read. No creation stamps survive the capture, so siblings sort by id — the same order the rig's seeded
// copy shows in a browser.

import { readFileSync } from 'node:fs';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { UnlockRules } from '../../../../src/products/roadmap/model/UnlockRules.js';

const FIXTURE_URL = new URL('./dogfood-tree.json', import.meta.url);

export function dogfoodTreeData() {
  return JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
}

// { tree, progress, states } — the same three the load pipeline hands the layout and the scene.
export function loadDogfoodTree() {
  const data = dogfoodTreeData();
  const nodes = data.nodes.map(({ status, outOfOrder, ...node }) => node);
  const tree = new SkillTree({ id: data.id, title: data.title, kinds: data.kinds, nodes });
  const progress = {
    completed: new Set(data.nodes.filter((node) => node.status === 'complete').map((node) => node.id)),
  };
  return { tree, progress, states: UnlockRules.derive(tree, progress) };
}
