import test from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock, TreeLattice } from '../../../../src/products/roadmap/sync/lattice.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { Board } from '../../../../src/products/roadmap/board/Board.js';

test('legacy authored progress aliases become none through projection, persistence, and replay', () => {
  const lattice = new TreeLattice('t_1');
  lattice.join({ nodes: [
    { id: 'done', createdAt: '100:0:legacy', status: 'complete', statusAt: '200:0:legacy' },
    { id: 'old-active', createdAt: '100:0:legacy', status: 'active', statusAt: '200:0:legacy' },
    { id: 'old-inProgress', createdAt: '100:0:legacy', status: 'inProgress', statusAt: '200:0:legacy' },
  ] });
  const frame = lattice.toFrame();
  const copy = new TreeLattice('t_1');
  copy.join(frame);

  assert.deepEqual(frame.nodes.map(({ id, status }) => ({ id, status })), [
    { id: 'done', status: 'complete' },
    { id: 'old-active', status: 'none' },
    { id: 'old-inProgress', status: 'none' },
  ]);
  assert.deepEqual(copy.toTreeData().nodes.map(({ id, status }) => ({ id, status })), [
    { id: 'done', status: 'complete' },
    { id: 'old-active', status: 'none' },
    { id: 'old-inProgress', status: 'none' },
  ]);
});

test('createdMs reads the wall time of the add stamp, and a genesis seed stays unknown', () => {
  const planted = Date.UTC(2026, 9, 20, 9);
  const lattice = new TreeLattice('t_1');
  lattice.join({ nodes: [
    { id: 'seeded', createdAt: '1:0:genesis', label: 'Seeded', labelAt: '1:0:genesis' },
    { id: 'planted', createdAt: `${planted}:3:srv`, label: 'Planted', labelAt: `${planted}:3:srv` },
  ] });

  assert.deepEqual(lattice.toTreeData().nodes.map(({ id, createdMs }) => ({ id, createdMs })), [
    { id: 'seeded', createdMs: null },
    { id: 'planted', createdMs: planted },
  ]);
});

test('two replicas that trade frames in opposite orders read the same createdMs, and so does a fresh one', () => {
  const t1 = Date.UTC(2026, 9, 20, 9);
  const t2 = Date.UTC(2026, 9, 21, 10);
  const t3 = Date.UTC(2026, 9, 22, 10);
  const t4 = Date.UTC(2026, 9, 23, 10);
  const plant = { nodes: [{ id: 'root', createdAt: `${t1}:0:r_a`, label: 'Sail', labelAt: `${t1}:0:r_a` }] };
  const graft = {
    nodes: [
      { id: 'knots', createdAt: `${t2}:0:r_a`, label: 'Knots', labelAt: `${t2}:0:r_a` },
      { id: 'wind', createdAt: `${t2}:0:r_a`, label: 'Wind', labelAt: `${t2}:0:r_a` },
    ],
    edges: [{ from: 'root', to: 'knots', addedAt: `${t2}:0:r_a` }, { from: 'root', to: 'wind', addedAt: `${t2}:0:r_a` }],
  };
  const rename = { nodes: [{ id: 'knots', label: 'Knots and hitches', labelAt: `${t3}:0:r_b` }] };
  const bowline = {
    nodes: [{ id: 'bowline', createdAt: `${t3}:1:r_b`, label: 'Bowline', labelAt: `${t3}:1:r_b` }],
    edges: [{ from: 'knots', to: 'bowline', addedAt: `${t3}:1:r_b` }],
  };
  const drop = { nodes: [{ id: 'wind', deletedAt: `${t4}:0:r_a` }] };

  const a = new TreeLattice('t_1');
  for (const frame of [plant, graft, drop, rename, bowline]) a.join(frame);
  const b = new TreeLattice('t_1');
  for (const frame of [bowline, rename, drop, graft, plant, graft]) b.join(frame);
  const fresh = new TreeLattice('t_1');
  fresh.join(a.toFrame());

  const created = (lattice) => lattice.toTreeData().nodes
    .map(({ id, createdMs }) => ({ id, createdMs }))
    .sort((x, y) => (x.id < y.id ? -1 : 1));
  const expected = [
    { id: 'bowline', createdMs: t3 },
    { id: 'knots', createdMs: t2 },
    { id: 'root', createdMs: t1 },
  ];
  assert.deepEqual(created(a), expected);
  assert.deepEqual(created(b), expected);
  assert.deepEqual(created(fresh), expected);
});

