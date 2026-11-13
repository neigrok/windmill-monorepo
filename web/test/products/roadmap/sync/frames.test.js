import test from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock, compareHlc, parseHlc } from '../../../../src/products/roadmap/sync/lattice.js';
import { UNSENDABLE_FROM_BYTES, frameRoom, framesOf, stampedPerFrame, stampsOf } from '../../../../src/products/roadmap/sync/frames.js';

const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const isStampField = (key) => /At$/.test(key) || key === 'at';
const stampsIn = (value) => {
  const found = [];
  JSON.stringify(value, (key, field) => { if (isStampField(key)) found.push(field); return field; });
  return found;
};
const stampsOfFrame = (frame) => [...new Set(stampsIn({ nodes: frame.nodes, edges: frame.edges, kinds: frame.kinds }))];
const at = (ms, counter = 0) => `${ms}:${counter}:r_cut`;
const clockAt = (ms) => Object.assign(new HlcClock('r_cut'), { lastMs: ms, counter: 0 });

test('frames hold whole stamps in stamp order, as many as fit, and a write is cut alike whichever send carries it', () => {
  const room = frameRoom('tree', 'r_cut', 2000);
  const big = stampedPerFrame({ nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n-${i}`, label: '日本語のラベル'.repeat(8), labelAt: at(50) })),
    edges: [], kinds: [] }, clockAt(50), room);
  const writes = { nodes: [{ id: 'early', label: 'E', labelAt: at(10), color: 'sky', colorAt: at(90) }, ...big.nodes,
    { id: 'late', label: 'L', labelAt: at(80) }], edges: [{ from: 'early', to: 'late', addedAt: at(10) }], kinds: [],
    title: { v: 'Named', at: at(70) } };

  const frames = [...framesOf(writes, room)];

  const envelope = { t: 'subgraph', v: 1, treeId: 'tree', frameId: 'x'.repeat(36), actor: 'r_cut', intent: 'flush' };
  for (const frame of frames) assert.ok(bytesOf({ ...envelope, ...frame }) <= 2000, `a frame of ${bytesOf({ ...envelope, ...frame })} bytes`);
  const order = frames.map((frame) => stampsOfFrame(frame).concat(frame.title ? [frame.title.at] : []).map((stamp) => parseHlc(stamp)));
  assert.deepEqual(order.flat(), [...order.flat()].sort(compareHlc), 'earliest first');
  assert.equal(new Set(order.flat().map((stamp) => `${stamp.ms}:${stamp.counter}`)).size, order.flat().length, 'no stamp in two frames');
  assert.ok(stampsOfFrame(frames[0]).length > 1, 'small stamps share a frame');
  const titled = frames.filter((frame) => frame.title);
  assert.deepEqual(titled.map((frame) => [frame.nodes.length, frame.edges.length, frame.kinds.length]), [[0, 0, 0]], 'a tree register rides alone');
  const early = frames.flatMap((frame) => frame.nodes).filter((node) => node.id === 'early');
  assert.deepEqual(early.map((node) => Object.keys(node).sort()), [['id', 'label', 'labelAt'], ['color', 'colorAt', 'id']]);
  assert.equal(frames.flatMap((frame) => frame.nodes).filter((node) => node.id.startsWith('n-')).length, 30);
});

test('a write that fits one frame keeps its stamp, and a larger one is cut into parts of consecutive stamps: the kind first, steps before the edges that join them', () => {
  const room = frameRoom('tree', 'r_cut', 1200);
  const small = { nodes: [{ id: 'a', label: 'A', labelAt: at(50) }], edges: [], kinds: [] };
  assert.equal(stampedPerFrame(small, clockAt(50), room), small);

  const act = {
    nodes: Array.from({ length: 20 }, (_, i) => ({ id: `step-${i}`, createdAt: at(50), color: 'plum', colorAt: at(50), label: `Step ${i}`, labelAt: at(50) })),
    edges: Array.from({ length: 19 }, (_, i) => ({ from: `step-${i}`, to: `step-${i + 1}`, addedAt: at(50) })),
    kinds: [{ id: 'k', hue: 'plum', hueAt: at(50) }],
  };
  const clock = clockAt(50);
  const cut = stampedPerFrame(act, clock, room);

  const stamps = stampsOf(cut);
  assert.ok(stamps.length > 2);
  assert.deepEqual(stamps, stamps.map((stamp, index) => at(50, index)), 'the act’s stamp, then the clock’s next ticks of the same millisecond');
  assert.deepEqual(parseHlc(stamps.at(-1)), { ms: clock.lastMs, counter: clock.counter, actor: 'r_cut' }, 'the clock has moved past every part');
  assert.equal(cut.kinds[0].hueAt, stamps[0]);
  const ordered = [...cut.kinds.map((kind) => kind.hueAt), ...cut.nodes.map((node) => node.colorAt), ...cut.edges.map((edge) => edge.addedAt)].map((stamp) => parseHlc(stamp));
  assert.deepEqual(ordered, [...ordered].sort(compareHlc), 'kinds, then steps, then edges, each part after the one before');
  for (const node of cut.nodes) assert.deepEqual([node.createdAt, node.labelAt], [node.colorAt, node.colorAt], 'a row is stamped whole');
  const frames = [...framesOf(cut, room)];
  assert.deepEqual(frames.map((frame) => stampsOfFrame(frame)), stamps.map((stamp) => [stamp]), 'each part is one frame');
  const envelope = { t: 'subgraph', v: 1, treeId: 'tree', frameId: 'x'.repeat(36), actor: 'r_cut', intent: 'flush' };
  for (const frame of frames) assert.ok(bytesOf({ ...envelope, ...frame }) <= 1200);
});

test('a stamp heavy enough to be judged unsendable goes in a frame of its own, with no small write beside it', () => {
  const heavy = { id: 'heavy', description: 'd'.repeat(UNSENDABLE_FROM_BYTES), descriptionAt: at(20) };
  const frames = [...framesOf({ nodes: [{ id: 'before', label: 'B', labelAt: at(10) }, heavy, { id: 'after', label: 'A', labelAt: at(30) }],
    edges: [], kinds: [] }, frameRoom('tree', 'r_cut'))];
  assert.deepEqual(frames.map((frame) => frame.nodes.map((node) => node.id)), [['before'], ['heavy'], ['after']]);
});

test('many small stamps are packed up to the limit and never past it: the commas that join their entries are counted', () => {
  const room = frameRoom('tree', 'r_cut', 2000);
  const envelope = { t: 'subgraph', v: 1, treeId: 'tree', frameId: 'x'.repeat(36), actor: 'r_cut', intent: 'flush' };
  const writes = { nodes: Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, order: 'a', orderAt: at(100 + i) })),
    edges: Array.from({ length: 200 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, addedAt: at(1000 + i) })), kinds: [] };

  const frames = [...framesOf(writes, room)];

  const sizes = frames.map((frame) => bytesOf({ ...envelope, ...frame }));
  for (const size of sizes) assert.ok(size <= 2000, `a frame of ${size} bytes`);
  assert.ok(Math.max(...sizes) > 2000 - 60, 'packed to within one entry of the limit');
  assert.equal(frames.reduce((sum, frame) => sum + frame.nodes.length, 0), 400);
  assert.equal(frames.reduce((sum, frame) => sum + frame.edges.length, 0), 200);
});

test('one stamp too large for a frame, as a record of an earlier bundle holds, is cut across frames under that stamp', () => {
  const room = frameRoom('tree', 'r_cut', 2000);
  const envelope = { t: 'subgraph', v: 1, treeId: 'tree', frameId: 'x'.repeat(36), actor: 'r_cut', intent: 'flush' };
  const writes = { nodes: [{ id: 'early', label: 'E', labelAt: at(10) },
    ...Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, createdAt: at(50), label: `Pasted step ${i}`, labelAt: at(50) })),
    { id: 'late', label: 'L', labelAt: at(80) }], edges: [{ from: 'p0', to: 'p1', addedAt: at(50) }], kinds: [] };

  const frames = [...framesOf(writes, room)];

  for (const frame of frames) assert.ok(bytesOf({ ...envelope, ...frame }) <= 2000);
  const stamps = frames.map((frame) => stampsOfFrame(frame));
  assert.ok(stamps.filter((ofFrame) => ofFrame.includes(at(50))).length > 1, 'the one stamp rides several frames');
  for (const ofFrame of stamps) if (ofFrame.includes(at(50))) assert.deepEqual(ofFrame, [at(50)], 'and shares none of them');
  assert.deepEqual(stamps.flat().map((stamp) => parseHlc(stamp).ms), [...stamps.flat().map((stamp) => parseHlc(stamp).ms)].sort((a, b) => a - b));
  assert.equal(frames.flatMap((frame) => frame.nodes).filter((node) => node.id.startsWith('p')).length, 60);
  assert.equal(frames.reduce((sum, frame) => sum + frame.edges.length, 0), 1);
});
