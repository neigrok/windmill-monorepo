import test from 'node:test';
import assert from 'node:assert/strict';

import { receiptLine, meterPct, runFace, isTerminal } from '../../../../src/products/roadmap/tending/receipts.js';

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

test('runFace — a done run carries the ids it planted as the Undo target + the why', () => {
  assert.deepEqual(runFace({ status: 'done', summary: 'Added 3 steps under Backend', edits: 3, created: ['n1', 'n2', 'n3'], detail: 'because you asked' }), {
    kind: 'receipt', line: 'Added 3 steps under Backend', created: ['n1', 'n2', 'n3'], detail: 'because you asked',
  });
});

test('runFace — a done run that planted nothing carries an empty target (no Undo shown)', () => {
  assert.deepEqual(runFace({ status: 'done', summary: '', edits: 0 }), {
    kind: 'receipt', line: 'Nothing changed', created: [], detail: '',
  });
});

test('runFace — working and failed states', () => {
  assert.equal(runFace({ status: 'running' }).kind, 'working');
  const failed = runFace({ status: 'failed' });
  assert.equal(failed.kind, 'failed');
  assert.match(failed.line, /Nothing changed/);
});

test('runFace — the four refusal faces, out-of-allowance never a wall', () => {
  assert.equal(runFace({ status: 'refused', refusal: 'not-enabled' }).kind, 'off');
  assert.equal(runFace({ status: 'refused', refusal: 'rate-limited' }).kind, 'rate');
  const out = runFace({ status: 'refused', refusal: 'out-of-allowance' });
  assert.equal(out.kind, 'out');
  assert.match(out.line, /edit by hand/);
  assert.doesNotMatch(out.line, /[Uu]pgrade/);
  assert.equal(runFace({ status: 'refused', refusal: 'prompt-too-long' }).kind, 'long');
  assert.equal(runFace({ status: 'refused', refusal: 'prompt-empty' }).kind, 'empty');
});

test('runFace — the AI ceiling is a rolling window, and never a paywall', () => {
  const out = runFace({ status: 'refused', refusal: 'out-of-budget' });
  assert.equal(out.kind, 'out');
  assert.match(out.line, /edit by hand/);
  assert.match(out.line, /rolls on/);
  assert.doesNotMatch(out.line, /[Uu]pgrade|[Bb]uy|[Pp]lan|[Ss]ubscri/);
});

test('runFace — a transport miss is the "didn\'t land" face, not a crash', () => {
  assert.equal(runFace(null).kind, 'failed');
});

test('isTerminal — only a running run keeps the poll going', () => {
  assert.equal(isTerminal({ status: 'running' }), false);
  assert.equal(isTerminal({ status: 'done' }), true);
  assert.equal(isTerminal({ status: 'failed' }), true);
  assert.equal(isTerminal({ status: 'refused' }), true);
  assert.equal(isTerminal(null), false);  // a missed read is not terminal — poll again
});

test('isTerminal is unaffected by created ids', () => {
  assert.equal(isTerminal({ status: 'done', created: [] }), true);
});
