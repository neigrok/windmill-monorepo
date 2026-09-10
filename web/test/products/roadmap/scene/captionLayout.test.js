import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR_ABOVE, ANCHOR_BELOW, ANCHOR_LEFT, ANCHOR_RIGHT, CAPTION_POOL, CaptionPlacer, HIDE_AFTER_MS, SHOW_AFTER_MS,
  RANK_ANCHOR, RANK_FRONTIER, RANK_REST, captionRankLimit, wrapCaption,
} from '../../../../src/products/roadmap/scene/captionLayout.js';
import { SpatialGrid } from '../../../../src/products/roadmap/model/SpatialGrid.js';
import { NODE_SIZE, BODY_FRACTION, ROOT_BODY_SCALE, WORKING_ZOOM, SELECTED_SCALE } from '../../../../src/products/roadmap/theme.js';

// Eight px per code point: twenty characters fill the 160 px column exactly.
const measure = (text) => Array.from(text).length * 8;
const RIM = NODE_SIZE * BODY_FRACTION / 2;

// A placer over a model whose nodes are `{ id, label, x, y, state?, emphasis?, branch? }` and whose
// edges are `{ from, to, kind }`; every caption is wrapped with the eight-px measure.
function placerOver(nodes, edges = []) {
  const placer = new CaptionPlacer();
  installModel(placer, nodes, edges);
  return placer;
}

function installModel(placer, nodes, edges = []) {
  const renderNodes = nodes.map((node) => ({ state: 'complete', emphasis: 0, branch: null, ...node }));
  placer.setModel({ nodes: renderNodes, edges }, new SpatialGrid(renderNodes, NODE_SIZE * 2));
  const metricById = new Map();
  for (const node of renderNodes) {
    const metric = wrapCaption(node.label, measure);
    if (metric) metricById.set(node.id, metric);
  }
  placer.setMetrics(metricById);
}

// A view centred on the origin; at zoom 1 a world unit is a screen px and (0, 0) sits mid-canvas.
function view({ zoom = 1, width = 1440, height = 848, x = 0, y = 0 } = {}) {
  return { x, y, zoom, viewportWidth: width, viewportHeight: height };
}

const ids = (captions) => captions.map((caption) => caption.id);

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function discRect(node, v, { selected = false } = {}) {
  const sx = (node.x - v.x) * v.zoom + v.viewportWidth / 2;
  const sy = (node.y - v.y) * v.zoom + v.viewportHeight / 2;
  const rim = RIM * v.zoom * (node.emphasis > 0 ? ROOT_BODY_SCALE : 1) * (selected ? SELECTED_SCALE : 1);
  return { left: sx - rim, top: sy - rim, right: sx + rim, bottom: sy + rim };
}

const box = (caption) => ({ left: caption.left, top: caption.top, right: caption.left + caption.width, bottom: caption.top + caption.height });

test('wrapCaption — one line when it fits, two at a word boundary, the second line ellipsised', () => {
  assert.deepEqual(wrapCaption('Build a daily habit', measure), { lines: ['Build a daily habit'], width: 152, height: 20 });
  assert.deepEqual(wrapCaption('Build a daily habit and reflect', measure), { lines: ['Build a daily habit', 'and reflect'], width: 152, height: 40 });
  assert.deepEqual(wrapCaption('Build a daily habit and reflect on the whole week', measure), {
    lines: ['Build a daily habit', 'and reflect on the…'], width: 152, height: 40,
  });
  assert.deepEqual(wrapCaption('  spaced \n  out   words ', measure), { lines: ['spaced out words'], width: 128, height: 20 });
});

test('wrapCaption — a blank label has no caption; a word wider than the column is cut between code points', () => {
  assert.equal(wrapCaption('', measure), null);
  assert.equal(wrapCaption('   ', measure), null);
  assert.equal(wrapCaption(undefined, measure), null);
  assert.deepEqual(wrapCaption('🚀'.repeat(45), measure), { lines: ['🚀'.repeat(20), `${'🚀'.repeat(19)}…`], width: 160, height: 40 });
  assert.deepEqual(wrapCaption(`${'x'.repeat(25)} tail`, measure), { lines: ['x'.repeat(20), 'xxxxx tail'], width: 160, height: 40 });
});

