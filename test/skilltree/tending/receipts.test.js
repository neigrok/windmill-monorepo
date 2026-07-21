import test from 'node:test';
import assert from 'node:assert/strict';

import { receiptLine, meterPct } from '../../../src/skilltree/tending/receipts.js';

test('receiptLine — a run that changed something shows its summary', () => {
  assert.equal(receiptLine({ status: 'done', summary: 'Added a testing branch', edits: 3 }), 'Added a testing branch');
});

test('receiptLine — a run that touched nothing is honest about it', () => {
  assert.equal(receiptLine({ status: 'done', summary: '', edits: 0 }), 'Nothing changed');
  assert.equal(receiptLine({ status: 'done', summary: 'tried', edits: 0 }), 'Nothing changed');
});

test('receiptLine — running and failed read as their state, never a stale summary', () => {
  assert.equal(receiptLine({ status: 'running', summary: '', edits: 0 }), 'Working…');
  assert.equal(receiptLine({ status: 'failed', summary: 'half done', edits: 2 }), 'Couldn’t finish');
});

test('meterPct — fills proportionally', () => {
  assert.equal(meterPct(0, 30), 0);
  assert.equal(meterPct(15, 30), 50);
  assert.equal(meterPct(30, 30), 100);
  assert.equal(meterPct(150, 300), 50);
});

test('meterPct — never overflows or divides by a zero limit', () => {
  assert.equal(meterPct(44, 30), 100);  // an over-spent account reads full, not 147%
  assert.equal(meterPct(5, 0), 0);
  assert.equal(meterPct(0, 0), 0);
});
