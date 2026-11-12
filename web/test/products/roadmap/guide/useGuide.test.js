import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHook } from '../../gym/harness.mjs';
import { GuideDraft, InadmissibleGuide, guideLengthBucket, saveFailureReason } from '../../../../src/products/roadmap/guide/GuideDraft.js';
import { guidesAbove, readFailureReason } from '../../../../src/products/roadmap/guide/GuidesAbove.js';
import { useRoomGuide } from '../../../../src/products/roadmap/guide/useGuide.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { MissingDeviceTree } from '../../../../src/products/roadmap/sync/localTrees.js';
import { closuresIn } from '../sourceClosures.js';

const guide = await closuresIn('guide/useGuide.js');

// The save as written, its collaborators recorded: which door took the write, what reported and what was told. It answers
// null once a door took the guide, else why none did.
function saveWith({ ready = true, sessionTree = 'sail', claimed = true, owner = true, online = true, patch = async () => {}, local = async () => {} } = {}) {
  const calls = [];
  const save = guide.callback('save', {
    treeId: 'sail',
    owner,
    text: 'One step a week.',
    ownWrite: { current: null },
    sessionRef: { current: { treeId: sessionTree, setGuide: (next) => {
      calls.push(['session', next]);
      if (ready instanceof Error) throw ready;
      return ready;
    } } },
    LocalTreeRegistry: class { get(id) { return id === 'sail' ? { id, claimed } : null; } },
    setLocalGuide: async (treeId, next) => { calls.push(['device', treeId, next]); await local(); },
    setGuide: async (treeId, next) => { calls.push(['patch', treeId, next]); await patch(); },
    reportUnexpectedFailure: (operation, error) => calls.push(['report', operation, error.status]),
    track: (name, props) => calls.push(['event', name, { ...props }]),
    guideLengthBucket,
    saveFailureReason,
    navigator: { onLine: online },
  });
  return { save, calls };
}

test('a save goes through the session as a stamped register when it can take the write, and empty is none', async () => {
  const { save, calls } = saveWith();
  assert.equal(await save(new GuideDraft('One step a week.', 'Two steps a week.')), null);
  assert.equal(await save(new GuideDraft('One step a week.', ' \n ')), null);
  assert.deepEqual(calls, [
    ['session', 'Two steps a week.'], ['event', 'roadmap_guide', { step: 'save', outcome: 'saved', length: '1-500' }],
    ['session', ''], ['event', 'roadmap_guide', { step: 'save', outcome: 'cleared', length: '0' }],
  ]);
});

test('an unchanged save writes nothing and says so', async () => {
  const { save, calls } = saveWith();
  assert.equal(await save(new GuideDraft('Old base', 'One step a week.')), null);
  assert.deepEqual(calls, [['event', 'roadmap_guide', { step: 'save', outcome: 'unchanged', length: '1-500' }]]);
});

test('before its lattice loads, a device tree takes the write in its own store and a server tree through PATCH', async () => {
  const device = saveWith({ ready: false, claimed: false });
  assert.equal(await device.save(new GuideDraft('', 'Written signed out.')), null);
  assert.deepEqual(device.calls.slice(0, 2), [['session', 'Written signed out.'], ['device', 'sail', 'Written signed out.']]);
  const server = saveWith({ ready: false });
  assert.equal(await server.save(new GuideDraft('', 'Written.')), null);
  assert.deepEqual(server.calls.slice(0, 2), [['session', 'Written.'], ['patch', 'sail', 'Written.']]);
  const elsewhere = saveWith({ sessionTree: 'another' });
  await elsewhere.save(new GuideDraft('', 'Written.'));
  assert.deepEqual(elsewhere.calls[0], ['patch', 'sail', 'Written.']);
});

