import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { largeRoadmap } from '../test/products/roadmap/fixtures/largeRoadmap.js';

const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) options.set(args[index], args[index + 1]);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(options.get('--source') ?? `${webRoot}/src/products/roadmap`);
const { SkillTree } = await import(pathToFileURL(`${source}/model/SkillTree.js`));
const { RadialLayoutEngine } = await import(pathToFileURL(`${source}/layout/RadialLayoutEngine.js`));
const { NODE_SIZE } = await import(pathToFileURL(`${source}/theme.js`));
const fixtures = [];
for (const count of [300, 500, 1000, 5000]) {
  for (const shape of ['mixed', 'broad', 'deep', 'multiroot']) fixtures.push(largeRoadmap(count, shape));
}
if (options.has('--snapshot')) {
  const snapshot = JSON.parse(await readFile(options.get('--snapshot'), 'utf8'));
  fixtures.unshift(snapshot.tree ?? snapshot);
}

const results = [];
for (const fixture of fixtures) {
  const modelTimes = [];
  const layoutTimes = [];
  let tree;
  let positions;
  try {
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      tree = new SkillTree(fixture);
      modelTimes.push(performance.now() - start);
      const layoutStart = performance.now();
      positions = new RadialLayoutEngine().layout(tree);
      layoutTimes.push(performance.now() - layoutStart);
    }
    const points = [...positions.values()];
    const width = Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x)) + NODE_SIZE * 2;
    const height = Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y)) + NODE_SIZE * 2;
    const edgeLengths = tree.edges.map(edge => Math.hypot(
      positions.get(edge.from).x - positions.get(edge.to).x,
      positions.get(edge.from).y - positions.get(edge.to).y,
    )).sort((a, b) => a - b);
    const grid = new Map();
    let bodyOverlaps = 0;
    const bodyDiameter = NODE_SIZE * 0.84;
    const roots = tree.roots();
    const majorRoots = roots.length === 1 ? tree.trunk.trunkChildrenOf(roots[0].id) : roots.map(node => node.id);
    const sectorForNode = new Map();
    for (const sectorId of majorRoots) {
      const descendants = [sectorId];
      for (let index = 0; index < descendants.length; index++) {
        const id = descendants[index];
        sectorForNode.set(id, sectorId);
        descendants.push(...tree.trunk.trunkChildrenOf(id));
      }
    }
    const bandsByDepth = new Map();
    for (const node of tree.nodes) {
      const point = { ...positions.get(node.id), radius: bodyDiameter * (node.prerequisites.length === 0 ? 1.55 : 1) / 2 };
      const depth = tree.trunk.trunkDepthOf(node.id);
      const radius = Math.hypot(point.x, point.y);
      const sectorId = sectorForNode.get(node.id) ?? node.id;
      const bandKey = `${sectorId}:${depth}`;
      if (!bandsByDepth.has(bandKey)) bandsByDepth.set(bandKey, { sectorId, depth, nodes: 0, innerRadius: Infinity, outerRadius: 0 });
      const band = bandsByDepth.get(bandKey);
      band.nodes++;
      band.innerRadius = Math.min(band.innerRadius, radius);
      band.outerRadius = Math.max(band.outerRadius, radius);
      const cellX = Math.floor(point.x / (NODE_SIZE * 2));
      const cellY = Math.floor(point.y / (NODE_SIZE * 2));
      for (let x = cellX - 1; x <= cellX + 1; x++) {
        for (let y = cellY - 1; y <= cellY + 1; y++) {
          for (const other of grid.get(`${x},${y}`) ?? []) {
            if (Math.hypot(point.x - other.x, point.y - other.y) < point.radius + other.radius) bodyOverlaps++;
          }
        }
      }
      const key = `${cellX},${cellY}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(point);
    }
    const depthBands = [...bandsByDepth.values()].sort((a, b) => a.sectorId.localeCompare(b.sectorId) || a.depth - b.depth);
    const depthGaps = depthBands.slice(1).flatMap((band, index) => band.sectorId === depthBands[index].sectorId
      ? [band.innerRadius - depthBands[index].outerRadius] : []);
    results.push({
      id: fixture.id, nodes: tree.nodes.length, edges: tree.edges.length, roots: tree.roots().length,
      maxTrunkDepth: Math.max(...tree.nodes.map(node => tree.trunk.trunkDepthOf(node.id))),
      modelMs: modelTimes.sort((a, b) => a - b)[1], layoutMs: layoutTimes.sort((a, b) => a - b)[1],
      width, height, area: width * height, bodyOverlaps,
      medianEdge: edgeLengths[Math.floor(edgeLengths.length / 2)] ?? 0,
      p95Edge: edgeLengths[Math.floor(edgeLengths.length * 0.95)] ?? 0,
      maxEdge: edgeLengths.at(-1) ?? 0,
      minSectorDepthBandGap: depthGaps.length ? Math.min(...depthGaps) : null,
      depthBands,
    });
  } catch (error) {
    results.push({ id: fixture.id, nodes: fixture.nodes.length, error: error.message });
  }
}
const report = JSON.stringify({ source, runtime: process.version, platform: process.platform, architecture: process.arch, samples: 3, results }, null, 2) + '\n';
if (options.has('--output')) await writeFile(options.get('--output'), report);
else process.stdout.write(report);
