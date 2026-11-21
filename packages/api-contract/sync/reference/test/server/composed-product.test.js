import test from 'node:test';
import assert from 'node:assert/strict';
import { composeRegistry } from '../../core/composition.js';
import { Registry } from '../../core/registry.js';
import { admit, Refusal } from '../../server/admit.js';
import { ComposedProduct } from '../../server/composed-product.js';
import { ServerState } from '../../server/state.js';

function registry() {
  const names = ['alpha', 'beta', 'gamma'];
  return new Registry(composeRegistry({ composition: 'three', registries: names.map((name) => `${name}.registry.json`) },
    Object.fromEntries(names.map((name) => [`${name}.registry.json`, {
      registry: name, version: 3, minVersion: 2, products: { [name]: {} },
      types: [{ type: name, scope: `product:${name}`, identity: 'singleton', singletonId: name, idPattern: `^${name}$`,
        life: false, origins: ['server', 'replica'], fields: { value: { kind: 'lww', writer: 'client', domain: { type: 'string' } } } }],
      commands: [{ name: `${name}.set`, scope: `product:${name}`, origins: ['server'], serverInternal: false, args: {} }],
    }]))));
}

test('the third command discovers its full closure once and each touched product checks all changes once', () => {
  for (const refuse of [false, true]) {
    const schema = registry(), calls = [], names = ['alpha', 'beta', 'gamma'];
    const products = Object.fromEntries([...names].reverse().map((name) => [name, {
      isReplay(ctx) { calls.push(`${name}.replay`); return ctx.productState.receipt === 'gamma'; },
      discoverEffectScopes(ctx) {
        calls.push(`${name}.discover`);
        assert.equal(ctx.scopeKey, 'acct:A/gamma');
        if (ctx.productState.receipt) return [];
        assert.deepEqual(ctx.rowsOf('gamma'), []);
        return ['acct:A/alpha', 'acct:A/beta'];
      },
      runCommand(ctx, command) {
        calls.push(`${name}.run`);
        assert.equal(command.name, 'gamma.set');
        if (ctx.productState.receipt) return { deltas: [], write: [] };
        ctx.productState.receipt = 'gamma';
        const delta = (type) => ({ t: type, id: type, f: { value: ['command', null] } });
        return { deltas: [delta('gamma')], into: ['alpha', 'beta'].map((type) => ({ scopeKey: `acct:A/${type}`, deltas: [delta(type)] })), write: [] };
      },
      check(ctx, changes) {
        calls.push(`${name}.check`);
        assert.equal(ctx.scopeKey, `acct:A/${name}`);
        assert.equal(ctx.originScopeKey, 'acct:A/gamma');
        assert.equal(ctx.intent.cmd.name, 'gamma.set');
        if (!changes.length) return [];
        assert.deepEqual(changes.map((change) => change.type.type).sort(), names);
        assert.equal(ctx.scopedChanges(ctx.scopeKey)[0].after.f.value[0], 'command');
        if (refuse && name === 'gamma') throw new Refusal('invalid');
        ctx.productState[name] = true;
        return [{ t: name, id: name, f: { value: ['checked', null] } }];
      },
    }]));
    const product = new ComposedProduct(schema, products);
    const state = ServerState.empty({ epoch: 'ep-1' });
    for (const name of names) state.insertScope(`acct:A/${name}`, { kind: `product:${name}`, owner: 'A' });
    const before = state.toJSON();
    const outcome = admit({ state, registry: schema, product, origin: { kind: 'server', account: 'A' }, serverNow: 1000,
      intent: { scope: 'self/gamma', cmd: { name: 'gamma.set', args: {} } } });
    assert.deepEqual(calls, ['gamma.replay', 'gamma.discover', 'gamma.run', 'alpha.check', 'beta.check', 'gamma.check']);
    assert.deepEqual(state.toJSON(), before);
    if (refuse) {
      assert.deepEqual(outcome.result, { s: 'refused', code: 'invalid' });
      assert.deepEqual(outcome.state.toJSON(), before);
      assert.deepEqual(outcome.writes, []);
    } else {
      assert.deepEqual(outcome.result, { s: 'ok', seq: 1, write: [] });
      assert.deepEqual(outcome.writes.map((write) => write.key), ['acct:A/gamma', 'acct:A/alpha', 'acct:A/beta']);
      assert.deepEqual(outcome.state.product, { receipt: 'gamma', alpha: true, beta: true, gamma: true });
      for (const name of names) assert.equal(outcome.state.row(`acct:A/${name}`, name, name).f.value[0], 'checked');
      calls.length = 0;
      const replay = admit({ state: outcome.state, registry: schema, product, origin: { kind: 'server', account: 'A' }, serverNow: 2000,
        intent: { scope: 'self/gamma', cmd: { name: 'gamma.set', args: {} }, guard: [{ t: 'gamma', id: 'gamma', field: 'value', stamp: '1:0:a' }] } });
      assert.deepEqual(calls, ['gamma.replay', 'gamma.discover', 'gamma.run', 'gamma.check']);
      assert.deepEqual(replay.result, { s: 'ok', seq: 1, write: [] });
      assert.deepEqual(replay.writes, []);
      assert.deepEqual(replay.state.toJSON(), outcome.state.toJSON());
    }
  }
});

test('coverage is exact, scoped overrides retain the origin, and revisions use the scope product policy', () => {
  const schema = registry();
  assert.throws(() => new ComposedProduct(schema, { alpha: {}, beta: {} }), /every composed product/);
  assert.throws(() => new ComposedProduct(schema, { alpha: {}, beta: {}, gamma: {}, extra: {} }), /every composed product/);
  const contexts = [], changes = [{ type: schema.type('beta'), scopeKey: 'acct:A/beta' }];
  const product = new ComposedProduct(schema, {
    alpha: { revisionsKept: 1 }, beta: { effects(ctx, full) { contexts.push(ctx); assert.equal(full, changes); return { byScope: {} }; }, revisionsKept: 2 },
    gamma: { pruneRevisions(ctx) { assert.equal(ctx.scopeKey, 'acct:A/gamma'); return ctx.archived; } },
  });
  const ctx = { account: 'A', originScopeKey: 'acct:A/alpha', scopeKey: 'acct:A/alpha', deltas: [], scope: () => undefined };
  assert.throws(() => product.runCommand(ctx, { name: 'alpha.set', args: {} }), (error) => error instanceof Refusal && error.code === 'invalid');
  assert.deepEqual(product.effects(ctx, changes), { byScope: {} });
  assert.deepEqual(contexts, [ctx]);
  const revisions = [1, 2, 3].map((rev) => ({ t: 'text', id: 'one', field: 'text', rev, text: `${rev}` }));
  for (const [name, expected] of [['alpha', revisions.slice(2)], ['beta', revisions.slice(1)], ['gamma', revisions.slice(0, 1)]]) {
    assert.deepEqual(product.pruneRevisions({ ...ctx, scopeKey: `acct:A/${name}`, revisions, archived: revisions.slice(0, 1) }), expected);
  }
});
