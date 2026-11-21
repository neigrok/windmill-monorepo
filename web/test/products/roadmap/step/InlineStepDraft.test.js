import test from 'node:test';
import assert from 'node:assert/strict';
import { InlineStepDraft, fieldValue, sameFieldValue } from '../../../../src/products/roadmap/step/InlineStepDraft.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { editGesture } from '../../../../src/products/roadmap/board/acts.js';

test('one field request trims the name and leaves peer description, kind and edges alone', () => {
  const draft = new InlineStepDraft({ editId: 'edit', stepId: 'wind', field: 'label', baselineValue: 'Read wind' }).withValue('  Read gusts  ');
  const tree = new SkillTree({ id: 'sail', nodes: [
    { id: 'rig', label: 'Rig', prerequisites: [] },
    { id: 'wind', label: 'Read wind', description: 'Peer description', color: 'plum', prerequisites: ['rig'] },
  ] });
  const request = draft.request();
  assert.deepEqual({ ...request }, { editId: 'edit', draftRevision: 1, stepId: 'wind', field: 'label', value: 'Read gusts', expectedCurrentValue: 'Read wind' });
  assert.deepEqual(editGesture(tree, request.sparse), { kind: 'EditNode', id: 'wind', label: 'Read gusts' });
  assert.equal(request.matches(draft.withValue('newer')), false);
  assert.throws(() => draft.withValue(' ').request(), { name: 'TypeError', message: 'A step requires a name' });
});

test('blank descriptions and empty prerequisite membership are intentional sparse writes', () => {
  const tree = new SkillTree({ id: 'sail', nodes: [{ id: 'rig', label: 'Rig', prerequisites: [] }, { id: 'wind', label: 'Wind', description: 'Peer', prerequisites: ['rig'] }] });
  assert.deepEqual(editGesture(tree, { id: 'wind', description: '' }), { kind: 'EditNode', id: 'wind', description: '' });
  assert.deepEqual(editGesture(tree, { id: 'wind', prerequisites: [] }), { kind: 'EditNode', id: 'wind', addPrerequisites: [], removePrerequisites: ['rig'] });
  assert.equal(editGesture(tree, { id: 'wind' }), null);
});

test('prerequisite equality is set based, immutable, and removal is visible without losing remaining choice', () => {
  const draft = new InlineStepDraft({ editId: 'edit', stepId: 'wind', field: 'prerequisites', baselineValue: ['parts', 'rig'] });
  assert.equal(draft.withValue(['rig', 'parts', 'rig']).dirty, false);
  assert.ok(Object.isFrozen(draft.draftValue));
  const next = draft.withValue(['parts', 'rig', 'bowline']).reconcile(new SkillTree({ id: 'sail', nodes: [
    { id: 'rig', label: 'Rig', prerequisites: [] }, { id: 'bowline', label: 'Bowline', prerequisites: [] }, { id: 'wind', label: 'Wind', prerequisites: ['rig'] },
  ] }));
  assert.deepEqual({ value: next.draftValue, baseline: next.baselineValue, revision: next.draftRevision, notice: next.selectionUpdated },
    { value: ['bowline', 'rig'], baseline: ['parts', 'rig'], revision: 2, notice: true });
  assert.equal(sameFieldValue('prerequisites', ['rig', 'bowline'], next.draftValue), true);
});

test('latest value is accepted only by explicit load and save consent owns the displayed value', () => {
  const draft = new InlineStepDraft({ editId: 'edit', stepId: 'wind', field: 'description', baselineValue: 'Before' }).withValue('My text');
  const request = draft.request('Peer one');
  assert.equal(request.expectedCurrentValue, 'Peer one');
  assert.equal(sameFieldValue('description', request.expectedCurrentValue, 'Peer two'), false);
  const latest = draft.loadLatest({ id: 'wind', description: 'Peer two' });
  assert.deepEqual({ value: latest.draftValue, baseline: latest.baselineValue, dirty: latest.dirty, revision: latest.draftRevision }, { value: 'Peer two', baseline: 'Peer two', dirty: false, revision: 2 });
  assert.equal(fieldValue({ prerequisites: [], color: null }, 'color'), 'terracotta');
});