test('an import that re-sends a step the tree holds keeps its creation, so the canvas and the Board keep their order', () => {
  // The server's broadcasts for create_node root and x, then a and b under root, then import_subgraph
  // {nodes: [{id: 'a', label: 'A', prerequisites: ['root', 'x']}]}, the last one verbatim.
  const planted = [
    { nodes: [{ id: 'root', createdAt: '1000:0:srv', label: 'root', labelAt: '1000:0:srv', icon: '', iconAt: '1000:0:srv', color: 'terracotta', colorAt: '1000:0:srv' }] },
    { nodes: [{ id: 'x', createdAt: '1001:0:srv', label: 'x', labelAt: '1001:0:srv', icon: '', iconAt: '1001:0:srv', color: 'terracotta', colorAt: '1001:0:srv' }] },
    { nodes: [{ id: 'a', createdAt: '1002:0:srv', label: 'a', labelAt: '1002:0:srv', icon: '', iconAt: '1002:0:srv', color: 'terracotta', colorAt: '1002:0:srv' }],
      edges: [{ from: 'root', to: 'a', addedAt: '1002:0:srv', removedAt: '0:0:' }] },
    { nodes: [{ id: 'b', createdAt: '1003:0:srv', label: 'b', labelAt: '1003:0:srv', icon: '', iconAt: '1003:0:srv', color: 'terracotta', colorAt: '1003:0:srv' }],
      edges: [{ from: 'root', to: 'b', addedAt: '1003:0:srv', removedAt: '0:0:' }] },
  ];
  const imported = {
    nodes: [{ id: 'a', createdAt: '0:0:', deletedAt: '0:0:', label: 'A', labelAt: '1004:0:srv', icon: '', iconAt: '0:0:',
      color: 'terracotta', colorAt: '0:0:', order: '', orderAt: '0:0:', positionAt: '0:0:', statusAt: '0:0:',
      description: '', descriptionAt: '0:0:', links: [], linksAt: '0:0:' }],
    edges: [{ from: 'x', to: 'a', addedAt: '1004:0:srv', removedAt: '0:0:' }],
  };

  const read = (frames) => {
    const lattice = new TreeLattice('t');
    for (const frame of frames) lattice.join(frame);
    const tree = new SkillTree(lattice.toTreeData());
    const board = new Board(tree, { completed: new Set(), completedAt: {} }, { sort: 'newest' });
    const a = tree.nodesById.get('a');
    return {
      canvas: tree.trunk.trunkChildrenOf('root'),
      boardNewestFirst: board.locked.cards.map((card) => card.id),
      a: { label: a.label, createdMs: a.createdMs, prerequisites: a.prerequisites },
    };
  };
  assert.deepEqual(read(planted), {
    canvas: ['a', 'b'], boardNewestFirst: ['b', 'a'], a: { label: 'a', createdMs: 1002, prerequisites: ['root'] },
  });
  assert.deepEqual(read([...planted, imported]), {
    canvas: ['a', 'b'], boardNewestFirst: ['b', 'a'], a: { label: 'A', createdMs: 1002, prerequisites: ['root', 'x'] },
  });
});

test('presentEdges includes masked endpoints and self-edges while liveEdges keeps its projection and order', () => {
  const lattice = new TreeLattice('sail');
  lattice.join({ nodes: [
    { id: 'root', createdAt: '100:0:seed' },
    { id: 'wind', createdAt: '100:0:seed', deletedAt: '200:0:seed' },
    { id: 'dock', createdAt: '100:0:seed' },
  ], edges: [
    { from: 'root', to: 'wind', addedAt: '100:0:seed' },
    { from: 'wind', to: 'dock', addedAt: '100:0:seed' },
    { from: 'root', to: 'dock', addedAt: '100:0:seed' },
    { from: 'dock', to: 'dock', addedAt: '100:0:seed' },
    { from: 'absent', to: 'root', addedAt: '100:0:seed', removedAt: '200:0:seed' },
  ] });
  assert.deepEqual(lattice.presentEdges(), [
    { from: 'root', to: 'wind' }, { from: 'wind', to: 'dock' },
    { from: 'root', to: 'dock' }, { from: 'dock', to: 'dock' },
  ]);
  assert.deepEqual(lattice.liveEdges(), [{ from: 'root', to: 'dock' }]);
});

test('two replicas trading guide writes in opposite orders converge on the later stamp, and a fresh one reads it too', () => {
  const first = { guide: { v: 'One step a week, on weekend sails with Maya.', at: '1770000000000:0:r_a' } };
  const later = { guide: { v: 'Two steps a week until the June trip.', at: '1770000000000:1:r_b' } };
  const rename = { title: { v: 'Learn to sail', at: '1770000000000:2:r_a' } };
  const a = new TreeLattice('t_1', 'Sail');
  for (const frame of [first, later, rename]) a.join(frame);
  const b = new TreeLattice('t_1', 'Sail');
  for (const frame of [rename, later, first]) b.join(frame);
  const fresh = new TreeLattice('t_1');
  fresh.join(a.toFrame());

  const registers = (lattice) => ({ title: lattice.title, guide: lattice.guide, frame: { title: lattice.toFrame().title, guide: lattice.toFrame().guide } });
  const expected = { title: 'Learn to sail', guide: later.guide.v, frame: { title: rename.title, guide: later.guide } };
  assert.deepEqual(registers(a), expected);
  assert.deepEqual(registers(b), expected);
  assert.deepEqual(registers(fresh), expected);
  assert.equal(a.toTreeData().guide, later.guide.v);
});

