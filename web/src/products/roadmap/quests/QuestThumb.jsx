// The seed-packet thumbnail (F5 §02): the quest's REAL layout, rendered fresh through
// the same SkillTree + radial engine the arrival will use — a tree that hasn't happened
// yet. Solid tier tints: the crowned root at available, everything else locked-dim,
// edges dormant. Pure SVG; the shelf's stylesheet owns the halo's one resting breath.

import React from 'react';
import { SkillTree } from '../model/SkillTree.js';
import { RadialLayoutEngine } from '../layout/RadialLayoutEngine.js';
import { NODE_COLORS, CONNECTOR, NODE_SIZE, DEFAULT_NODE_COLOR } from '../theme.js';

const LOCKED_INK = 0.28;
const HALO_RADIUS = NODE_SIZE * 1.15;

// Quests are static content — each layout is computed once per session, ever.
const scenes = new Map();

export function QuestThumb({ quest }) {
  if (!scenes.has(quest.id)) scenes.set(quest.id, layoutQuest(quest));
  const scene = scenes.get(quest.id);
  if (!scene) return null;

  return (
    <svg className="quest-thumb" viewBox={scene.viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {scene.edges.map((edge) => (
        <line
          key={edge.key}
          x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2}
          stroke={CONNECTOR.inactive} strokeWidth={3} opacity={0.55}
        />
      ))}
      <circle className="quest-thumb-halo" cx={scene.root.x} cy={scene.root.y} r={HALO_RADIUS} fill={scene.root.hue.glow} />
      {scene.placed.map((node) => (node.root ? (
        <circle key={node.id} cx={node.x} cy={node.y} r={NODE_SIZE * 0.62} fill={node.hue.base} stroke={node.hue.ring} strokeWidth={3} />
      ) : (
        <circle key={node.id} cx={node.x} cy={node.y} r={NODE_SIZE * 0.46} fill={node.hue.base} opacity={LOCKED_INK} />
      )))}
    </svg>
  );
}

export default QuestThumb;

// Quest module → placed circles, via the real entity + engine (GhostSkeleton's recipe,
// minus the cap and stagger a live parse needs). A quest the tree entity refuses hides
// its thumbnail instead of ever crashing the shelf — the gate test makes this unreachable.
function layoutQuest(quest) {
  let tree;
  try {
    tree = new SkillTree(quest);
  } catch {
    return null;
  }
  const positions = new RadialLayoutEngine().layout(tree);

  const placed = quest.nodes.map((node, index) => ({
    id: node.id,
    x: positions.get(node.id).x,
    y: positions.get(node.id).y,
    hue: NODE_COLORS[node.color] ?? NODE_COLORS[DEFAULT_NODE_COLOR],
    root: index === 0,
  }));
  const edges = tree.edges.map((edge) => ({
    key: `${edge.from}→${edge.to}`,
    x1: positions.get(edge.from).x,
    y1: positions.get(edge.from).y,
    x2: positions.get(edge.to).x,
    y2: positions.get(edge.to).y,
  }));

  const pad = NODE_SIZE * 1.4;
  const xs = placed.map((node) => node.x);
  const ys = placed.map((node) => node.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const viewBox = `${minX} ${minY} ${Math.max(...xs) + pad - minX} ${Math.max(...ys) + pad - minY}`;
  return { placed, edges, viewBox, root: placed[0] };
}
