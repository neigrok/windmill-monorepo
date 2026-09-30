import assert from 'node:assert/strict';
import test from 'node:test';
import { isVisible } from '../../core/rows.js';

// §2.4 visibility of a type without life and without visibleWhen: any lattice register or text counts,
// whatever it holds; a serial value never does.
test('§2.4: without visibleWhen, a register or a text makes a lifeless record visible, and a serial never does', () => {
  const type = { identity: 'keyed', life: false, fields: { no: { kind: 'serial' }, note: { kind: 'lww' }, memo: { kind: 'text' } } };
  const at = '1000:0:r_aaaaaaaaaaaa';
  assert.deepEqual([
    isVisible(type, { t: 'row', id: 'a', v: { no: 1 } }),
    isVisible(type, { t: 'row', id: 'a', f: { note: [null, at] } }),
    isVisible(type, { t: 'row', id: 'a', x: { memo: { text: '', rev: 1, merged: false } } }),
    isVisible(type, { t: 'row', id: 'a' }),
  ], [false, true, true, false]);
});