test('captionRankLimit — keyed on the body as drawn: 18 px names everyone, 12 px the frontier, the floor the landmarks', () => {
  const zoomFor = (bodyPx) => bodyPx / (NODE_SIZE * BODY_FRACTION);
  assert.equal(captionRankLimit(zoomFor(18)), RANK_REST);
  assert.equal(captionRankLimit(zoomFor(17.99)), RANK_FRONTIER);
  assert.equal(captionRankLimit(zoomFor(12)), RANK_FRONTIER);
  assert.equal(captionRankLimit(zoomFor(11.99)), RANK_ANCHOR);
  assert.equal(captionRankLimit(WORKING_ZOOM), RANK_REST);
  assert.equal(captionRankLimit(0.85), RANK_REST);
  // The shader never draws a body under 6 px, so no zoom, however far out, closes the landmarks.
  assert.equal(captionRankLimit(zoomFor(0.001)), RANK_ANCHOR);
  assert.equal(captionRankLimit(0), RANK_ANCHOR);
  // Monotone: once a rank opens it never closes on the way in.
  let last = -1;
  for (let zoom = 0.001; zoom <= 3; zoom += 0.001) {
    const limit = captionRankLimit(zoom);
    assert.ok(limit >= last, `limit fell at zoom ${zoom}`);
    last = limit;
  }
});

test('overview captions retain the eight pixel gap from the visible disc floor', () => {
  const placer = placerOver([{ id: 'root', label: 'Root', x: 0, y: 0, emphasis: 1 }]);
  assert.deepEqual(placer.place(view({ zoom: 0.01 }), 0).captions, [{
    id: 'root', anchor: ANCHOR_BELOW, left: 700, top: 436.5, width: 40, height: 20, lines: ['Root'], shown: true,
  }]);
});

test('priority — selected, hovered, the selected\'s trunk family, anchors, the frontier, the rest; not distance', () => {
  // Laid out so the nearest node to the centre is the lowest rank and the farthest the highest.
  const nodes = [
    { id: 'rest', label: 'Rest', x: 0, y: 0 },
    { id: 'frontier', label: 'Frontier', x: 240, y: 0, state: 'available' },
    { id: 'root', label: 'Root', x: -240, y: 0, emphasis: 1, branch: 'root' },
    { id: 'child', label: 'Child', x: 480, y: 0 },
    { id: 'hovered', label: 'Hovered', x: -480, y: 0 },
    { id: 'selected', label: 'Selected', x: 0, y: 200 },
    { id: 'parent', label: 'Parent', x: 0, y: -200 },
  ];
  const edges = [
    { from: 'parent', to: 'selected', kind: 'trunk' },
    { from: 'selected', to: 'child', kind: 'trunk' },
    { from: 'root', to: 'child', kind: 'cross-branch' },
  ];
  const placer = placerOver(nodes, edges);
  placer.setContext({ selectedId: 'selected', hoveredId: 'hovered' });
  const { captions } = placer.place(view(), 0);
  assert.deepEqual(ids(captions), ['selected', 'hovered', 'parent', 'child', 'root', 'frontier', 'rest']);
  assert.deepEqual(captions.map((caption) => caption.shown), [true, true, false, false, false, false, false]);
});

test('priority — states pushed in later move a node onto the frontier; the family follows the selection', () => {
  const nodes = [
    { id: 'a', label: 'A', x: 0, y: 0 },
    { id: 'b', label: 'B', x: 240, y: 0 },
    { id: 'c', label: 'C', x: 480, y: 0 },
  ];
  const placer = placerOver(nodes, [{ from: 'a', to: 'b', kind: 'trunk' }, { from: 'b', to: 'c', kind: 'trunk' }]);
  placer.setStates(new Map([['c', 'available']]));
  assert.deepEqual(ids(placer.place(view(), 0).captions), ['c', 'a', 'b']);
  placer.setContext({ selectedId: 'b', hoveredId: null });
  assert.deepEqual(ids(placer.place(view(), 0).captions), ['b', 'a', 'c']);
  // Deselected, b drops to the rest — but a caption already on screen goes before one still waiting.
  placer.setContext({ selectedId: 'gone', hoveredId: null });
  assert.deepEqual(ids(placer.place(view(), 0).captions), ['c', 'b', 'a']);
  placer.place(view(), SHOW_AFTER_MS); // a's wait is over: shown from here
  assert.deepEqual(ids(placer.place(view(), SHOW_AFTER_MS + 16).captions), ['c', 'a', 'b']);
});

