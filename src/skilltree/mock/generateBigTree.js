// Synthetic perf-test tree: a wide, layered DAG grown from a handful of roots
// with branching factor 2-4, plus an occasional second prerequisite (a
// cross-link) so real diamonds show up. Deterministic given the seed — same
// (count, seed) always yields the same TreeData, byte for byte.

const ICONS = [
  'star', 'flag', 'zap', 'shield', 'flame', 'droplet', 'leaf', 'compass',
  'anchor', 'feather', 'gem', 'crown', 'sun', 'moon', 'cloud', 'mountain',
];

const ROOT_COUNT = 4;
const MIN_FAN_OUT = 2;
const FAN_OUT_SPREAD = 3; // fan-out is MIN_FAN_OUT..MIN_FAN_OUT+FAN_OUT_SPREAD-1, i.e. 2..4
const CROSS_LINK_CHANCE = 0.08;

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

export function generateBigTree(count = 5000, seed = 1) {
  const random = mulberry32(seed);
  const nodes = [];

  function addNode(prerequisites) {
    const node = { id: `n${nodes.length}`, label: `Skill ${nodes.length}`, icon: pick(random, ICONS), prerequisites };
    nodes.push(node);
    return node;
  }

  const rootCount = Math.min(count, ROOT_COUNT);
  let layer = [];
  for (let i = 0; i < rootCount; i++) layer.push(addNode([]));
  const layers = [layer];

  while (nodes.length < count) {
    const previous = layers[layers.length - 1];
    const nextLayer = [];
    for (const parent of previous) {
      if (nodes.length >= count) break;
      const fanOut = MIN_FAN_OUT + Math.floor(random() * FAN_OUT_SPREAD);
      for (let i = 0; i < fanOut && nodes.length < count; i++) nextLayer.push(addNode([parent.id]));
    }
    if (nextLayer.length === 0) break;
    layers.push(nextLayer);
  }

  for (let rank = 1; rank < layers.length; rank++) {
    const previous = layers[rank - 1];
    if (previous.length < 2) continue;
    for (const node of layers[rank]) {
      if (random() >= CROSS_LINK_CHANCE) continue;
      const candidate = pick(random, previous);
      if (candidate.id === node.prerequisites[0]) continue;
      node.prerequisites.push(candidate.id);
    }
  }

  return { id: 'huge-roadmap', title: `Generated Roadmap (${count})`, nodes };
}
