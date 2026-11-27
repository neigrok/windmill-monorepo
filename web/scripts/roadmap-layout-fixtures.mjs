// The Graph's shared fixtures (packages/api-contract/roadmap/layout): roadmaps, and the picture the web draws of each.
// `node scripts/roadmap-layout-fixtures.mjs` writes every file; test/products/roadmap/layout/fixtures.test.js fails
// when a committed file is not what this gives.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Stamp } from '../../packages/api-contract/sync/reference/core/stamp.js';
import { authoredOrder } from '../src/products/roadmap/domain/records.js';
import { BubbleLayoutEngine } from '../src/products/roadmap/layout/BubbleLayoutEngine.js';
import { PI, REDUCIBLE_BELOW, asin, atan, atan2, cos, hypot, sin } from '../src/products/roadmap/layout/arithmetic.js';
import { fallbackLayoutEngine, layoutTree } from '../src/products/roadmap/layout/index.js';
import { SkillTree } from '../src/products/roadmap/model/SkillTree.js';
import { SpatialGrid } from '../src/products/roadmap/model/SpatialGrid.js';
import { domainReading } from '../src/products/roadmap/model/domainReads.js';
import { CaptionPlacer, captionRankLimit, wrapCaption } from '../src/products/roadmap/scene/captionLayout.js';
import { bendOf, controlPoint } from '../src/products/roadmap/scene/edgeCurve.js';
import { fitFrame, focusFrame, minZoom } from '../src/products/roadmap/scene/framing.js';
import { nKeysBetween } from '../src/products/roadmap/sync/fractionalIndex.js';
import { CAPTION, NODE_SIZE, PHONE_WORKING_ZOOM, WORKING_ZOOM, nodeTier } from '../src/products/roadmap/theme.js';

const HUES = ['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum'];
const BORN_MS = 1750000000000;
const WORDS = ['Stow', 'the', 'spare', 'anchor', 'chain', 'below', 'deck', 'before', 'the', 'tide', 'turns', 'again'];

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// Rows of [id, label, color, follows] as steps in the domain's authored order, each born a second after the one before.
function stepsOf(rows) {
  const ords = nKeysBetween(null, null, rows.length);
  return rows
    .map(([id, label, color, follows], index) => ({ id, label, ord: ords[index], born: `${BORN_MS + index * 1000}:${index % 3}:phone`, color, follows }))
    .sort(authoredOrder);
}

const phrase = (count, from = 0) => Array.from({ length: count }, (_, index) => WORDS[(from + index) % WORDS.length]).join(' ');

// A tree of `count` steps whose every step follows one drawn from the `reach` steps before it, and now and then a second.
function seededTree(prefix, count, seed, { reach, second }) {
  const random = seededRandom(seed);
  const rows = [[`${prefix}0`, phrase(3), HUES[0], []]];
  for (let index = 1; index < count; index++) {
    const parent = Math.max(0, index - 1 - Math.floor(random() * reach));
    const follows = [`${prefix}${parent}`];
    const other = Math.floor(random() * index);
    if (random() < second && other !== parent) follows.push(`${prefix}${other}`);
    rows.push([`${prefix}${index}`, phrase(1 + Math.floor(random() * 6), index), HUES[Math.floor(random() * 3)], follows]);
  }
  return rows;
}

function learnToSail() {
  return {
    name: 'learn-to-sail', engine: 'bubble', done: ['choose', 'parts', 'rig'], selected: 'read', hovered: 'leave',
    steps: stepsOf([
      ['choose', 'Choose a sailing course', 'terracotta', []],
      ['parts', 'Name the boat parts', 'sky', ['choose']],
      ['rig', 'Rig the boat', 'terracotta', ['parts']],
      ['read', 'Read the wind', 'sky', ['parts']],
      ['tie', 'Tie a bowline', 'olive', ['parts']],
      ['leave', 'Leave the dock', 'terracotta', ['rig', 'read']],
      ['tri', 'Sail a triangle', 'olive', ['leave']],
      ['solo', 'Sail solo', 'gold', ['tri', 'tie']],
    ]),
  };
}

