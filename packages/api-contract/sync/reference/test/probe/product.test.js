import assert from 'node:assert/strict';
import test from 'node:test';
import { Refusal } from '../../server/admit.js';
import { ProbeProduct, TICK_AFTER_MS } from '../../probe/product.js';

function context(rows, receipts = {}, { serverNow = 5000, trees = {} } = {}) {
  const productState = { receipts: { 'acct:A/probe': receipts } };
  return {
    scopeKey: 'acct:A/probe',
    serverNow,
    account: 'A',
    productState,
    idState: (t, id) => {
      const found = rows.find((row) => row.t === t && row.id === id);
      if (!found) return { state: 'none' };
      return { state: found.life[0] === 'alive' ? 'alive' : 'dead', born: found.born };
    },
    stored: (t, id) => rows.find((row) => row.t === t && row.id === id),
    rowsOf: (t) => rows.filter((row) => row.t === t),
    readableTree: (tree) => Object.hasOwn(trees, tree),
    treeRows: (tree) => trees[tree] ?? [],
  };
}

const run = (id, extra = {}) => ({ t: 'run', id, life: ['alive', '1:0:srv'], born: '1:0:srv', f: { startedAt: [1, '1:0:srv'] }, ...extra });
const lap = (id, runId, life = ['alive', '2:0:r_a']) => ({ t: 'lap', id, life, born: '2:0:r_a', f: { runId: [runId, '2:0:r_a'] } });

test('probe.start creates, replays by receipt and joins the open run', () => {
  const probe = new ProbeProduct();
  const empty = context([]);
  assert.deepEqual(probe.runCommand(empty, { name: 'probe.start', args: { id: 'run00001', startedAt: 10, join: true, label: 'Go' } }), {
    deltas: [{ t: 'run', id: 'run00001', life: ['alive', null], born: null, f: { startedAt: [10, null], label: ['Go', null] } }],
    write: [{ t: 'run', id: 'run00001', born: null, f: { startedAt: null, label: null } }],
  });
  assert.deepEqual(empty.productState.receipts['acct:A/probe'], { run00001: 'run00001' });
  const open = context([run('run00001')], { run00001: 'run00001' });
  assert.equal(probe.isReplay(open, { name: 'probe.start', args: { id: 'run00001' } }), true);
  assert.equal(probe.isReplay(open, { name: 'probe.start', args: { id: 'run00002' } }), false);
  assert.deepEqual(probe.runCommand(open, { name: 'probe.start', args: { id: 'run00002', startedAt: 10, join: true } }), {
    deltas: [],
    write: [{ t: 'run', id: 'run00001', from: 'run00002', born: '1:0:srv' }],
  });
  assert.deepEqual(open.productState.receipts['acct:A/probe'], { run00001: 'run00001', run00002: 'run00001' });
  assert.throws(() => probe.runCommand(context([run('run00001')]), { name: 'probe.start', args: { id: 'run00002', startedAt: 10, join: false } }), (error) => error instanceof Refusal && error.code === 'invalid');
});

test('probe.end writes endedAt on an open run; probe.tick ends open runs started TICK_AFTER_MS ago', () => {
  const probe = new ProbeProduct();
  const rows = [run('run00001'), run('run00002', { f: { startedAt: [1, '1:0:srv'], endedAt: [3, '3:0:srv'] } })];
  assert.deepEqual(probe.runCommand(context(rows), { name: 'probe.end', args: { runId: 'run00001', endedAt: 9 } }), {
    deltas: [{ t: 'run', id: 'run00001', born: '1:0:srv', f: { endedAt: [9, null] } }],
    write: [{ t: 'run', id: 'run00001', f: { endedAt: null } }],
  });
  assert.deepEqual(probe.runCommand(context(rows), { name: 'probe.end', args: { runId: 'run00002', endedAt: 9 } }), { deltas: [], write: [] });
  const now = 1 + TICK_AFTER_MS;
  const fresh = run('run00003', { f: { startedAt: [2, '2:0:srv'] } });
  assert.deepEqual(probe.runCommand(context([...rows, fresh], {}, { serverNow: now }), { name: 'probe.tick', args: {} }), {
    deltas: [{ t: 'run', id: 'run00001', born: '1:0:srv', f: { endedAt: [now, null] } }],
    write: [],
  });
  for (const [runId, code] of [['run00009', 'unknown-record'], ['run00001', 'invalid']]) {
    assert.throws(() => probe.runCommand(context(rows), { name: 'probe.end', args: { runId, endedAt: 0 } }), (error) => error.code === code);
  }
});

