import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract } from '../../../platform/domain-kit/vectors.js';
import { receiptLine } from '../../../../src/products/roadmap/coach/receiptLine.js';

// D-4: each receipt of packages/api-contract/roadmap/coach/receipts.json reads its line, at most eight words.
for (const vector of Contract.vectors('roadmap/coach/receipts.json')) {
  test(`receipts.json: ${vector.name}`, () => {
    assert.deepEqual({ line: receiptLine(vector.input.receipt, vector.input.fate ?? null) }, vector.expect);
  });
}
