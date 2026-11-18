// K-3 under a write map (§7.7, E-8): every value the journal, its inverse requests and its cancellations
// recorded for a field follows the map as the record's field would, wherever it holds a typed reference.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordMap } from '../../core/references.js';
import { remapJournal } from '../../client/journal.js';
import { registry, st } from '../../vectors/fixtures.js';

test('a write map renames the typed references in every value the journal, its requests and its cancellations recorded', () => {
  const overlay = 'self/overlay/b_00000001';
  const opens = { scope: overlay, t: 'mark', id: 'oak', slot: { kind: 'field', name: 'opens' } };
  const lap = { scope: 'self/probe', t: 'lap', id: 'lap00001' };
  const lapLife = { ...lap, slot: { kind: 'life' } };
  const absent = { kind: 'recordAbsent', epoch: 'ep-1' };
  const replica = {
    journal: [{ version: 1, actId: 'g1', retained: true, sourceEntries: [{
      localId: 'g1/0', originScope: overlay, attempts: [],
      recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreOverlay', targets: [{ target: structuredClone(opens), defaultValue: 'b_00000002' }] }],
      preimages: [{ target: structuredClone(opens), value: 'b_00000002', rowSeq: 1, epoch: 'ep-1' },
        { target: structuredClone(lapLife), value: 'alive', rowSeq: 2, epoch: 'ep-1',
          record: { born: st(1100), f: { runId: ['run00002', st(1100)], weight: [40, st(1100)] } } }],
      written: [{ target: structuredClone(opens), value: 'b_00000002' }],
    }] }],
    inverses: [{ version: 1, requestId: 'g3', sourceActId: 'g1', inverseActId: 'g2', state: 'waiting', requestedAt: 9000, slots: [
      { localId: 'g2/0', commitOrder: 2, originScope: overlay, state: 'waiting', recipe: { kind: 'restore', command: 'probe.restoreOverlay',
        operations: [{ kind: 'field', target: structuredClone(opens), before: 'b_00000002' }] } },
      { localId: 'g2/1', commitOrder: 3, originScope: 'self/probe', state: 'waiting', recipe: { kind: 'restore', command: 'probe.restore',
        operations: [{ kind: 'createRecord', record: structuredClone(lap), values: { f: { runId: 'run00002', at: 5100 } }, reference: absent }] } },
    ] }],
    cancellations: [{ version: 1, inverseActId: 'g5', cancelledActId: 'g4', sourceEntries: [{ localId: 'g4/0', originScope: overlay }], units: [
      { kind: 'field', ownerLocalId: 'g4/0', target: structuredClone(opens), redoValue: 'b_00000002', restoredValue: 'b_00000002',
        restored: { kind: 'accepted', epoch: 'ep-1', version: { kind: 'stamp', stamp: st(1400) } } },
      { kind: 'createdRecord', ownerLocalId: 'g4/0', record: structuredClone(lap), redoValues: { f: { runId: 'run00002', at: 5100 } }, restored: absent },
    ] }],
  };
  remapJournal(registry, replica, new RecordMap(registry, [
    { t: 'board', from: 'b_00000002', id: 'b_00000009', scope: 'self/probe' },
    { t: 'run', from: 'run00002', id: 'run00009', scope: 'self/probe' },
  ]));
  const [source] = replica.journal[0].sourceEntries;
  assert.deepEqual(source.recipes[0].targets, [{ target: opens, defaultValue: 'b_00000009' }]);
  assert.deepEqual(source.preimages.map(({ value }) => value), ['b_00000009', 'alive']);
  assert.deepEqual(source.preimages[1].record, { born: st(1100), f: { runId: ['run00009', st(1100)], weight: [40, st(1100)] } });
  assert.deepEqual(source.written, [{ target: opens, value: 'b_00000009' }]);
  const [field, created] = replica.inverses[0].slots.map(({ recipe }) => recipe.operations[0]);
  assert.deepEqual(field, { kind: 'field', target: opens, before: 'b_00000009' });
  assert.deepEqual(created, { kind: 'createRecord', record: lap, values: { f: { runId: 'run00009', at: 5100 } }, reference: absent });
  const [unit, record] = replica.cancellations[0].units;
  assert.deepEqual([unit.redoValue, unit.restoredValue, unit.target], ['b_00000009', 'b_00000009', opens]);
  assert.deepEqual(record.redoValues, { f: { runId: 'run00009', at: 5100 } });
});