test('a save no door took reports its static operation and answers why, the bounded reason its event carries', async () => {
  const failing = (status) => async () => { throw Object.assign(new Error('private server sentence'), { status }); };
  for (const [options, status, reason] of [
    [{ ready: false, online: false, patch: failing(0) }, 0, 'offline'],
    [{ ready: false, patch: failing(0) }, 0, 'server'],
    [{ ready: false, patch: failing(403) }, 403, 'refused'],
    [{ ready: false, patch: failing(429) }, 429, 'server'],
    [{ ready: false, patch: failing(503) }, 503, 'server'],
    [{ ready: new InadmissibleGuide() }, undefined, 'refused'],
    [{ ready: false, claimed: false, local: async () => { throw new MissingDeviceTree(); } }, undefined, 'device'],
  ]) {
    const { save, calls } = saveWith(options);
    assert.equal(await save(new GuideDraft('', 'Written.')), reason);
    assert.deepEqual(calls.filter(([kind]) => kind === 'report' || kind === 'event'), [
      ['report', 'roadmap-guide-save', status],
      ['event', 'roadmap_guide', { step: 'save', outcome: 'failed', length: '1-500', reason }],
    ], reason);
  }
});

test('a save over a guide changed elsewhere since writing began leaves a conflict beside its save', async () => {
  const { save, calls } = saveWith();
  assert.equal(await save(new GuideDraft('The guide writing began from.', 'Mine.')), null);
  assert.deepEqual(calls.slice(1), [
    ['event', 'roadmap_guide', { step: 'save', outcome: 'saved', length: '1-500' }],
    ['event', 'roadmap_guide', { step: 'conflict' }],
  ]);
  const quiet = saveWith();
  await quiet.save(new GuideDraft('One step a week.', 'Mine.'));
  assert.deepEqual(quiet.calls.slice(1), [['event', 'roadmap_guide', { step: 'save', outcome: 'saved', length: '1-500' }]]);
});

test('a save by someone who is not the owner writes through no door and answers that it was refused', async () => {
  const { save, calls } = saveWith({ owner: false });
  assert.equal(await save(new GuideDraft('One step a week.', 'Two steps a week.')), 'refused');
  assert.deepEqual(calls, [['event', 'roadmap_guide', { step: 'save', outcome: 'failed', length: '1-500', reason: 'refused' }]]);
});