test('anchors — below, then above, right, left as discs block each seat; nowhere leaves the caption out', () => {
  // Blank-labelled neighbours are discs without captions: pure obstacles.
  const blockers = { below: { id: 'b', label: '', x: 0, y: 60 }, above: { id: 'c', label: '', x: 0, y: -60 }, right: { id: 'd', label: '', x: 60, y: 0 }, left: { id: 'e', label: '', x: -60, y: 0 } };
  const named = { id: 'a', label: 'Alpha', x: 0, y: 0 };
  const anchorWith = (...around) => placerOver([named, ...around]).place(view(), 0).captions.map((caption) => caption.anchor);
  assert.deepEqual(anchorWith(), [ANCHOR_BELOW]);
  assert.deepEqual(anchorWith(blockers.below), [ANCHOR_ABOVE]);
  assert.deepEqual(anchorWith(blockers.below, blockers.above), [ANCHOR_RIGHT]);
  assert.deepEqual(anchorWith(blockers.below, blockers.above, blockers.right), [ANCHOR_LEFT]);
  assert.deepEqual(anchorWith(blockers.below, blockers.above, blockers.right, blockers.left), []);

  const [caption] = placerOver([named]).place(view(), 0).captions;
  assert.deepEqual(caption, { id: 'a', anchor: ANCHOR_BELOW, left: 720 - 24, top: 424 + RIM + 8, width: 48, height: 20, lines: ['Alpha'], shown: false });
});

test('anchors — the selected and hovered captions are never dropped: boxed in, they sit below anyway', () => {
  const nodes = [
    { id: 'a', label: 'Alpha', x: 0, y: 0 },
    { id: 'b', label: '', x: 0, y: 60 }, { id: 'c', label: '', x: 0, y: -60 }, { id: 'd', label: '', x: 60, y: 0 }, { id: 'e', label: '', x: -60, y: 0 },
  ];
  const placer = placerOver(nodes);
  placer.setContext({ selectedId: 'a', hoveredId: null });
  assert.deepEqual(placer.place(view(), 0).captions.map(({ id, anchor, shown }) => ({ id, anchor, shown })), [{ id: 'a', anchor: ANCHOR_BELOW, shown: true }]);
  placer.setContext({ selectedId: null, hoveredId: 'a' });
  assert.deepEqual(placer.place(view(), 0).captions.map(({ id, anchor, shown }) => ({ id, anchor, shown })), [{ id: 'a', anchor: ANCHOR_BELOW, shown: true }]);
  // Neither any more: boxed in, it holds its seat through the fade window, then goes.
  placer.setContext({ selectedId: null, hoveredId: null });
  assert.deepEqual(placer.place(view(), 0).captions.map(({ id, anchor, shown }) => ({ id, anchor, shown })), [{ id: 'a', anchor: ANCHOR_BELOW, shown: true }]);
  assert.deepEqual(placer.place(view(), HIDE_AFTER_MS).captions, []);
});

test('collision — on a tight grid at the working zoom no caption crosses another caption or any disc', () => {
  const nodes = Array.from({ length: 25 }, (_, index) => ({
    id: `n${index}`, label: 'A two line caption of twenty and more', x: ((index % 5) - 2) * 175, y: (Math.floor(index / 5) - 2) * 150,
  }));
  const v = view({ zoom: WORKING_ZOOM });
  const placer = placerOver(nodes);
  placer.setContext({ selectedId: 'n24', hoveredId: null });
  const { captions } = placer.place(v, 0);
  assert.equal(captions[0].id, 'n24');
  assert.ok(captions.length >= 20, `only ${captions.length} of 25 named`);
  for (const caption of captions) {
    for (const node of nodes) {
      assert.ok(!overlaps(box(caption), discRect(node, v, { selected: node.id === 'n24' })), `caption ${caption.id} crosses disc ${node.id}`);
    }
    for (const other of captions) {
      if (other !== caption) assert.ok(!overlaps(box(caption), box(other)), `captions ${caption.id} and ${other.id} cross`);
    }
  }
});

