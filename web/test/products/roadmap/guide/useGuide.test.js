import test from 'node:test';
import assert from 'node:assert/strict';
import { GuideDraft, guideLengthBucket } from '../../../../src/products/roadmap/guide/GuideDraft.js';
import { closuresIn } from '../sourceClosures.js';

const guide = await closuresIn('guide/useGuide.js');

// The save as written, its collaborators recorded: which door took the write, what reported and what was told.
function saveWith({ ready = true, sessionTree = 'sail', claimed = true, patch = async () => {}, local = async () => {} } = {}) {
  const calls = [];
  const save = guide.callback('save', {
    treeId: 'sail',
    text: 'One step a week.',
    ownWrite: { current: null },
    sessionRef: { current: { treeId: sessionTree, setGuide: (next) => { calls.push(['session', next]); return ready; } } },
    LocalTreeRegistry: class { get(id) { return id === 'sail' ? { id, claimed } : null; } },
    setLocalGuide: async (treeId, next) => { calls.push(['device', treeId, next]); await local(); },
    setGuide: async (treeId, next) => { calls.push(['patch', treeId, next]); await patch(); },
    reportUnexpectedFailure: (operation, error) => calls.push(['report', operation, error.status]),
    track: (name, props) => calls.push(['event', name, { ...props }]),
    guideLengthBucket,
  });
  return { save, calls };
}

test('a save goes through the session as a stamped register when it can take the write, and empty is none', async () => {
  const { save, calls } = saveWith();
  assert.equal(await save(new GuideDraft('One step a week.', 'Two steps a week.')), true);
  assert.equal(await save(new GuideDraft('One step a week.', ' \n ')), true);
  assert.deepEqual(calls, [
    ['session', 'Two steps a week.'], ['event', 'roadmap_guide', { step: 'save', outcome: 'saved', length: '1-500' }],
    ['session', ''], ['event', 'roadmap_guide', { step: 'save', outcome: 'cleared', length: '0' }],
  ]);
});

test('an unchanged save writes nothing and says so', async () => {
  const { save, calls } = saveWith();
  assert.equal(await save(new GuideDraft('Old base', 'One step a week.')), true);
  assert.deepEqual(calls, [['event', 'roadmap_guide', { step: 'save', outcome: 'unchanged', length: '1-500' }]]);
});

test('before its lattice loads, a device tree takes the write in its own store and a server tree through PATCH', async () => {
  const device = saveWith({ ready: false, claimed: false });
  assert.equal(await device.save(new GuideDraft('', 'Written signed out.')), true);
  assert.deepEqual(device.calls.slice(0, 2), [['session', 'Written signed out.'], ['device', 'sail', 'Written signed out.']]);
  const server = saveWith({ ready: false });
  assert.equal(await server.save(new GuideDraft('', 'Written.')), true);
  assert.deepEqual(server.calls.slice(0, 2), [['session', 'Written.'], ['patch', 'sail', 'Written.']]);
  const elsewhere = saveWith({ sessionTree: 'another' });
  await elsewhere.save(new GuideDraft('', 'Written.'));
  assert.deepEqual(elsewhere.calls[0], ['patch', 'sail', 'Written.']);
});

test('a save no door took keeps the draft and hands the failure to the reporter under its static operation', async () => {
  for (const status of [403, 0, 503]) {
    const failure = Object.assign(new Error('private server sentence'), { status });
    const { save, calls } = saveWith({ ready: false, patch: async () => { throw failure; } });
    assert.equal(await save(new GuideDraft('', 'Written.')), false);
    assert.deepEqual(calls.slice(2), [
      ['report', 'roadmap-guide-save', status],
      ['event', 'roadmap_guide', { step: 'save', outcome: 'failed', length: '1-500' }],
    ]);
  }
});
