import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, opOf } from '../../server/identity.js';
import { registry, st } from '../../vectors/fixtures.js';

// engine.md §4.3, transcribed cell by cell. "ok" is ok with no change; `revivable: apply; else id-spent`
// is written as its two outcomes.
const SPEC = `
op      | none           | foreign        | alive=  | alive≠         | dead=                              | dead≠
create  | apply          | id-taken       | apply   | id-taken       | ok                                 | id-spent
update  | unknown-record | unknown-record | apply   | unknown-record | record-dead                        | unknown-record
delete  | ok             | ok             | apply   | ok             | apply                              | ok
revive  | unknown-record | unknown-record | apply   | unknown-record | revivable:apply,else:id-spent      | unknown-record
`;

const BORN = st(5);
const DELTAS = {
  create: { life: ['alive', BORN], born: BORN },
  update: { born: BORN },
  delete: { life: ['dead', st(9)], born: BORN },
  revive: { life: ['alive', st(9)], born: BORN },
};
const STATES = {
  none: { state: 'none' },
  foreign: { state: 'foreign' },
  'alive=': { state: 'alive', born: BORN },
  'alive≠': { state: 'alive', born: st(4) },
  'dead=': { state: 'dead', born: BORN },
  'dead≠': { state: 'dead', born: st(4) },
};

function outcome(cell, revivable) {
  if (cell.startsWith('revivable:')) return outcome(revivable ? 'apply' : 'id-spent', revivable);
  if (cell === 'apply' || cell === 'ok') return { verdict: cell };
  return { verdict: 'refuse', code: cell };
}

test('§4.3: every cell of the decision table, for a terminal and a revivable type', () => {
  const [header, ...rows] = SPEC.trim().split('\n').map((line) => line.split('|').map((cell) => cell.trim()));
  for (const typeName of ['card', 'tag']) {
    const type = registry.type(typeName);
    for (const [op, ...cells] of rows) {
      cells.forEach((cell, index) => {
        const state = header[index + 1];
        assert.equal(opOf(type, DELTAS[op]), op);
        assert.deepEqual(decide(type, op, STATES[state], DELTAS[op].born), outcome(cell, type.revivable), `${typeName} ${op} on ${state}`);
      });
    }
  }
});

test('§4.1: keyed with life puts, keyed without life and singletons write, every other shape is invalid', () => {
  const link = registry.type('link');
  const mark = registry.type('mark');
  const meta = registry.type('meta');
  for (const state of [{ state: 'none' }, { state: 'alive' }, { state: 'dead' }]) {
    assert.deepEqual(decide(link, opOf(link, { life: ['dead', st(1)] }), state), { verdict: 'apply' });
  }
  assert.equal(opOf(link, { life: ['alive', st(1)] }), 'put');
  assert.equal(opOf(mark, {}), 'write');
  assert.equal(opOf(meta, {}), 'write');
  const invalid = [
    [registry.type('card'), { life: ['alive', st(1)] }],
    [registry.type('card'), {}],
    [link, {}],
    [link, { life: ['alive', st(1)], born: st(1) }],
    [mark, { life: ['alive', st(1)] }],
    [meta, { born: st(1) }],
  ];
  for (const [type, delta] of invalid) {
    assert.equal(opOf(type, delta), 'invalid', JSON.stringify(delta));
    assert.deepEqual(decide(type, 'invalid', { state: 'none' }, delta.born), { verdict: 'refuse', code: 'invalid' });
  }
});