test('insets — a caption never sits under chrome, except the selected one, which may sit anywhere', () => {
  const nodes = [
    { id: 'clear', label: 'In the clear', x: -400, y: 0 },
    { id: 'docked', label: 'Under the dock', x: 600, y: 0 },
  ];
  const placer = placerOver(nodes);
  placer.setInsets({ right: 408, top: 88 });
  assert.deepEqual(ids(placer.place(view(), 0).captions), ['clear']);
  placer.setContext({ selectedId: 'docked', hoveredId: null });
  assert.deepEqual(ids(placer.place(view(), 0).captions), ['docked', 'clear']);
});

test('hysteresis — a caption appears after 200 ms of unbroken eligibility and leaves 200 ms after losing it', () => {
  const placer = placerOver([{ id: 'a', label: 'Alpha', x: 0, y: 0 }]);
  const working = view();
  const overview = view({ zoom: 0.2 }); // body 9.4 px: a non-anchor is not eligible

  let pass = placer.place(working, 0);
  assert.deepEqual(pass.captions.map((caption) => caption.shown), [false]);
  assert.equal(pass.nextDeadline, SHOW_AFTER_MS);
  pass = placer.place(working, 100);
  assert.deepEqual(pass.captions.map((caption) => caption.shown), [false]);
  assert.equal(pass.nextDeadline, SHOW_AFTER_MS);
  pass = placer.place(working, 200);
  assert.deepEqual(pass.captions.map((caption) => caption.shown), [true]);
  assert.equal(pass.nextDeadline, null);

  // Losing eligibility at 300 holds the caption where it was until 500.
  pass = placer.place(overview, 300);
  assert.deepEqual(pass.captions.map(({ id, shown, anchor }) => ({ id, shown, anchor })), [{ id: 'a', shown: true, anchor: ANCHOR_BELOW }]);
  assert.equal(pass.nextDeadline, 300 + HIDE_AFTER_MS);
  pass = placer.place(overview, 450);
  assert.deepEqual(pass.captions.map((caption) => caption.shown), [true]);
  pass = placer.place(overview, 500);
  assert.deepEqual(pass, { captions: [], nextDeadline: null });

  // Regaining eligibility inside the hold brings it straight back — no blink, no new wait.
  placer.place(working, 600);
  placer.place(working, 800);
  placer.place(overview, 900);
  pass = placer.place(working, 1000);
  assert.deepEqual(pass.captions.map((caption) => caption.shown), [true]);
  assert.equal(pass.nextDeadline, null);
});

test('hysteresis — a break during the wait restarts the clock; below 4 px only the selected and the hovered stay named', () => {
  const placer = placerOver([{ id: 'a', label: 'Alpha', x: 0, y: 0 }, { id: 'b', label: 'Beta', x: 0, y: 3000 }]);
  placer.place(view(), 0);
  placer.place(view({ zoom: 0.2 }), 100);
  assert.equal(placer.place(view(), 150).nextDeadline, 350);
  assert.deepEqual(placer.place(view(), 300).captions.map((caption) => caption.shown), [false]);
  assert.deepEqual(placer.place(view(), 350).captions.map((caption) => caption.shown), [true]);

  // At a 2 px body the tree is a picture, and the selected and hovered dots are the only ones with a name.
  placer.setContext({ selectedId: 'a', hoveredId: 'b' });
  assert.deepEqual(placer.place(view({ zoom: 0.05 }), 400).captions.map(({ id, shown }) => ({ id, shown })), [{ id: 'a', shown: true }, { id: 'b', shown: true }]);
  assert.deepEqual(placer.place(view({ zoom: 0.05 }), 800).captions.map(({ id, shown }) => ({ id, shown })), [{ id: 'a', shown: true }, { id: 'b', shown: true }]);
  placer.setContext({ selectedId: null, hoveredId: null });
  assert.deepEqual(placer.place(view({ zoom: 0.05 }), 900).captions.map((caption) => caption.shown), [true, true]);
  assert.deepEqual(placer.place(view({ zoom: 0.05 }), 900 + HIDE_AFTER_MS), { captions: [], nextDeadline: null });
});

