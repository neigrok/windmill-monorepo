import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentDataScope } from '../../../src/shell/auth/accountChange.js';

test('only a usable holder resolves startup; a hint cannot resolve a pending scope', () => {
  const scope = new DocumentDataScope();
  assert.deepEqual(scope.read.getSnapshot(), { epoch: 0, phase: 'pending', owner: null });
  assert.equal(scope.reconcile(null), false);
  assert.equal(scope.reconcile({ restoring: true, device: { meta: {}, activeReplica: { meta: { state: 'bound', account: 'hint' } } } }), false);
  assert.equal(scope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'anon' } } } }), true);
  assert.deepEqual(scope.read.getSnapshot(), { epoch: 0, phase: 'ready', owner: { kind: 'anonymous' } });
});

test('offline restored account, lapse and same-owner recovery preserve generation and owner identity', () => {
  const scope = new DocumentDataScope();
  const engine = { online: false, device: { meta: {}, activeReplica: { meta: { state: 'bound', account: 'A', authPaused: true } } } };
  scope.reconcile(engine);
  const before = scope.read.getSnapshot();
  engine.device.activeReplica.meta.authPaused = false;
  scope.reconcile(engine);
  assert.equal(scope.read.getSnapshot(), before);
  assert.deepEqual(before, { epoch: 0, phase: 'ready', owner: { kind: 'account', id: 'A' } });
});

test('replacement and forced same-owner cleanup fence synchronously, with ticket-bound completion', () => {
  const observed = [];
  const scope = new DocumentDataScope({ invalidate: () => observed.push(scope.read.getSnapshot()) });
  const engine = { device: { meta: {}, activeReplica: { meta: { state: 'bound', account: 'A' } } } };
  scope.reconcile(engine);
  const first = scope.begin({ kind: 'account', id: 'B' });
  const second = scope.begin({ kind: 'account', id: 'A' });
  assert.equal(scope.reconcile(engine, first), false);
  engine.device.meta.deviceCleanup = { previous: 'A' };
  assert.equal(scope.reconcile(engine, second), false);
  delete engine.device.meta.deviceCleanup;
  assert.equal(scope.reconcile(engine, second), true);
  assert.deepEqual(observed, [{ epoch: 1, phase: 'changing', owner: { kind: 'account', id: 'B' } }, { epoch: 2, phase: 'changing', owner: { kind: 'account', id: 'A' } }]);
  assert.deepEqual(scope.read.getSnapshot(), { epoch: 2, phase: 'ready', owner: { kind: 'account', id: 'A' } });
});