function wide() {
  const rows = [['hub', 'Provision the boat', 'gold', []]];
  for (let spoke = 0; spoke < 56; spoke++) {
    rows.push([`w${spoke}`, phrase(1 + (spoke % 7), spoke), HUES[spoke % HUES.length], ['hub']]);
    if (spoke % 4 !== 0) continue;
    for (let leaf = 0; leaf < 3; leaf++) rows.push([`w${spoke}.${leaf}`, phrase(2 + leaf, spoke + leaf), HUES[spoke % HUES.length], [`w${spoke}`]]);
  }
  return { name: 'wide', engine: 'bubble', done: ['hub', 'w0', 'w1', 'w2', 'w3', 'w4', 'w0.0'], selected: 'w8', hovered: 'w8.1', steps: stepsOf(rows) };
}

function deep() {
  const rows = [];
  for (let leg = 0; leg < 160; leg++) {
    const follows = leg === 0 ? [] : [`d${leg - 1}`];
    if (leg % 25 === 0 && leg > 0) follows.push(`d${leg - 10}`);
    rows.push([`d${leg}`, `Leg ${leg + 1} ${phrase(leg % 4, leg)}`.trim(), HUES[Math.floor(leg / 20) % HUES.length], follows]);
    if (leg % 7 === 3) rows.push([`d${leg}.s`, phrase(2, leg), HUES[Math.floor(leg / 20) % HUES.length], [`d${leg}`]]);
  }
  return { name: 'deep', engine: 'bubble', done: rows.slice(0, 40).map(([id]) => id), selected: 'd35', hovered: 'd36', steps: stepsOf(rows) };
}

function scripts() {
  const labels = [
    'Caf\u00e9 cr\u00e8me br\u00fbl\u00e9e \u00e0 la fran\u00e7aise',
    'Cafe\u0301 de\u0301compose\u0301',
    'Za\u017c\u00f3\u0142\u0107 g\u0119\u015bl\u0105 ja\u017a\u0144',
    '\u0421\u044a\u0435\u0448\u044c \u0435\u0449\u0451 \u044d\u0442\u0438\u0445 \u043c\u044f\u0433\u043a\u0438\u0445 \u0444\u0440\u0430\u043d\u0446\u0443\u0437\u0441\u043a\u0438\u0445 \u0431\u0443\u043b\u043e\u043a',
    '\u5b66\u4e60\u822a\u6d77\u7684\u57fa\u672c\u77e5\u8bc6\u548c\u5b89\u5168\u89c4\u5219\u4ee5\u53ca\u5929\u6c14\u9884\u62a5\u7684\u9605\u8bfb\u65b9\u6cd5',
    '\u65e5\u672c\u8a9e\u306e\u30e9\u30d9\u30eb',
    '\u062a\u0639\u0644\u0645 \u0627\u0644\u0625\u0628\u062d\u0627\u0631 \u0641\u064a \u0627\u0644\u0628\u062d\u0631 \u0627\u0644\u0645\u0641\u062a\u0648\u062d',
    '\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd',
    '\u26f5\ufe0f Sail \u{1f30a}\u{1f32c}\ufe0f away',
    '\u{1f469}\u{1f3fd}\u200d\u{1f680}\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}\u{1f1fa}\u{1f1e6}',
    '\u{1f680}'.repeat(40),
    '',
    '   ',
    'Tabs\tand\nnew\u00a0lines\u3000wide\ufeffmarks\u0085next',
    'zero\u200bwidth\u200djoiners',
    '\uff46\uff55\uff4c\uff4c\uff57\uff49\uff44\uff54\uff48\u3000\uff54\uff45\uff58\uff54',
    '\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35\u0e0a\u0e32\u0e27\u0e42\u0e25\u0e01',
    '\u0928\u092e\u0938\u094d\u0924\u0947 \u0926\u0941\u0928\u093f\u092f\u093e',
    'x'.repeat(200),
    'One two three four five six seven eight nine ten eleven twelve',
  ];
  const rows = [['voyage', 'A voyage in every script', 'sky', []]];
  labels.forEach((label, index) => rows.push([`s${index}`, label, HUES[index % HUES.length], [index < 6 ? 'voyage' : `s${index - 6}`]]));
  return { name: 'scripts', engine: 'bubble', done: ['voyage', 's0', 's1', 's2'], selected: 's4', hovered: 's10', steps: stepsOf(rows) };
}