test('stickiness — a caption keeps its seat across a pan and a re-installed model; records outlive setModel', () => {
  const alpha = { id: 'a', label: 'Alpha', x: 0, y: 0 };
  const below = { id: 'b', label: '', x: 0, y: 60 };
  const placer = placerOver([alpha, below]);
  placer.place(view(), 0);
  const [settled] = placer.place(view(), SHOW_AFTER_MS).captions;
  assert.deepEqual({ anchor: settled.anchor, shown: settled.shown }, { anchor: ANCHOR_ABOVE, shown: true });

  const [panned] = placer.place(view({ x: -3, y: -5 }), SHOW_AFTER_MS + 16).captions;
  assert.deepEqual({ anchor: panned.anchor, left: panned.left, top: panned.top }, { anchor: ANCHOR_ABOVE, left: settled.left + 3, top: settled.top + 5 });

  // The blocker is gone after a live edit; the caption stays above rather than jumping below.
  installModel(placer, [alpha]);
  const [reinstalled] = placer.place(view(), SHOW_AFTER_MS + 32).captions;
  assert.deepEqual({ anchor: reinstalled.anchor, shown: reinstalled.shown }, { anchor: ANCHOR_ABOVE, shown: true });
});

test('ribbons — a caption takes a seat no branch crosses; boxed in by branches it is named on one anyway', () => {
  // The bow of w→e (sway 0.05) carries it through the seat below Alpha; the seat above is clear.
  const nodes = [
    { id: 'a', label: 'Alpha', x: 0, y: 0 },
    { id: 'w', label: '', x: -300, y: 40 },
    { id: 'e', label: '', x: 300, y: 40 },
    { id: 'm', label: '', x: -300, y: -40 },
    { id: 'n', label: '', x: 300, y: -40 },
  ];
  const below = [{ from: 'w', to: 'e', kind: 'cross-branch' }];
  assert.deepEqual(placerOver(nodes).place(view(), 0).captions.map((caption) => caption.anchor), [ANCHOR_BELOW]);
  const crossed = placerOver(nodes, below).place(view(), 0).captions;
  assert.deepEqual(crossed.map(({ id, anchor }) => ({ id, anchor })), [{ id: 'a', anchor: ANCHOR_ABOVE }]);

  // Branches below and above, discs to the sides: a name on a ribbon still beats a step with no name at all.
  const sides = [...nodes, { id: 'r', label: '', x: 60, y: 0 }, { id: 'l', label: '', x: -60, y: 0 }];
  const boxedIn = placerOver(sides, [...below, { from: 'm', to: 'n', kind: 'cross-branch' }]).place(view(), 0).captions;
  assert.deepEqual(boxedIn.map(({ id, anchor }) => ({ id, anchor })), [{ id: 'a', anchor: ANCHOR_BELOW }]);
});

test('blocks — the corner chrome holds is no seat, and it follows the edge it is anchored to', () => {
  const nodes = [{ id: 'a', label: 'Alpha', x: -600, y: 380 }];
  const minimap = { left: 24, bottom: 24, width: 186, height: 146 };
  assert.deepEqual(ids(placerOver(nodes).place(view(), 0).captions), ['a']);

  const blocked = placerOver(nodes);
  blocked.setInsets({ blocks: [minimap] });
  assert.deepEqual(blocked.place(view(), 0).captions, []);
  // A wider canvas leaves the same corner behind: the step is clear of it again.
  assert.deepEqual(ids(blocked.place(view({ width: 1840 }), 0).captions), ['a']);
});