// The read of the guides above as written, its collaborators recorded: what was asked, what was held and what reported.
function readWith({ holder = 'u_olya', claimed = true, answer = async () => ({ guides: [] }) } = {}) {
  const calls = [];
  const effect = guide.effectWith('readGuides', {
    treeId: 't_sail',
    holder,
    LocalTreeRegistry: class { get(id) { return { id, claimed }; } },
    AbortController,
    Error,
    readGuides: (treeId, signal) => { calls.push(['read', treeId, signal.aborted]); return answer(signal); },
    setRead: (read) => calls.push(['held', read && { ...read, above: read.above && [...read.above] }]),
    guidesAbove,
    readFailureReason,
    t: (key) => ({ 'roadmap.common.untitled': 'Untitled roadmap' })[key],
    reportUnexpectedFailure: (operation, error, tags) => calls.push(['report', operation, error.status, { ...tags }]),
    reportRoadmapFailure: (operation, error, tags) => calls.push(['report', operation, error.message, { ...tags }]),
  });
  return { effect, calls };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('the guides above are read once for the tree’s holder and held for that tree and holder, without the tree’s own', async () => {
  const { effect, calls } = readWith({ answer: async () => ({ guides: [
    { treeId: 't_life', title: 'My life', text: 'Health first.', yours: true },
    { treeId: 't_year', title: '', text: 'Three things this year.', yours: false },
    { treeId: 't_sail', title: 'Learn to sail', text: 'Sundays on the water.', yours: true },
  ] }) });

  effect();
  await turn();

  assert.deepEqual(calls, [
    ['held', { treeId: 't_sail', holder: 'u_olya', above: null }],
    ['read', 't_sail', false],
    ['held', { treeId: 't_sail', holder: 'u_olya', shaped: true, above: [
      { treeId: 't_life', title: 'My life', text: 'Health first.' },
      { treeId: 't_year', title: 'Untitled roadmap', text: 'Three things this year.' },
    ] }],
  ]);
});

test('nobody but the holder asks, and a tree that lives only on this device has nothing to ask for', async () => {
  for (const options of [{ holder: null }, { claimed: false }]) {
    const { effect, calls } = readWith(options);
    assert.equal(effect(), undefined);
    await turn();
    assert.deepEqual(calls, []);
  }
});

test('a read that failed holds nothing and reports once under its static name with the kind of failure, and nothing the server said', async () => {
  for (const [status, code, reason] of [[503, 'guides-unavailable', 'unavailable'], [503, undefined, 'server'], [500, undefined, 'server'], [0, 'unreachable', 'network'], [404, undefined, 'server']]) {
    const { effect, calls } = readWith({ answer: async () => { throw Object.assign(new Error('the trees above My life could not be read'), { status, code }); } });
    effect();
    await turn();
    assert.deepEqual(calls, [
      ['held', { treeId: 't_sail', holder: 'u_olya', above: null }],
      ['read', 't_sail', false],
      ['report', 'roadmap-guides-load', status, { reason }],
    ], `${status} ${code}`);
  }
});

test('an answer that is not the contract’s shape reports once as such, and its well-formed guides are still held', async () => {
  const life = { treeId: 't_life', title: 'My life', text: 'Health first.' };
  for (const [reply, above] of [
    [null, []], [{}, []], [{ guides: { treeId: 't_life' } }, []], [{ items: [life] }, []],
    [{ guides: [{ tree_id: 't_life', name: 'My life', guide: 'Health first.' }, null, 7] }, []],
    [{ guides: [life, { treeId: '', title: 'An empty id', text: 'Words.' }, { treeId: 't_textless' }] }, [life]],
  ]) {
    const { effect, calls } = readWith({ answer: async () => reply });
    effect();
    await turn();
    assert.deepEqual(calls.slice(2), [
      ['held', { treeId: 't_sail', holder: 'u_olya', above, shaped: false }],
      ['report', 'roadmap-guides-load', 'Guides reply not the contract shape', { reason: 'shape' }],
    ], JSON.stringify(reply));
  }
});

test('leaving the tree aborts the read and drops what was held, and what the read answers or how it fails afterwards is dropped', async () => {
  for (const settle of [(answer) => answer.resolve({ guides: [{ treeId: 't_life', title: 'My life', text: 'Health first.' }] }), (answer) => answer.reject(new DOMException('The operation was aborted.', 'AbortError'))]) {
    const answer = {};
    const signals = [];
    const { effect, calls } = readWith({ answer: (signal) => { signals.push(signal); return new Promise((resolve, reject) => Object.assign(answer, { resolve, reject })); } });

    const leave = effect();
    leave();
    settle(answer);
    await turn();

    assert.deepEqual(signals.map((signal) => signal.aborted), [true]);
    assert.deepEqual(calls, [['held', { treeId: 't_sail', holder: 'u_olya', above: null }], ['read', 't_sail', false], ['held', null]]);
  }
});

// The room's guide as the hook hands it on, over a fetch that answers each tree's guides when the test says so.
function roomGuide(t) {
  const asked = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => new Promise((resolve) => asked.push({
    url: new URL(url).pathname,
    signal: init.signal,
    answer: (guides) => resolve({ ok: true, status: 200, json: async () => ({ guides }) }),
    fail: (status) => resolve({ ok: false, status, json: async () => ({ code: 'guides-unavailable' }) }),
  }));
  t.after(() => { globalThis.fetch = priorFetch; });
  const room = { treeId: 't_sail', holder: 'u_olya', owner: true, guide: 'Sundays on the water.' };
  const hook = renderHook(t, () => useRoomGuide({
    treeId: room.treeId,
    tree: new SkillTree({ id: room.treeId, title: 'Learn to sail', guide: room.guide, nodes: [] }),
    who: { owner: room.owner, reader: !room.owner, shared: false, demo: false },
    holder: room.holder,
    deviceLine: null,
    sessionRef: { current: null },
  }));
  return { room, hook, asked };
}
const aboveOf = ({ above, aboveUnread }) => ({ above, aboveUnread });

test('the room’s guide carries the guides above beside the tree’s own text, which stays the room’s, and says while they are unread', async (t) => {
  const { room, hook, asked } = roomGuide(t);
  assert.deepEqual(aboveOf(hook.tree), { above: [], aboveUnread: true });

  asked[0].answer([{ treeId: 't_year', title: 'My year', text: 'Three things this year.', yours: true }, { treeId: 't_sail', title: 'Learn to sail', text: 'An older copy of this guide.', yours: true }]);
  await turn();

  assert.deepEqual(asked.map(({ url }) => url), ['/v1/trees/t_sail/guides']);
  assert.deepEqual(aboveOf(hook.tree), { above: [{ treeId: 't_year', title: 'My year', text: 'Three things this year.' }], aboveUnread: false });
  assert.equal(hook.tree.text, 'Sundays on the water.');

  room.guide = 'Saved since.';
  hook.redraw();
  assert.equal(hook.tree.text, 'Saved since.');
  assert.deepEqual(hook.tree.above, [{ treeId: 't_year', title: 'My year', text: 'Three things this year.' }]);
  assert.equal(asked.length, 1);
});

test('a read that answers nothing above is read, and one that fails, by its status or its shape, stays unread with what it held', async (t) => {
  const none = roomGuide(t);
  none.asked[0].answer([{ treeId: 't_sail', title: 'Learn to sail', text: 'Sundays on the water.', yours: true }]);
  await turn();
  assert.deepEqual(aboveOf(none.hook.tree), { above: [], aboveUnread: false });

  const failed = roomGuide(t);
  failed.asked[0].fail(503);
  await turn();
  assert.deepEqual(aboveOf(failed.hook.tree), { above: [], aboveUnread: true });

  const unshaped = roomGuide(t);
  unshaped.asked[0].answer([{ treeId: 't_life', title: 'My life', text: 'Health first.', yours: true }, { treeId: '', title: 'An empty id', text: 'Words.' }]);
  await turn();
  assert.deepEqual(aboveOf(unshaped.hook.tree), { above: [{ treeId: 't_life', title: 'My life', text: 'Health first.' }], aboveUnread: true });
});

test('a reply for a tree the room has left is never shown, and a lapsed session is shown nothing from above', async (t) => {
  const { room, hook, asked } = roomGuide(t);

  room.treeId = 't_coast';
  hook.redraw();
  asked[0].answer([{ treeId: 't_year', title: 'My year', text: 'Three things this year.', yours: true }]);
  await turn();
  assert.deepEqual(asked.map(({ url, signal }) => [url, signal.aborted]), [['/v1/trees/t_sail/guides', true], ['/v1/trees/t_coast/guides', false]]);
  assert.deepEqual(hook.tree.above, []);

  asked[1].answer([{ treeId: 't_life', title: 'My life', text: 'Health first.', yours: true }]);
  await turn();
  assert.deepEqual(hook.tree.above, [{ treeId: 't_life', title: 'My life', text: 'Health first.' }]);

  room.holder = null;
  hook.redraw();
  assert.deepEqual(aboveOf(hook.tree), { above: [], aboveUnread: false });
  assert.equal(hook.tree.text, 'Sundays on the water.');
  assert.deepEqual(asked.map(({ signal }) => signal.aborted), [true, true]);
});

test('what was read for a holder before a lapse is dropped: a return reads again, shows nothing until that read answers, and nothing if it fails', async (t) => {
  const year = { treeId: 't_year', title: 'My year', text: 'Three things this year.' };
  for (const [settle, after] of [[(read) => read.answer([{ ...year, yours: true }]), { above: [year], aboveUnread: false }], [(read) => read.fail(503), { above: [], aboveUnread: true }]]) {
    const { room, hook, asked } = roomGuide(t);
    asked[0].answer([{ treeId: 't_life', title: 'My life', text: 'Health first.', yours: true }]);
    await turn();
    assert.deepEqual(hook.tree.above, [{ treeId: 't_life', title: 'My life', text: 'Health first.' }]);

    room.holder = null;
    hook.redraw();
    assert.deepEqual(aboveOf(hook.tree), { above: [], aboveUnread: false });

    room.holder = 'u_olya';
    hook.redraw();
    assert.deepEqual(asked.map(({ signal }) => signal.aborted), [true, false]);
    assert.deepEqual(aboveOf(hook.tree), { above: [], aboveUnread: true });

    settle(asked[1]);
    await turn();
    assert.deepEqual(aboveOf(hook.tree), after);
  }
});

test('a reader is asked for nothing, shown nothing from above, and nothing of theirs is unread', async (t) => {
  const { room, hook, asked } = roomGuide(t);
  room.owner = false;
  room.holder = null;
  hook.redraw();
  await turn();

  assert.deepEqual(asked.map(({ signal }) => signal.aborted), [true]);
  assert.deepEqual(aboveOf(hook.tree), { above: [], aboveUnread: false });
});