// Ids whose order differs between UTF-16 code units, code points and canonical equivalence, in every tie the picture breaks by id.
function ids() {
  const spellings = ['\u00e9', 'e\u0301', '\u00c5', 'A\u030a', '\u212b', '\uac00', '\u1100\u1161', '\u{1f600}', '\uff21', '\ue000', '\u{10000}', 'z', 'Z', 'a-b', 'a', 'b-c'];
  const step = (id, follows, { ord = 'a5', born = `${BORN_MS}:0:phone`, label = `Spelled ${id}` } = {}) => ({ id, label, ord, born, color: 'sky', follows });
  const steps = [
    step('origin', [], { ord: 'a0', label: 'Every spelling' }),
    ...spellings.map((id) => step(id, ['origin'])),
    step('elects-astral', ['\uff21', '\u{1f600}']),
    step('elects-decomposed', ['\u00e9', 'e\u0301']),
    step('elects-letter-and-ring', ['\u00c5', 'A\u030a', '\u212b']),
    step('elects-jamo', ['\uac00', '\u1100\u1161']),
    step('elects-first-astral', ['\ue000', '\u{10000}']),
    step('born-later-actor', ['z'], { born: '5:0:b' }),
    step('born-earlier-actor', ['z'], { born: '5:0:a' }),
    step('born-later-counter', ['z'], { born: '5:1:a' }),
    step('born-earlier-ms', ['z'], { born: '4:9:z' }),
    step('born-unset', ['z'], { born: '0:0:' }),
    step('ord-empty', ['Z'], { ord: '' }),
    step('ord-upper', ['Z'], { ord: 'Zz' }),
    step('ord-short', ['Z'], { ord: 'a0' }),
    step('ord-long', ['Z'], { ord: 'a0V' }),
    step('\uff21\uff21', [], { label: 'A root spelled wide' }),
    step('\u{1f600}\u{1f600}', [], { label: 'A root spelled astral' }),
  ];
  return { name: 'ids', engine: 'bubble', done: ['origin', '\u00e9', 'e\u0301'], selected: '\u{1f600}', hovered: '\uff21', steps: steps.sort(authoredOrder) };
}

function braided() {
  const rows = seededTree('b', 48, 11, { reach: 12, second: 0.45 });
  rows.forEach((row, index) => {
    if (index > 4 && index % 5 === 0 && !row[3].includes(`b${index - 3}`)) row[3].push(`b${index - 3}`);
  });
  return { name: 'braided', engine: 'bubble', done: rows.slice(0, 15).map(([id]) => id), selected: 'b20', hovered: 'b21', steps: stepsOf(rows) };
}

function islands() {
  const rows = [
    ...seededTree('north', 15, 3, { reach: 4, second: 0 }),
    ...seededTree('south', 7, 5, { reach: 3, second: 0 }),
    ...seededTree('east', 7, 7, { reach: 3, second: 0 }),
    ...seededTree('west', 3, 9, { reach: 2, second: 0 }),
    ['stray-a', 'A step on its own', 'plum', []],
    ['stray-b', '', 'plum', []],
    ['stray-c', 'Another step that follows nothing and opens nothing', 'brick', []],
  ];
  return { name: 'islands', engine: 'bubble', done: ['north0', 'north1', 'south0'], selected: 'south3', hovered: 'stray-a', steps: stepsOf(rows) };
}

// Many small trees packed close: more steps in one view than the captions weigh, and more names than their pool holds.
function archipelago() {
  const rows = [];
  for (let isle = 0; isle < 120; isle++) {
    rows.push([`a${isle}`, phrase(1, isle), HUES[isle % HUES.length], []]);
    for (let step = 1; step < 4; step++) rows.push([`a${isle}.${step}`, phrase(1, isle + step), HUES[isle % HUES.length], [step === 3 ? `a${isle}.1` : `a${isle}`]]);
  }
  return { name: 'archipelago', engine: 'bubble', done: rows.filter((row, index) => index % 4 === 0 && index < 240).map(([id]) => id), selected: 'a0.1', hovered: 'a1', steps: stepsOf(rows) };
}

