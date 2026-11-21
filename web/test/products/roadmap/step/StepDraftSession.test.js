import test from 'node:test';
import assert from 'node:assert/strict';
import { StepDraftSession, stepDraftSession, invalidateStepDraftSession } from '../../../../src/products/roadmap/step/StepDraftSession.js';
import { InlineStepDraft } from '../../../../src/products/roadmap/step/InlineStepDraft.js';
import { DocumentDataScope } from '../../../../src/shell/auth/accountChange.js';

test('one document slot retains one field, rejects collisions and clears only after matching adoption', () => {
  const store = new StepDraftSession();
  const scope = new DocumentDataScope();
  scope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'anon' } } } });
  store.bindScope(scope.read);
  const draft = new InlineStepDraft({ editId: 'edit', stepId: 'wind', field: 'description', baselineValue: '' }).withValue('Private draft');
  const token = store.start({ draft, treeId: 'sail', route: { hash: '#/app/sail?step=wind' }, displayValue: draft.draftValue });
  assert.ok(store.retain(token));
  assert.equal(store.start({ draft }), null);
  const returnToken = store.requestReturn(token);
  assert.equal(store.adopt(token, {}), false);
  assert.equal(store.clear({}), false);
  assert.equal(store.getSnapshot().mode, 'retained');
  assert.equal(store.adopt(token, returnToken), true);
  assert.equal(store.getSnapshot().mode, 'active');
  assert.equal(store.getSnapshot().draft.draftValue, 'Private draft');
});

test('epoch fencing hides content even when invalidation throws; rebinding zero counters cannot resurrect it', () => {
  const store = new StepDraftSession();
  const reports = [];
  const scope = new DocumentDataScope({ invalidate: () => { throw new Error('failure'); }, report: () => reports.push('invalidate') });
  scope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'bound', account: 'A' } } } });
  store.bindScope(scope.read);
  const draft = new InlineStepDraft({ stepId: 'wind', field: 'label', baselineValue: 'Before' }).withValue('Private');
  const token = store.start({ draft, displayValue: 'Private' });
  scope.begin({ kind: 'account', id: 'B' });
  assert.equal(store.getSnapshot(), null);
  assert.equal(store.update(token, { displayValue: 'Leak' }), false);
  assert.deepEqual(reports, ['invalidate']);
  const replacement = new DocumentDataScope();
  replacement.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'bound', account: 'A' } } } });
  store.bindScope(replacement.read);
  assert.equal(store.getSnapshot(), null);
  assert.equal(store.slot, null);
});

test('document access is lazy and synchronous invalidation never creates a store', () => {
  const document = {};
  invalidateStepDraftSession(document);
  assert.equal(stepDraftSession(document, { create: false }), null);
  assert.equal(stepDraftSession(document), stepDraftSession(document));
  assert.equal(stepDraftSession(null), null);
});