test('a frame that names no guide, or names it null, never clears it; an empty stamped guide does', () => {
  const lattice = new TreeLattice('t_1', 'Sail', 'The document guide');
  assert.deepEqual({ guide: lattice.guide, frame: lattice.toFrame().guide }, { guide: 'The document guide', frame: undefined });
  lattice.join({ guide: { v: 'Written', at: '5:0:r_a' } });
  lattice.join({ nodes: [{ id: 'root', createdAt: '6:0:r_a' }] });
  lattice.join({ title: { v: 'Renamed', at: '7:0:r_a' }, guide: null });
  assert.equal(lattice.guide, 'Written');
  lattice.join({ guide: { v: 'Older', at: '4:0:r_b' } });
  assert.equal(lattice.guide, 'Written');
  lattice.join({ guide: { v: '', at: '8:0:r_b' } });
  assert.deepEqual({ guide: lattice.guide, frame: lattice.toFrame().guide, projected: lattice.toTreeData().guide }, { guide: '', frame: { v: '', at: '8:0:r_b' }, projected: '' });
});

test('the guide stamp joins coverage and the clock, and a baseline keeps its text unstamped', () => {
  const lattice = new TreeLattice('t_1', 'Sail');
  const frontier = lattice.join({ guide: { v: 'Written', at: '9:3:r_g' } });
  assert.deepEqual(frontier.toJSON(), { r_g: '9:3:r_g' });
  assert.deepEqual(lattice.frontier().toJSON(), { r_g: '9:3:r_g' });
  const clock = new HlcClock('r_mine');
  lattice.seedClock(clock);
  assert.deepEqual(clock.tick(1), { ms: 9, counter: 4, actor: 'r_mine' });
  const baseline = lattice.baseline();
  assert.deepEqual({ title: baseline.title, guide: baseline.guide, frame: baseline.toFrame(), frontier: baseline.frontier().toJSON() },
    { title: 'Sail', guide: 'Written', frame: { nodes: [], edges: [], kinds: [] }, frontier: {} });
});

test('a register whose text is not a string makes the whole frame malformed and leaves the lattice untouched', () => {
  const lattice = new TreeLattice('t_1', 'Sail', 'Kept');
  for (const register of [{ guide: { v: 7, at: '5:0:r_a' } }, { guide: { at: '5:0:r_a' } }, { title: { v: null, at: '5:0:r_a' } }]) {
    assert.throws(() => lattice.join({ nodes: [{ id: 'root', createdAt: '5:0:r_a' }], ...register }), { message: 'malformed tree register' });
  }
  assert.deepEqual({ title: lattice.title, guide: lattice.guide, nodes: lattice.nodes.size }, { title: 'Sail', guide: 'Kept', nodes: 0 });
});

test('a pointer the server sends is kept with its stamp, projected, and survives the stored frame', () => {
  const lattice = new TreeLattice('t_1');
  lattice.join({ nodes: [
    { id: 'sail', createdAt: '100:0:srv', label: 'Learn to sail', labelAt: '100:0:srv', opens: 't_sail', opensAt: '200:0:srv' },
    { id: 'run', createdAt: '100:0:srv', label: 'Run a 10K', labelAt: '100:0:srv' },
  ] });
  const copy = new TreeLattice('t_1');
  copy.join(JSON.parse(JSON.stringify(lattice.toFrame())));

  assert.deepEqual(lattice.toFrame().nodes.map(({ id, opens, opensAt }) => ({ id, opens, opensAt })), [
    { id: 'sail', opens: 't_sail', opensAt: '200:0:srv' },
    { id: 'run', opens: undefined, opensAt: undefined },
  ]);
  assert.deepEqual(copy.toTreeData().nodes.map(({ id, opens }) => ({ id, opens })), [
    { id: 'sail', opens: 't_sail' },
    { id: 'run', opens: undefined },
  ]);
  assert.deepEqual(copy.frontier().toJSON(), { srv: '200:0:srv' });
});