// A line long enough to spend the tuck's whole budget of work, and a small island that comes after it.
function ceiling() {
  const rows = [];
  for (let mile = 0; mile < 320; mile++) {
    rows.push([`c${mile}`, `Mile ${mile + 1}`, HUES[Math.floor(mile / 40) % HUES.length], mile === 0 ? [] : [`c${mile - 1}`]]);
    if (mile % 8 === 5) rows.push([`c${mile}.s`, phrase(3, mile), HUES[Math.floor(mile / 40) % HUES.length], [`c${mile}`]]);
  }
  rows.push(...seededTree('isle', 6, 13, { reach: 2, second: 0 }));
  return { name: 'ceiling', engine: 'bubble', done: rows.slice(0, 100).map(([id]) => id), selected: 'c200', hovered: 'isle2', steps: stepsOf(rows) };
}

function fallback() {
  const rows = seededTree('f', 34, 21, { reach: 6, second: 0.2 });
  return { name: 'fallback', engine: 'radial', done: rows.slice(0, 9).map(([id]) => id), selected: 'f12', hovered: 'f13', steps: stepsOf(rows) };
}

function fallbackRoots() {
  const rows = [...seededTree('p', 12, 31, { reach: 3, second: 0 }), ...seededTree('q', 9, 33, { reach: 5, second: 0 }), ...seededTree('r', 4, 35, { reach: 1, second: 0 })];
  return { name: 'fallback-roots', engine: 'radial', done: ['p0', 'q0'], selected: 'q4', hovered: 'r1', steps: stepsOf(rows) };
}

// The design's Coastal navigation handbook: 5,000 steps under one, in parts that run deep, spread wide and cross.
function handbook() {
  const random = seededRandom(5000);
  const rows = [['n0', 'Coastal navigation handbook', 'gold', []]];
  for (let index = 1; index < 5000; index++) {
    const draw = random();
    let parent = index - 1;
    if (index <= 12) parent = 0;
    else if (draw < 0.55) parent = Math.max(1, index - 1 - Math.floor(random() * 60));
    else if (draw < 0.9) parent = 1 + Math.floor(random() * (index - 1));
    const follows = [`n${parent}`];
    const other = 1 + Math.floor(random() * (index - 1));
    if (index > 12 && random() < 0.08 && other !== parent) follows.push(`n${other}`);
    const color = index <= 12 ? HUES[index % HUES.length] : rows[parent][2];
    rows.push([`n${index}`, index % 9 === 0 ? `${phrase(8, index)} ${index}` : `${phrase(1 + (index % 3), index)} ${index}`, color, follows]);
  }
  return { name: 'handbook', engine: 'bubble', done: rows.slice(0, 1800).map(([id]) => id), selected: 'n2400', hovered: 'n2401', steps: stepsOf(rows) };
}

// The canvases every roadmap is framed in: an iPhone's, with the room's bars over it, and a desktop browser's, with the
// minimap holding its corner.
const CANVASES = [
  { name: 'phone', viewport: { width: 402, height: 874 }, insets: { top: 158, right: 0, bottom: 140, left: 0 }, blocks: [], workingZoom: PHONE_WORKING_ZOOM },
  {
    name: 'desktop', viewport: { width: 1440, height: 900 }, insets: { top: 76, right: 24, bottom: 24, left: 24 },
    blocks: [{ left: 24, bottom: 24, width: 186, height: 146 }], workingZoom: WORKING_ZOOM,
  },
];
// A zoom that draws a body 15 px across: the frontier is named and the rest is not.
const FRONTIER_ZOOM = 0.32;
// The least zoom, to a hundredth, at which every step is named: the most names a view can ask for.
const CROWDED_ZOOM = 0.39;
// A fixture's ruler: every code point is as wide as the layout's own estimate of one.
const measure = (text) => CAPTION.charPx * Array.from(text).length;