// A joined record as step 10 hands it to `check`: `createdBy` lists the source of each change that
// creates it.
const joined = (createdBy, original, after) => ({ type: { type: after.t }, createdBy, original, after });

test('check refuses a run created outside probe.start and kills every alive lap of a run the intent kills', () => {
  const probe = new ProbeProduct();
  const rows = [run('run00001'), lap('lap00001', 'run00001'), lap('lap00002', 'run00001'), lap('lap00003', 'run00001', ['dead', '3:0:r_a']), lap('lap00004', 'run00002')];
  const killed = { ...run('run00001'), life: ['dead', '4:0:r_a'] };
  const deleting = [
    joined([], run('run00001'), killed),
    joined([], lap('lap00002', 'run00001'), lap('lap00002', 'run00001', ['dead', '4:0:r_a'])),
  ];
  assert.deepEqual(probe.check(context(rows), deleting), [
    { t: 'lap', id: 'lap00001', born: '2:0:r_a', life: ['dead', null] },
    { t: 'lap', id: 'lap00002', born: '2:0:r_a', life: ['dead', null] },
  ]);
  assert.deepEqual(probe.check(context(rows), [joined([], run('run00001'), run('run00001'))]), []);
  assert.throws(() => probe.check(context([]), [joined(['client'], undefined, run('run00001'))]), (error) => error.code === 'invalid');
  assert.throws(() => probe.check(context([]), [joined(['client', 'command'], undefined, run('run00001'))]), (error) => error.code === 'invalid');
  assert.deepEqual(probe.check(context([]), [joined(['command'], undefined, run('run00001'))]), []);
});

test('probe.copy replays by its receipt, refuses an unreadable source or a taken id, and copies title, tags and links, a revived tag born at its life stamp', () => {
  const probe = new ProbeProduct();
  const board = (id, life = ['alive', '5:0:r_a']) => ({ t: 'board', id, life, born: '5:0:r_a' });
  const source = [
    { t: 'meta', id: 'meta', f: { title: ['Plan', '6:0:r_a'], visibility: ['public', '7:0:srv'] } },
    { t: 'tag', id: 'oak', life: ['alive', '9:0:r_a'], born: '8:0:r_a', f: { label: ['Oak', '8:0:r_a'] } },
    { t: 'tag', id: 'elm', life: ['dead', '9:0:r_a'], born: '8:0:r_a' },
    { t: 'link', id: ['oak', 'oak'], life: ['alive', '9:0:r_a'] },
  ];
  const ctx = context([board('b_00000001'), board('b_00000002')], {}, { trees: { b_00000001: source } });
  const copy = (src, dst) => ({ name: 'probe.copy', args: { src, dst } });
  assert.deepEqual(probe.runCommand(ctx, copy('b_00000001', 'b_00000003')), {
    deltas: [{ t: 'board', id: 'b_00000003', life: ['alive', null], born: null }],
    into: [{
      scopeKey: 'tree:b_00000003',
      deltas: [
        { t: 'meta', id: 'meta', f: { title: ['Plan', '6:0:r_a'] } },
        { t: 'tag', id: 'oak', life: ['alive', '9:0:r_a'], born: '9:0:r_a', f: { label: ['Oak', '8:0:r_a'] } },
        { t: 'link', id: ['oak', 'oak'], life: ['alive', '9:0:r_a'] },
      ],
    }],
    write: [{ t: 'board', id: 'b_00000003', born: null }],
  });
  assert.deepEqual(ctx.productState.copies, { 'acct:A/probe': { b_00000003: 'b_00000001' } });
  assert.equal(probe.isReplay(ctx, copy('b_00000001', 'b_00000003')), true);
  assert.throws(() => probe.runCommand(ctx, copy('b_00000001', 'b_00000002')), (error) => error.code === 'id-taken');
  assert.throws(() => probe.runCommand(ctx, copy('b_0000000f', 'b_00000004')), (error) => error.code === 'not-found');
  assert.throws(() => probe.runCommand(context([board('b_00000001')], {}, { trees: { b_00000001: source } }), copy('b_00000001', 'b_00000001')), (error) => error.code === 'id-taken');
});
