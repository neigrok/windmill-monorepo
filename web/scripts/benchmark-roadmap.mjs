// Lays the dogfood tree and the synthetic roadmaps out with every layout engine and prints the readability numbers
// the roadmap foundation is judged on, all at the desktop working zoom on a 1440x848 canvas.
//
//   node scripts/benchmark-roadmap.mjs [--only dogfood|shapes] [--sizes 500,5000] [--json <path>]
//
// An engine that is not built yet says so and the run continues.

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SkillTree } from '../src/products/roadmap/model/SkillTree.js';
import { UnlockRules } from '../src/products/roadmap/model/UnlockRules.js';
import { footprintOf, footprintRect } from '../src/products/roadmap/model/footprint.js';
import { LAYOUTS, loadLayoutEngine } from '../src/products/roadmap/layout/index.js';
import { NODE_SIZE, BODY_WU, WORKING_ZOOM, MIN_BODY_PX } from '../src/products/roadmap/theme.js';
import { loadDogfoodTree } from '../test/products/roadmap/fixtures/dogfoodTree.js';
import { largeRoadmap, ROADMAP_SHAPES } from '../test/products/roadmap/fixtures/largeRoadmap.js';

const WINDOW = { width: 1440, height: 848 };
const LONG_LINK_PX = 700;
const LAYOUT_RUNS = 5;
const FIT_PADDING = 0.9;

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1] ?? true);
const only = args.get('--only') ?? 'all';
const sizes = String(args.get('--sizes') ?? '500,5000').split(',').map(Number);

function fixtures() {
  const rows = [];
  if (only !== 'shapes') {
    const { tree, states } = loadDogfoodTree();
    rows.push({ name: 'dogfood', tree, states, anchorId: 'skilltree-scene' });
  }
  if (only !== 'dogfood') {
    for (const count of sizes) {
      for (const shape of ROADMAP_SHAPES) {
        const data = largeRoadmap(count, shape);
        const tree = new SkillTree({ id: data.id, title: data.title, nodes: data.nodes.map(({ status, ...node }) => node) });
        const progress = {
          completed: new Set(data.nodes.filter((node) => node.status === 'complete').map((node) => node.id)),
          inProgress: new Set(data.nodes.filter((node) => node.status === 'active').map((node) => node.id)),
        };
        rows.push({ name: `${shape}-${count}`, tree, states: UnlockRules.derive(tree, progress), anchorId: null });
      }
    }
  }
  return rows;
}

const quantile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
};
const px = (wu) => wu * WORKING_ZOOM;
const inWindow = (a, b) => Math.abs(a.x - b.x) * WORKING_ZOOM <= WINDOW.width / 2 && Math.abs(a.y - b.y) * WORKING_ZOOM <= WINDOW.height / 2;

function nearestNeighbours(points) {
  const cell = NODE_SIZE * 4;
  const cells = new Map();
  const keyOf = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const point of points) {
    const key = keyOf(point.x, point.y);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(point);
  }
  return points.map((point) => {
    let best = Infinity;
    for (let ring = 1; best === Infinity && ring <= 64; ring += 1) {
      const cx = Math.floor(point.x / cell);
      const cy = Math.floor(point.y / cell);
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dy = -ring; dy <= ring; dy += 1) {
          for (const other of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (other === point) continue;
            best = Math.min(best, Math.hypot(other.x - point.x, other.y - point.y));
          }
        }
      }
    }
    return best;
  });
}

function footprintOverlaps(tree, positions) {
  const rects = tree.nodes.map((node) => {
    const { x, y } = positions.get(node.id);
    return footprintRect(x, y, footprintOf(node.label, { root: node.prerequisites.length === 0 }));
  }).sort((a, b) => a.minX - b.minX);
  let overlaps = 0;
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length && rects[j].minX < rects[i].maxX; j += 1) {
      if (rects[j].minY < rects[i].maxY && rects[j].maxY > rects[i].minY) overlaps += 1;
    }
  }
  return overlaps;
}