// A roadmap as the room hands it to the layout (`ReplicaRoadmap.seedOf`), and the picture drawn of it.
function pictureOf(roadmap) {
  const tree = new SkillTree({
    id: roadmap.name, title: roadmap.name,
    nodes: roadmap.steps.map((step) => ({ id: step.id, label: step.label, color: step.color, order: step.ord, createdAt: Stamp.parse(step.born), prerequisites: step.follows })),
  });
  const layout = layoutTree(roadmap.engine === 'radial' ? fallbackLayoutEngine() : new BubbleLayoutEngine(), tree);
  if (layout.name !== roadmap.engine) throw new Error(`${roadmap.name} was laid out by ${layout.name}, not ${roadmap.engine}`);
  const model = tree.toRenderModel(layout.positions, domainReading(tree, { completed: new Set(roadmap.done) }).states);
  const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
  const metrics = new Map(model.nodes.flatMap((node) => {
    const metric = wrapCaption(node.label, measure);
    return metric ? [[node.id, metric]] : [];
  }));
  const every = Math.ceil(model.nodes.length / 32);
  const focused = model.nodes.filter((node, index) => index % every === 0 || node.id === roadmap.selected);
  return {
    name: roadmap.name,
    roadmap: { steps: roadmap.steps, done: roadmap.done },
    engine: layout.name,
    seats: model.nodes.map((node) => [node.x, node.y]),
    tiers: model.nodes.map((node) => nodeTier(node.state)),
    links: model.edges.map((edge) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      const sway = bendOf(edge.from, edge.to);
      return { from: edge.from, to: edge.to, kind: edge.kind, sway, ...controlPoint(from.x, from.y, to.x, to.y, sway) };
    }),
    bounds: model.bounds,
    canvases: CANVASES.map(({ name, viewport, insets, blocks, workingZoom }) => {
      const canvas = { viewportWidth: viewport.width, viewportHeight: viewport.height, insets, workingZoom, fitBounds: model.bounds };
      const fit = fitFrame(canvas, model.bounds);
      const script = [{ now: 0, camera: fit }, { now: 200, camera: fit }];
      if (roadmap.selected !== null) {
        const seat = nodesById.get(roadmap.selected);
        const working = focusFrame(canvas, model.edges, nodesById, seat);
        const overview = { x: seat.x, y: seat.y, zoom: FRONTIER_ZOOM };
        script.push(
          { now: 300, camera: working, selected: roadmap.selected, hovered: roadmap.hovered },
          { now: 500, camera: working, selected: roadmap.selected, hovered: roadmap.hovered },
          { now: 600, camera: overview },
          { now: 800, camera: overview },
          { now: 900, camera: { ...overview, zoom: CROWDED_ZOOM } },
          { now: 1100, camera: { ...overview, zoom: CROWDED_ZOOM } },
        );
      }
      const placer = new CaptionPlacer();
      placer.setModel(model, new SpatialGrid(model.nodes, NODE_SIZE * 2));
      placer.setMetrics(metrics);
      placer.setInsets({ ...insets, blocks });
      return {
        name, viewport, insets, blocks, workingZoom, fit, floor: minZoom(canvas),
        focus: focused.map((node) => ({ step: node.id, ...focusFrame(canvas, model.edges, nodesById, node) })),
        passes: script.map(({ now, camera, selected = null, hovered = null }) => {
          placer.setContext({ selectedId: selected, hoveredId: hovered });
          const placed = placer.place({ ...camera, viewportWidth: viewport.width, viewportHeight: viewport.height }, now);
          return { now, camera, selected, hovered, rankLimit: captionRankLimit(camera.zoom), captions: placed.captions, nextDeadline: placed.nextDeadline };
        }),
      };
    }),
  };
}

