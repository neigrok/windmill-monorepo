// Lays the dogfood tree and the synthetic roadmaps out with every layout engine and prints the readability numbers the
// roadmap foundation is judged on — the same measures the engine tests pin, from test/products/roadmap/fixtures/readability.js.
//
//   node scripts/benchmark-roadmap.mjs [--only dogfood|shapes] [--sizes 500,5000] [--json <path>]

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SkillTree } from '../src/products/roadmap/model/SkillTree.js';
import { UnlockRules } from '../src/products/roadmap/model/UnlockRules.js';
import { LAYOUTS, loadLayoutEngine } from '../src/products/roadmap/layout/index.js';
import { BODY_WU, WORKING_ZOOM, MIN_BODY_PX } from '../src/products/roadmap/theme.js';
import { loadDogfoodTree } from '../test/products/roadmap/fixtures/dogfoodTree.js';
import { largeRoadmap, ROADMAP_SHAPES } from '../test/products/roadmap/fixtures/largeRoadmap.js';
import {
  WINDOW, boundsOf, countAround, familyInView, fitZoom, footprintOverlaps, nearestNeighboursPx, quantile, serialise,
  trunkLinksPx,
} from '../test/products/roadmap/fixtures/readability.js';

const LONG_LINK_PX = 700;
const LAYOUT_RUNS = 5;

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

function measure(engine, { tree, states, anchorId }) {
  const times = [];
  let positions = null;
  for (let run = 0; run < LAYOUT_RUNS; run += 1) {
    const start = performance.now();
    positions = engine.layout(tree);
    times.push(performance.now() - start);
  }

  const trunkLinks = trunkLinksPx(tree, positions);
  const nearest = nearestNeighboursPx(positions);
  const bounds = boundsOf(positions);
  const zoom = fitZoom(positions);
  const firstActive = tree.topoOrder().find((id) => states.get(id) === 'active') ?? null;

  return {
    nodes: tree.nodes.length,
    trunkPx: { median: quantile(trunkLinks, 0.5), p90: quantile(trunkLinks, 0.9), shareOver700: trunkLinks.filter((d) => d > LONG_LINK_PX).length / Math.max(1, trunkLinks.length) },
    nearestPx: { median: quantile(nearest, 0.5), p10: quantile(nearest, 0.1), medianBodies: quantile(nearest, 0.5) / (BODY_WU * WORKING_ZOOM) },
    familyInView: familyInView(tree, positions),
    footprintOverlaps: footprintOverlaps(tree, positions).length,
    boundsWu: bounds,
    fit: { zoom, bodyPx: BODY_WU * zoom, drawnBodyPx: Math.max(BODY_WU * zoom, MIN_BODY_PX) },
    inWorkingWindow: { anchor: anchorId, aroundAnchor: anchorId && countAround(positions, anchorId), firstActive, aroundFirstActive: firstActive && countAround(positions, firstActive) },
    layoutMs: quantile(times, 0.5),
    deterministic: serialise(positions) === serialise(engine.layout(tree)),
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
