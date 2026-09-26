import assert from 'node:assert/strict';
import test from 'node:test';
import { Refusal } from '../../server/admit.js';
import { ProbeProduct } from '../../probe/product.js';

function context(rows, receipts = {}) {
  const productState = { receipts: { 'acct:A/probe': receipts } };
  return {
    scopeKey: 'acct:A/probe',
    serverNow: 5000,
    account: 'A',
    productState,
    idState: (t, id) => {
      const found = rows.find((row) => row.t === t && row.id === id);
      if (!found) return { state: 'none' };
      return { state: found.life[0] === 'alive' ? 'alive' : 'dead', born: found.born };
    },
    stored: (t, id) => rows.find((row) => row.t === t && row.id === id),
    rowsOf: (t) => rows.filter((row) => row.t === t),
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

test('probe.end and probe.sweep write endedAt on open runs only', () => {
  const probe = new ProbeProduct();
  const rows = [run('run00001'), run('run00002', { f: { startedAt: [1, '1:0:srv'], endedAt: [3, '3:0:srv'] } })];
  assert.deepEqual(probe.runCommand(context(rows), { name: 'probe.end', args: { runId: 'run00001', endedAt: 9 } }), {
    deltas: [{ t: 'run', id: 'run00001', born: '1:0:srv', f: { endedAt: [9, null] } }],
    write: [{ t: 'run', id: 'run00001', f: { endedAt: null } }],
  });
  assert.deepEqual(probe.runCommand(context(rows), { name: 'probe.end', args: { runId: 'run00002', endedAt: 9 } }), { deltas: [], write: [] });
  assert.deepEqual(probe.runCommand(context(rows), { name: 'probe.sweep', args: {} }), {
    deltas: [{ t: 'run', id: 'run00001', born: '1:0:srv', f: { endedAt: [5000, null] } }],
    write: [],
  });
  for (const [runId, code] of [['run00009', 'unknown-record'], ['run00001', 'invalid']]) {
    assert.throws(() => probe.runCommand(context(rows), { name: 'probe.end', args: { runId, endedAt: 0 } }), (error) => error.code === code);
  }
});

test('check refuses a run created outside probe.start and kills the alive laps of a deleted run', () => {
  const probe = new ProbeProduct();
  const rows = [run('run00001'), lap('lap00001', 'run00001'), lap('lap00002', 'run00001'), lap('lap00003', 'run00001', ['dead', '3:0:r_a']), lap('lap00004', 'run00002')];
  const deleting = [
    { op: 'delete', source: 'client', delta: { t: 'run', id: 'run00001', born: '1:0:srv', life: ['dead', '4:0:r_a'] } },
    { op: 'delete', source: 'client', delta: { t: 'lap', id: 'lap00002', born: '2:0:r_a', life: ['dead', '4:0:r_a'] } },
  ];
  assert.deepEqual(probe.check(context(rows), deleting), [{ t: 'lap', id: 'lap00001', born: '2:0:r_a', life: ['dead', null] }]);
  assert.throws(() => probe.check(context([]), [{ op: 'create', source: 'client', delta: { t: 'run', id: 'run00001' } }]), (error) => error.code === 'invalid');
  assert.deepEqual(probe.check(context([]), [{ op: 'create', source: 'command', delta: { t: 'run', id: 'run00001' } }]), []);
});