// The arithmetic's own vectors: each function at the edges of its branches, a double to either side of each, and across
// seeded samples of what the layout asks of it.
function arithmeticVectors() {
  const random = seededRandom(754);
  const bits = new BigUint64Array(1);
  const float = new Float64Array(bits.buffer);
  const beside = (number) => [-1n, 0n, 1n].map((step) => {
    float[0] = number;
    bits[0] += step;
    return float[0];
  });
  const signed = (magnitude) => (random() < 0.5 ? -magnitude : magnitude);
  const spread = (low, high) => signed(low * (high / low) ** random());
  const sampled = (count, draw) => Array.from({ length: count }, draw);
  const halfTurns = Array.from({ length: 40 }, (_, turn) => (turn + 1) * (PI / 2));
  const angles = [
    0, ...[7.450580596923828e-9, 0.2999999523162842, 0.7812504768371582, PI / 4, 0.7853984832763672, 2.3561935424804688, ...halfTurns].flatMap(beside),
    47123.889803846896, -47123.889803846896, 823549.6642857155, REDUCIBLE_BELOW - 1, 1647099.9999999998, -1647099.9999999998,
    ...sampled(120, () => signed(random() * 7)), ...sampled(120, () => signed(random() * 48000)), ...sampled(60, () => spread(1e-9, REDUCIBLE_BELOW - 1)),
  ];
  const ratios = [
    0, 1, -1, ...[7.450580596923828e-9, 0.5, 0.9749999046325684].flatMap(beside), 0.9999999999999999, -0.9999999999999999,
    ...sampled(120, () => signed(random())), ...sampled(60, () => signed(1 - 10 ** (-17 * random()))), ...sampled(60, () => spread(1e-9, 1)),
  ];
  const slopes = [
    0, ...[1.862645149230957e-9, 0.4375, 0.6875, 1, 1.1875, 2.4375, 73786976294838206464].flatMap(beside),
    ...sampled(120, () => signed(random() * 4)), ...sampled(120, () => spread(1e-9, 1e12)),
  ];
  const points = [
    [0, 0], [0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, -1], [-1, 1], [3, 4], [-5, 12], [2, 1], [1e-300, 1e-300], [1e300, 1e300],
    [1e30, 1e-40], [1e-40, -1e30], [-1e30, -1e-40], [4611686018427387904, 2], [4611686018427387392, 2], [4611686018427387904, -2], [4611686018427387392, -2],
    [1, -1152921504606846976], [0.9999999999999999, -1152921504606846976], [-0.9999999999999999, -1152921504606846976],
    ...sampled(160, () => [signed(random() * 4000), signed(random() * 4000)]), ...sampled(120, () => [spread(1e-6, 1e7), spread(1e-6, 1e7)]),
  ];
  return {
    sin: angles.map((x) => [x, sin(x)]),
    cos: angles.map((x) => [x, cos(x)]),
    asin: ratios.map((x) => [x, asin(x)]),
    atan: slopes.map((x) => [x, atan(x)]),
    atan2: points.map(([y, x]) => [y, x, atan2(y, x)]),
    hypot: points.map(([x, y]) => [x, y, hypot(x, y)]),
  };
}

// JSON a person can read and a diff can follow: a row to a line, a list of plain values on one line whatever its length,
// every number in its shortest form that reads back the same, and every character outside ASCII as its \u escape.
function written(value, indent = '') {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`A fixture cannot hold ${value}`);
  const compact = JSON.stringify(value);
  const plain = Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object');
  if (value === null || typeof value !== 'object' || plain || compact.length + indent.length <= 200) return compact;
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((item) => inner + written(item, inner)).join(',\n')}\n${indent}]`;
  return `{\n${Object.entries(value).map(([key, item]) => `${inner}${JSON.stringify(key)}: ${written(item, inner)}`).join(',\n')}\n${indent}}`;
}

// Every file of the directory, by name.
export function layoutFixtures() {
  const roadmaps = [
    learnToSail(), wide(), deep(), scripts(), ids(), braided(), islands(), archipelago(), ceiling(), fallback(), fallbackRoots(), handbook(),
    { name: 'empty', engine: 'bubble', done: [], selected: null, hovered: null, steps: [] },
  ];
  const texts = [...roadmaps.map(pictureOf), { name: 'arithmetic', ...arithmeticVectors() }].map((fixture) => {
    const text = written(fixture).replace(/[\u0080-\uffff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return [`${fixture.name}.json`, `${text}\n`];
  });
  return new Map(texts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = new URL('../../packages/api-contract/roadmap/layout/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of layoutFixtures()) writeFileSync(new URL(name, directory), text);
}