function measure(engine, { tree, states, anchorId }) {
  const times = [];
  let positions = null;
  for (let run = 0; run < LAYOUT_RUNS; run += 1) {
    const start = performance.now();
    positions = engine.layout(tree);
    times.push(performance.now() - start);
  }
  const serialise = (map) => JSON.stringify([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  const deterministic = serialise(positions) === serialise(engine.layout(tree));

  const points = tree.nodes.map((node) => ({ id: node.id, ...positions.get(node.id) }));
  const byId = new Map(points.map((point) => [point.id, point]));
  const trunk = tree.trunk;
  const trunkLinks = tree.nodes
    .map((node) => [trunk.primaryParentOf(node.id), node.id])
    .filter(([parentId]) => parentId !== null)
    .map(([parentId, id]) => px(Math.hypot(byId.get(parentId).x - byId.get(id).x, byId.get(parentId).y - byId.get(id).y)));
  const nn = nearestNeighbours(points).map(px);
  const families = tree.nodes.map((node) => {
    const parentId = trunk.primaryParentOf(node.id);
    const kin = [...(parentId === null ? [] : [parentId]), ...trunk.trunkChildrenOf(node.id)];
    if (kin.length === 0) return null;
    return kin.filter((id) => inWindow(byId.get(id), byId.get(node.id))).length / kin.length;
  }).filter((share) => share !== null);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const bounds = { width: Math.max(...xs) - Math.min(...xs) + NODE_SIZE * 2, height: Math.max(...ys) - Math.min(...ys) + NODE_SIZE * 2 };
  const fitZoom = Math.min(Math.min(WINDOW.width / bounds.width, WINDOW.height / bounds.height) * FIT_PADDING, WORKING_ZOOM);
  const firstActive = tree.topoOrder().find((id) => states.get(id) === 'active') ?? null;
  const countAround = (id) => (id && byId.has(id) ? points.filter((point) => inWindow(point, byId.get(id))).length : null);

  return {
    nodes: tree.nodes.length,
    trunkPx: { median: quantile(trunkLinks, 0.5), p90: quantile(trunkLinks, 0.9), shareOver700: trunkLinks.filter((d) => d > LONG_LINK_PX).length / Math.max(1, trunkLinks.length) },
    nearestPx: { median: quantile(nn, 0.5), p10: quantile(nn, 0.1), medianBodies: quantile(nn, 0.5) / (BODY_WU * WORKING_ZOOM) },
    familyInView: families.reduce((sum, share) => sum + share, 0) / Math.max(1, families.length),
    footprintOverlaps: footprintOverlaps(tree, positions),
    boundsWu: bounds,
    fit: { zoom: fitZoom, bodyPx: BODY_WU * fitZoom, drawnBodyPx: Math.max(BODY_WU * fitZoom, MIN_BODY_PX) },
    inWorkingWindow: { anchor: anchorId, aroundAnchor: countAround(anchorId), firstActive, aroundFirstActive: countAround(firstActive) },
    layoutMs: quantile(times, 0.5),
    deterministic,
  };
}

const fmt = (value, digits = 0) => (value == null ? 'n/a' : Number(value).toFixed(digits));
const report = [];
for (const fixture of fixtures()) {
  for (const name of LAYOUTS) {
    let engine;
    try {
      engine = await loadLayoutEngine(name);
    } catch (error) {
      console.log(`${fixture.name} · ${name}: failed to load — ${error.message}`);
      report.push({ fixture: fixture.name, layout: name, error: error.message });
      continue;
    }
    try {
      const m = measure(engine, fixture);
      report.push({ fixture: fixture.name, layout: name, ...m });
      console.log(`${fixture.name} · ${name} (${m.nodes} nodes)`);
      console.log(`  trunk parent→child px  median ${fmt(m.trunkPx.median)}  p90 ${fmt(m.trunkPx.p90)}  > ${LONG_LINK_PX} px ${fmt(m.trunkPx.shareOver700 * 100, 1)}%`);
      console.log(`  nearest neighbour px   median ${fmt(m.nearestPx.median)}  p10 ${fmt(m.nearestPx.p10)}  (${fmt(m.nearestPx.medianBodies, 2)} bodies)`);
      console.log(`  family in view         ${fmt(m.familyInView * 100, 1)}%   footprint overlaps ${m.footprintOverlaps}`);
      console.log(`  bounds wu              ${fmt(m.boundsWu.width)} × ${fmt(m.boundsWu.height)}   fit zoom ${fmt(m.fit.zoom, 4)} → body ${fmt(m.fit.bodyPx, 1)} px (drawn ${fmt(m.fit.drawnBodyPx, 1)})`);
      console.log(`  in working window      around ${m.inWorkingWindow.anchor ?? '—'}: ${m.inWorkingWindow.aroundAnchor ?? 'n/a'}   around first active ${m.inWorkingWindow.firstActive ?? '—'}: ${m.inWorkingWindow.aroundFirstActive ?? 'n/a'}`);
      console.log(`  layout ${fmt(m.layoutMs, 2)} ms (median of ${LAYOUT_RUNS})   deterministic ${m.deterministic}`);
    } catch (error) {
      console.log(`${fixture.name} · ${name}: ${error.message}`);
      report.push({ fixture: fixture.name, layout: name, error: error.message });
    }
  }
}
if (args.has('--json')) writeFileSync(args.get('--json'), `${JSON.stringify({ window: WINDOW, workingZoom: WORKING_ZOOM, report }, null, 2)}\n`);
