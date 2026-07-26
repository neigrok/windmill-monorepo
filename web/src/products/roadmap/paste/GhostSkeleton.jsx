// The composer's ghost preview (paste-import F3 §02): the parsed plan grows beside
// the text as dashed, kind-tinted buds on dormant edges — pure SVG on the birth
// stage, no WebGL, structural only (no glow, no icons, no labels). The real radial
// layout places it, so the ghost is an honest preview of the arrival's shape.

import React, { useEffect, useRef, useState } from 'react';
import { SkillTree } from '../model/SkillTree.js';
import { RadialLayoutEngine } from '../layout/RadialLayoutEngine.js';
import { NODE_COLORS, CONNECTOR, NODE_SIZE, DEFAULT_NODE_COLOR } from '../theme.js';

const GHOST_CAP = 200;   // past this the preview stops growing — the readout still counts
const RELAYOUT_MS = 100; // keystrokes coalesce into one layout
const STAGGER_MS = 40;
const STAGGER_CAP_MS = 1200; // a giant paste still finishes entering inside the arrival budget

export function GhostSkeleton({ nodes }) {
  const [scene, setScene] = useState(null);
  const shownIds = useRef(new Set());

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = layoutGhost(nodes);
      if (!next) {
        shownIds.current = new Set();
        setScene(null);
        return;
      }
      // Entering ghosts fade in on the feedback cadence — 150ms, staggered ~40ms apiece.
      const entering = next.placed.filter((node) => !shownIds.current.has(node.id)).map((node) => node.id);
      next.delayOf = new Map(entering.map((id, index) => [id, Math.min(index * STAGGER_MS, STAGGER_CAP_MS)]));
      shownIds.current = new Set(next.placed.map((node) => node.id));
      setScene(next);
    }, RELAYOUT_MS);
    return () => clearTimeout(timer);
  }, [nodes]);

  if (!scene) return null;
  const delayOf = scene.delayOf;

  return (
    <svg className="birth-ghost" viewBox={scene.viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {scene.edges.map((edge) => (
        <line
          key={edge.key}
          className="birth-ghost-piece"
          style={delayOf.has(edge.enterWith) ? { animationDelay: `${delayOf.get(edge.enterWith)}ms` } : undefined}
          x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2}
          stroke={CONNECTOR.inactive} strokeWidth={3} opacity={0.55}
        />
      ))}
      {scene.placed.map((node) => {
        const hue = NODE_COLORS[node.color] ?? NODE_COLORS[DEFAULT_NODE_COLOR];
        return (
          <circle
            key={node.id}
            className="birth-ghost-piece"
            style={delayOf.has(node.id) ? { animationDelay: `${delayOf.get(node.id)}ms` } : undefined}
            cx={node.x} cy={node.y} r={node.root ? NODE_SIZE * 0.62 : NODE_SIZE * 0.46}
            fill={node.done ? hue.base : 'none'} fillOpacity={node.done ? 0.18 : 0}
            stroke={hue.base} strokeWidth={2.5} strokeDasharray="6 6" opacity={0.8}
          />
        );
      })}
    </svg>
  );
}

export default GhostSkeleton;

// Parsed nodes → placed ghosts, through the same SkillTree + radial layout the real
// arrival will use. A parse the tree entity refuses (it can't, by grammar contract —
// but belt and braces) hides the ghost instead of ever crashing the composer.
function layoutGhost(nodes) {
  if (!nodes || nodes.length === 0) return null;
  const capped = nodes.slice(0, GHOST_CAP);
  const ids = new Set(capped.map((node) => node.id));
  const data = {
    id: 'ghost',
    title: '',
    nodes: capped.map((node) => ({ ...node, prerequisites: node.prerequisites.filter((id) => ids.has(id)) })),
  };
  let tree;
  try {
    tree = new SkillTree(data);
  } catch {
    return null;
  }
  const positions = new RadialLayoutEngine().layout(tree);

  const placed = capped.map((node, index) => ({
    id: node.id,
    x: positions.get(node.id).x,
    y: positions.get(node.id).y,
    color: node.color,
    done: node.status === 'complete',
    root: index === 0,
  }));
  const edges = tree.edges.map((edge) => ({
    key: `${edge.from}→${edge.to}`,
    enterWith: edge.to,
    x1: positions.get(edge.from).x,
    y1: positions.get(edge.from).y,
    x2: positions.get(edge.to).x,
    y2: positions.get(edge.to).y,
  }));

  const pad = NODE_SIZE * 1.2;
  const xs = placed.map((node) => node.x);
  const ys = placed.map((node) => node.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const viewBox = `${minX} ${minY} ${Math.max(...xs) + pad - minX} ${Math.max(...ys) + pad - minY}`;
  return { placed, edges, viewBox };
}