test('tiers — the overview names crowned roots, branch heads of eight or more, the selected and the hovered', () => {
  const nodes = [
    { id: 'root', label: 'Root', x: 0, y: 0, emphasis: 1, branch: 'root' },
    { id: 'head', label: 'Big branch head', x: 2000, y: 0, branch: 'head' },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `leaf${index}`, label: `Leaf ${index}`, x: 2000 + index * 300, y: 800, branch: 'head', state: 'available' })),
    { id: 'twig', label: 'Small branch head', x: -2000, y: 0, branch: 'twig' },
    { id: 'twigleaf', label: 'Twig leaf', x: -2000, y: 800, branch: 'twig' },
    { id: 'picked', label: 'Picked', x: 0, y: 1500 },
  ];
  const edges = [
    { from: 'root', to: 'head', kind: 'trunk' },
    ...Array.from({ length: 7 }, (_, index) => ({ from: 'head', to: `leaf${index}`, kind: 'trunk' })),
    { from: 'root', to: 'twig', kind: 'trunk' },
    { from: 'twig', to: 'twigleaf', kind: 'trunk' },
    { from: 'root', to: 'picked', kind: 'trunk' },
  ];
  const placer = placerOver(nodes, edges);
  const overview = view({ zoom: 0.2, width: 4000, height: 4000 });
  assert.deepEqual(ids(placer.place(overview, 0).captions), ['root', 'head']);
  // The crown carries the biggest subtree, so it is named first — and at the whole-tree fit, where every disc is a dot
  // drawn at the floor, it is named at all: a crown seats above its own ring rather than losing to it.
  const fit = view({ zoom: 0.01, width: 4000, height: 4000 });
  const crowned = placer.place(fit, 0).captions;
  assert.deepEqual(crowned.map(({ id, anchor, shown }) => ({ id, anchor, shown })), [{ id: 'root', anchor: ANCHOR_ABOVE, shown: true }]);
  placer.setContext({ selectedId: 'picked', hoveredId: 'twigleaf' });
  assert.deepEqual(ids(placer.place(overview, 0).captions), ['picked', 'twigleaf', 'root', 'head']);
  // Zooming in past 18 px keeps every one of those and adds the rest: the tier is monotone.
  const working = view({ zoom: 0.4, width: 4000, height: 4000 });
  const named = ids(placer.place(working, 0).captions);
  for (const id of ['picked', 'twigleaf', 'root', 'head']) assert.ok(named.includes(id), `${id} lost on zoom-in`);
  assert.equal(named.length, nodes.length);
});

test('bounds — the pool caps captions at 96, off-canvas nodes are not named, and two placers agree', () => {
  const nodes = Array.from({ length: 150 }, (_, index) => ({ id: `n${index}`, label: `Step ${index}`, x: ((index % 15) - 7) * 150, y: (Math.floor(index / 15) - 5) * 120 }));
  const wide = view({ width: 3000, height: 3000 });
  const first = placerOver(nodes).place(wide, 0).captions;
  assert.equal(first.length, CAPTION_POOL);
  assert.deepEqual(placerOver(nodes).place(wide, 0).captions, first);

  const far = placerOver([{ id: 'near', label: 'Near', x: 0, y: 0 }, { id: 'far', label: 'Far', x: 5000, y: 0 }]);
  assert.deepEqual(ids(far.place(view(), 0).captions), ['near']);
});

test('a long bowed ribbon keeps a caption off its midpoint even when its chord is more than 200 px away', () => {
  const placer = placerOver([
    { id: 'step', label: 'Step', x: 0, y: 0 },
    { id: 'a', label: '', x: -5000, y: -400 },
    { id: 'b84', label: '', x: 5000, y: -400 },
  ], [{ from: 'a', to: 'b84', kind: 'trunk' }]);
  assert.deepEqual(placer.place(view(), 0).captions, [{
    id: 'step', anchor: ANCHOR_ABOVE, left: 700, top: 372.48, width: 40, height: 20, lines: ['Step'], shown: false,
  }]);
});

test('5000 spokes around a crown retain its caption at working zoom', () => {
  const nodes = Array.from({ length: 5000 }, (_, index) => {
    const angle = index / 4999 * Math.PI * 2;
    return { id: `n${index}`, label: `Practice meaningful skill ${index}`, x: index ? Math.cos(angle) * 100000 : 0, y: index ? Math.sin(angle) * 100000 : 0, emphasis: index === 0 ? 1 : 0 };
  });
  const edges = nodes.slice(1).map((node) => ({ from: 'n0', to: node.id, kind: 'trunk' }));
  for (const zoom of [0.4, WORKING_ZOOM]) {
    const placer = placerOver(nodes, edges);
    const camera = view({ zoom });
    for (const now of [0, SHOW_AFTER_MS]) {
      assert.deepEqual(placer.place(camera, now).captions, [{
        id: 'n0', anchor: ANCHOR_BELOW, left: 640, top: 424 + RIM * zoom * ROOT_BODY_SCALE + 8,
        width: 160, height: 40, lines: ['Practice meaningful', 'skill 0'], shown: now === SHOW_AFTER_MS,
      }]);
    }
  }
});