test('the later stamp of a pointer wins in either order, and an emptied pointer opens nothing', () => {
  const set = { nodes: [{ id: 'sail', createdAt: '100:0:srv', opens: 't_sail', opensAt: '200:0:srv' }] };
  const moved = { nodes: [{ id: 'sail', opens: 't_coast', opensAt: '300:0:srv' }] };
  const cleared = { nodes: [{ id: 'sail', opens: '', opensAt: '400:0:srv' }] };
  const forward = new TreeLattice('t_1');
  const backward = new TreeLattice('t_1');
  forward.join(set);
  forward.join(moved);
  backward.join(moved);
  backward.join(set);

  assert.equal(forward.toTreeData().nodes[0].opens, 't_coast');
  assert.deepEqual(backward.toFrame(), forward.toFrame());

  forward.join(cleared);
  backward.join(set);
  backward.join(cleared);
  assert.equal(forward.toTreeData().nodes[0].opens, undefined);
  assert.deepEqual(backward.toFrame(), forward.toFrame());
});

test('a frame or an entry without the pointer changes none: a reader’s empty, unstamped pair included', () => {
  const lattice = new TreeLattice('t_1');
  lattice.join({ nodes: [{ id: 'sail', createdAt: '100:0:srv', label: 'Learn to sail', labelAt: '100:0:srv', opens: 't_sail', opensAt: '200:0:srv' }] });
  const held = lattice.toFrame();

  lattice.join({ nodes: [], edges: [] });
  lattice.join({ nodes: [{ id: 'sail', label: 'Learn to sail', labelAt: '100:0:srv' }] });
  lattice.join({ nodes: [{ id: 'sail', opens: '', opensAt: '0:0:' }] });

  assert.deepEqual(lattice.toFrame(), held);
});

test('a mint after a held pointer dominates its stamp', () => {
  const lattice = new TreeLattice('t_1');
  lattice.join({ nodes: [{ id: 'sail', createdAt: '100:0:srv', opens: 't_sail', opensAt: '900:4:srv' }] });
  const clock = new HlcClock('r_tab');
  lattice.seedClock(clock);

  assert.deepEqual(clock.tick(500), { ms: 900, counter: 5, actor: 'r_tab' });
});

// A seeded PRNG (mulberry32), so the random frames below are the same run to run.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

test('with the pointer among its registers the join stays commutative, associative and idempotent over random frames', () => {
  const random = mulberry32(7);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const stamp = () => `${1 + Math.floor(random() * 6)}:${Math.floor(random() * 3)}:${pick(['srv', 'r_x', 'r_y'])}`;
  const randomFrame = () => {
    const nodes = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
      const entry = { id: pick(['a', 'b', 'c']) };
      if (random() < 0.4) entry.createdAt = stamp();
      if (random() < 0.15) entry.deletedAt = stamp();
      if (random() < 0.5) { entry.label = `L${Math.floor(random() * 5)}`; entry.labelAt = stamp(); }
      if (random() < 0.6) { entry.opens = pick(['t_1111111111111111', 't_2222222222222222', '']); entry.opensAt = stamp(); }
      if (random() < 0.15) { entry.opens = ''; entry.opensAt = '0:0:'; }
      return entry;
    });
    return { nodes, edges: random() < 0.3 ? [{ from: pick(['a', 'b', 'c']), to: pick(['a', 'b', 'c']), addedAt: stamp() }] : [], kinds: [] };
  };
  // Two values never share one stamp on the wire, so the first value said under a stamp is the one every frame says.
  const honest = (frames) => {
    const said = new Map();
    for (const node of frames.flatMap((frame) => frame.nodes)) {
      for (const name of ['label', 'opens']) {
        const at = node[`${name}At`];
        if (!at || at === '0:0:') continue;
        const key = `${node.id}|${name}|${at}`;
        if (said.has(key)) node[name] = said.get(key);
        else said.set(key, node[name]);
      }
    }
    return frames;
  };
  const joined = (frames) => {
    const lattice = new TreeLattice('t');
    for (const frame of frames) lattice.join(frame);
    const frame = lattice.toFrame();
    return { ...frame, nodes: [...frame.nodes].sort((x, y) => (x.id < y.id ? -1 : 1)), edges: [...frame.edges].sort((x, y) => (`${x.from}${x.to}` < `${y.from}${y.to}` ? -1 : 1)) };
  };

  for (let round = 0; round < 2000; round += 1) {
    const frames = honest(Array.from({ length: 2 + Math.floor(random() * 5) }, randomFrame));
    const forward = joined(frames);
    assert.deepEqual(joined([...frames].reverse()), forward);
    assert.deepEqual(joined([...frames, ...frames]), forward);
    assert.deepEqual(joined([joined(frames.slice(0, 2)), joined(frames.slice(2))]), forward);
    assert.deepEqual(joined([JSON.parse(JSON.stringify(forward))]), forward);
  }
});
