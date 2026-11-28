import test from 'node:test';
import assert from 'node:assert/strict';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { isOrderKey } from '../../../../../packages/api-contract/sync/reference/core/fracindex.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { roadmapRegistry } from './vectors.js';
import { CarriedConversations, CarriedIds, CarriedRoadmap, CarryConversations, CarryLedger, CarryMark, CarryRoadmap, CarryStepNote, DiscardKept, RecordCarry, carriedOrds,
  carryLedgerOf, kept, withinBounds } from '../../../../src/products/roadmap/domain/carry.js';
import { CoachMessage, CoachProposal, CoachThread, OpenTurn } from '../../../../src/products/roadmap/domain/conversation.js';
import { RoadmapKind } from '../../../../src/products/roadmap/domain/kinds.js';
import { Complete, StepMark } from '../../../../src/products/roadmap/domain/progress.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { CreateRoadmap, Roadmap, RoadmapMeta } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { RoadmapLink, RoadmapStep } from '../../../../src/products/roadmap/domain/steps.js';
import { StepNote } from '../../../../src/products/roadmap/domain/workspace.js';

const OLD = 't_00000000000000aa';

// A roadmap as the old bundle kept it, in its own order: two genesis kinds and one of its own, three steps in a line.
const sailing = () => ({
  title: 'Learn to sail', guide: 'Slowly.',
  kinds: [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
    { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
    { id: 'k_rope', hue: 'sky', label: 'Rope', description: '' },
  ],
  steps: [
    { id: 'wind', label: 'Read the wind', icon: 'sparkles', color: 'olive', description: '', links: [], order: '' },
    { id: 'dock', label: 'Leave the dock', icon: '', color: 'mauve', description: 'Quietly', links: [{ url: 'https://example.org', label: 'Tides' }, { url: '  ', label: 'nothing' }], order: 'a0' },
    { id: 'solo', label: 'Sail solo', icon: '', color: 'sky', description: '', links: [], order: 'a0' },
  ],
  links: [['wind', 'dock'], ['dock', 'solo'], ['dock', 'solo'], ['solo', 'solo']],
});

const committed = (outcome) => {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return outcome;
};

async function phone() {
  return Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
}

const records = (a, scope, type) => a.runner.read(scope, (read) => read.views.visible('drawn', type.type))
  .map((record) => ({ id: record.id, f: Object.fromEntries(Object.entries(record.f ?? {}).map(([name, [value]]) => [name, value])) }));

test('carried ids are derived from the old ones, the same every time and each of its type’s shape', () => {
  assert.equal(CarriedIds.roadmap(OLD), CarriedIds.roadmap(OLD));
  assert.notEqual(CarriedIds.roadmap(OLD), CarriedIds.roadmap('t_00000000000000ab'));
  assert.match(CarriedIds.roadmap(OLD), new RegExp(roadmapRegistry.type('tree').idPattern));
  const item = CarriedIds.item('subtask', OLD, 'wind', 'd7c5b1e2-0000-4000-8000-000000000001');
  assert.match(item, new RegExp(roadmapRegistry.type('subtask').idPattern));
  assert.notEqual(item, CarriedIds.item('stepLink', OLD, 'wind', 'd7c5b1e2-0000-4000-8000-000000000001'));
});

test('carried steps keep each old key that still sorts after the one before it, and take a key in place of every other', () => {
  const ords = carriedOrds(['', '', 'a0', 'a0', 'not a key', 'a3', 'a2']);
  assert.equal(ords.length, 7);
  assert.equal(ords[2], 'a0');
  assert.equal(ords[5], 'a3');
  assert.ok(ords.every(isOrderKey), JSON.stringify(ords));
  assert.deepEqual([...ords].sort(), ords, 'the keys ascend in the old order');
  assert.equal(new Set(ords).size, ords.length);
});

test('a carried roadmap reads colours and links as the old server did, and sets aside whole a step past its bound with every link touching it', async () => {
  const a = await phone();
  try {
    const roadmap = sailing();
    roadmap.steps.push({ id: 'long', label: 'x'.repeat(201), icon: '', color: 'gold', description: '', links: [], order: 'a5' });
    roadmap.links.push(['solo', 'long']);
    const carried = new CarriedRoadmap(OLD, roadmap, roadmapRegistry, a.runner.moment());
    assert.deepEqual(carried.kept, [kept(OLD, 'pastBound', { t: 'node', id: 'long' }, { label: 'x'.repeat(201), icon: '', color: 'gold', description: '', links: [] })]);
    assert.deepEqual(carried.units.map((unit) => ({ step: unit.step.value.id.record, color: unit.step.value.color, links: unit.step.value.links,
      into: unit.links.map((link) => [link.value.from, link.value.to]) })), [
      { step: 'wind', color: 'olive', links: [], into: [] },
      { step: 'dock', color: 'terracotta', links: [{ url: 'https://example.org', label: 'Tides' }], into: [['wind', 'dock']] },
      { step: 'solo', color: 'sky', links: [], into: [['dock', 'solo']] },
    ]);
    assert.deepEqual(carried.kinds.map((kind) => [kind.value.id.record, kind.value.ord]), [['build', 'a0'], ['learn', 'a1'], ['k_rope', 'a2']]);
  } finally {
    a.close();
  }
});

test('a carried roadmap’s kinds past the cap are set aside, each with its words', async () => {
  const a = await phone();
  try {
    const roadmap = sailing();
    roadmap.kinds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, index) => ({ id, hue: 'gold', label: `Kind ${index}`, description: '' }));
    const carried = new CarriedRoadmap(OLD, roadmap, roadmapRegistry, a.runner.moment());
    assert.deepEqual(carried.kinds.map((kind) => kind.value.id.record), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(carried.kept.map((each) => [each.reason, each.subject, each.values.label]), [['capFilled', { t: 'kind', id: 'g' }, 'Kind 6']]);
  } finally {
    a.close();
  }
});

test('a roadmap carried under its id is created with every id it held, reaches the server, and is not made twice', async () => {
  const a = await phone();
  try {
    const carried = new CarriedRoadmap(OLD, sailing(), roadmapRegistry, a.runner.moment());
    committed(await a.runner.runAct(new CarryRoadmap(OLD, carried)));
    for (const scope of [RoadmapScopes.tree(OLD), RoadmapScopes.overlay(OLD)]) a.observe(scope);
    await a.sync();
    assert.deepEqual(a.runner.read(RoadmapScopes.account, (read) => read.repository(Roadmap).all('drawn').map((roadmap) => roadmap.id.record)), [OLD]);
    const tree = RoadmapScopes.tree(OLD);
    assert.deepEqual(records(a, tree, RoadmapMeta), [{ id: 'meta', f: { title: 'Learn to sail', guide: 'Slowly.' } }]);
    assert.deepEqual(records(a, tree, RoadmapKind).map(({ id, f }) => [f.ord, id, f.hue, f.label]).sort(),
      [['a0', 'build', 'terracotta', 'Build'], ['a1', 'learn', 'olive', 'Learn'], ['a2', 'k_rope', 'sky', 'Rope']]);
    assert.deepEqual(records(a, tree, RoadmapStep).map(({ id, f }) => [id, f.label, f.color]).sort(),
      [['dock', 'Leave the dock', 'terracotta'], ['solo', 'Sail solo', 'sky'], ['wind', 'Read the wind', 'olive']]);
    assert.deepEqual(records(a, tree, RoadmapLink).map(({ id }) => id).sort(), [['dock', 'solo'], ['wind', 'dock']]);
    assert.equal((await a.runner.runAct(new CarryRoadmap(OLD, carried))).kind, 'unchanged');
  } finally {
    a.close();
  }
});

test('a mark found on a seed or left undrained stands only where the person holds no mark of the step', async () => {
  const a = await phone();
  try {
    committed(await a.runner.runAct(new CarryRoadmap(OLD, new CarriedRoadmap(OLD, sailing(), roadmapRegistry, a.runner.moment()))));
    committed(await a.runner.runAct(new CarryMark(OLD, 'wind')));
    committed(await a.runner.runAct(Complete(OLD, 'dock')));
    const reset = await a.runner.runAct(new CarryMark(OLD, 'wind'));
    assert.equal(reset.kind, 'unchanged');
    assert.equal((await a.runner.runAct(new CarryMark(OLD, 'dock'))).kind, 'unchanged');
    assert.deepEqual(records(a, RoadmapScopes.overlay(OLD), StepMark).map(({ id, f }) => [id, f.mark]).sort(),
      [['dock', { status: 'complete', outOfOrder: false }], ['wind', { status: 'complete', outOfOrder: false }]]);
    const gone = await a.runner.runAct(new CarryMark(OLD, 'never'));
    assert.deepEqual(gone.kind === 'refused' && gone.refusal.kind, 'gone');
  } finally {
    a.close();
  }
});

test('a note the device kept is written where the step holds none, after the one it holds where it holds another, and once', async () => {
  const a = await phone();
  try {
    committed(await a.runner.runAct(new CarryRoadmap(OLD, new CarriedRoadmap(OLD, sailing(), roadmapRegistry, a.runner.moment()))));
    const note = (step) => a.runner.read(RoadmapScopes.overlay(OLD), (read) => read.repository(StepNote).find(new Id(step, StepNote), 'drawn')?.text ?? null);
    committed(await a.runner.runAct(new CarryStepNote(OLD, 'wind', 'Watch the flags.')));
    assert.equal(note('wind'), 'Watch the flags.');
    assert.equal((await a.runner.runAct(new CarryStepNote(OLD, 'wind', 'Watch the flags.'))).kind, 'unchanged');
    committed(await a.runner.runAct(new CarryStepNote(OLD, 'wind', 'From the other browser.')));
    assert.equal(note('wind'), 'Watch the flags.\n\nFrom the other browser.');
    assert.equal((await a.runner.runAct(new CarryStepNote(OLD, 'wind', 'From the other browser.'))).kind, 'unchanged');
    assert.equal((await a.runner.runAct(new CarryStepNote(OLD, 'dock', ''))).kind, 'unchanged');
    const long = await a.runner.runAct(new CarryStepNote(OLD, 'dock', 'n'.repeat(16_001)));
    assert.deepEqual(long.kind === 'refused' && [long.refusal.kind, long.refusal.violation.rule], ['invalid', 'stepNote.text']);
    assert.equal(note('dock'), null);
  } finally {
    a.close();
  }
});

test('the ledger takes each carry’s entry: its roadmap and whether the carry-over made it, each writer’s newest stamp, its items and every record it kept, once, and Discard drops one it kept', async () => {
  const a = await phone();
  try {
    const first = new CarryLedger({ to: OLD, created: true, frontier: { r_one: '200:1:r_one' }, items: { a: 'x' }, kept: [kept(OLD, 'pastBound', { t: 'subtask', id: 's' }, { label: 'long' })] });
    committed(await a.runner.runAct(new RecordCarry(OLD, first)));
    assert.equal((await a.runner.runAct(new RecordCarry(OLD, first))).kind, 'unchanged');
    committed(await a.runner.runAct(new RecordCarry(OLD, new CarryLedger({ frontier: { r_one: '150:9:r_one', r_two: '300:0:r_two' }, items: { b: 'y' },
      marks: 'm', kept: first.kept }))));
    const ledger = a.runner.read(RoadmapScopes.account, (read) => carryLedgerOf(read, OLD));
    assert.deepEqual(ledger.json, { to: OLD, created: true, frontier: { r_one: '200:1:r_one', r_two: '300:0:r_two' }, items: { a: 'x', b: 'y' }, marks: 'm',
      kept: [{ id: first.kept[0].id, reason: 'pastBound', subject: { t: 'subtask', id: 's' }, values: { label: 'long' }, named: '' }] });
    assert.deepEqual(['200:1:r_one', '200:2:r_one', '1:0:r_three', '300:0:r_two'].map((stamp) => ledger.carried(stamp)), [true, false, false, true]);
    assert.equal(a.runner.read(RoadmapScopes.account, (read) => carryLedgerOf(read, 't_00000000000000ff')).to, null);
    const discarded = committed(await a.runner.runAct(new DiscardKept(OLD, first.kept[0].id)));
    assert.equal(discarded.result, true);
    assert.deepEqual(a.runner.read(RoadmapScopes.account, (read) => carryLedgerOf(read, OLD)).json, { ...ledger.json, kept: [] });
    const again = await a.runner.runAct(new DiscardKept(OLD, first.kept[0].id));
    assert.deepEqual([again.kind, again.result], ['unchanged', false]);
    committed(await a.runner.runAct(new RecordCarry(OLD, new CarryLedger({ to: OLD, created: false }))));
    assert.equal(a.runner.read(RoadmapScopes.account, (read) => carryLedgerOf(read, OLD)).created, false, 'an entry that names the roadmap says whether the carry-over made it');
  } finally {
    a.close();
  }
});

test('a workspace item stands within the bounds of its type’s fields, and one past any of them does not', () => {
  assert.deepEqual([
    withinBounds('subtask', { label: 'Check the forecast', done: true }),
    withinBounds('subtask', { label: 'x'.repeat(201), done: false }),
    withinBounds('subtask', { label: '   ', done: false }),
    withinBounds('stepLink', { url: 'https://example.org', title: 'Tides' }),
    withinBounds('stepLink', { url: '', title: 'Tides' }),
    withinBounds('stepLink', { url: 'https://example.org', title: 't'.repeat(201) }),
    withinBounds('stepNote', { text: 'n'.repeat(16000) }),
    withinBounds('stepNote', { text: 'n'.repeat(16001) }),
  ], [true, false, false, true, false, false, true, false]);
});

// The notice of a carried roadmap's creation the server refused, as the engine folds it (engine §7.7): the creation, then
// each later entry's dependent part. Signed out, the person asked Coach about the roadmap, and Coach answered and proposed
// a change; in a conversation about every roadmap the device draws, Coach proposed another change to it.
function refusedCreation(from, everyRoadmap) {
  const at = (ms) => `${ms}:0:r_aaaaaaaaaaaa`;
  const made = (t, id, f, ms) => ({ t, id, born: at(ms), life: ['alive', at(ms)], f: Object.fromEntries(Object.entries(f).map(([name, value]) => [name, [value, at(ms)]])) });
  const changed = (t, id, f, ms) => ({ t, id, f: Object.fromEntries(Object.entries(f).map(([name, value]) => [name, [value, at(ms)]])) });
  const replica = 'rp_0000000000000000000000000000000a';
  return {
    id: 'notice:g1/0', scope: RoadmapScopes.account, code: 'id-taken', at: 6000,
    content: {
      d: [made('tree', from, {}, 5000)],
      dependents: [
        { scope: RoadmapScopes.tree(from), d: [made('node', 'wind', { label: 'Read the wind', ord: 'a0' }, 5000)] },
        { d: [made('coachThread', 'thread0001', { treeId: from, stepId: null, title: 'Where do I start?' }, 5001),
          made('coachMessage', 'message0001', { threadId: 'thread0001', role: 'person', text: 'Where do I start?', at: 5001 }, 5001),
          made('coachMessage', 'message0002', { threadId: 'thread0001', role: 'coach', replica, at: 5001, text: '', state: 'running', truncated: false, refusal: null }, 5001)] },
        { d: [changed('coachMessage', 'message0002', { state: 'completed', text: 'Read the wind.' }, 5002)] },
        { d: [made('coachProposal', 'proposal0001', { treeId: from, threadId: 'thread0001', messageId: 'message0002', changes: [{ op: 'rename', nodeId: 'wind', label: 'Read the wind well' }],
          base: [], state: 'pending', undone: false }, 5003), changed('coachMessage', 'message0002', { proposalId: 'proposal0001' }, 5003)] },
        { d: [made('coachProposal', 'proposal0002', { treeId: from, threadId: everyRoadmap.thread, messageId: everyRoadmap.coach, changes: [{ op: 'add', label: 'Tie a bowline' }], base: [],
          state: 'pending', undone: false }, 5004),
          changed('coachMessage', everyRoadmap.coach, { proposalId: 'proposal0002' }, 5004)] },
      ],
    },
  };
}

test('the Coach records a refused creation’s notice holds are read by the last values it holds of each, in the order a write makes them, and nothing of the roadmap’s own', () => {
  const carried = CarriedConversations.of(refusedCreation(OLD, { thread: 'thread0000', coach: 'message0000' }), roadmapRegistry);
  assert.deepEqual(carried.records.map(({ type, id, made, values }) => [type.type, id, made, values]), [
    ['coachThread', 'thread0001', true, { treeId: OLD, stepId: null, title: 'Where do I start?' }],
    ['coachMessage', 'message0000', false, { proposalId: 'proposal0002' }],
    ['coachMessage', 'message0001', true, { threadId: 'thread0001', role: 'person', text: 'Where do I start?', at: 5001 }],
    ['coachMessage', 'message0002', true, { threadId: 'thread0001', role: 'coach', replica: 'rp_0000000000000000000000000000000a', at: 5001, text: 'Read the wind.',
      state: 'completed', truncated: false, refusal: null, proposalId: 'proposal0001' }],
    ['coachProposal', 'proposal0001', true, { treeId: OLD, threadId: 'thread0001', messageId: 'message0002', changes: [{ op: 'rename', nodeId: 'wind', label: 'Read the wind well' }],
      base: [], state: 'pending', undone: false }],
    ['coachProposal', 'proposal0002', true, { treeId: OLD, threadId: 'thread0000', messageId: 'message0000', changes: [{ op: 'add', label: 'Tie a bowline' }], base: [], state: 'pending',
      undone: false }],
  ]);
  assert.equal(CarriedConversations.of({ ...refusedCreation(OLD, { thread: 'thread0000', coach: 'message0000' }), content: { d: [] } }, roadmapRegistry).isEmpty, true);
});

test('a refused creation’s Coach records are written again about the roadmap’s new place: those the notice made under their own ids, what it wrote of a message the device draws, once, and another device of the account reads them', async () => {
  const a = await phone();
  try {
    const placed = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail'))).result.tree;
    a.observe(RoadmapScopes.tree(placed));
    const asked = committed(await a.runner.runAct(new OpenTurn({ about: { treeId: null }, question: 'What should I learn?' }))).result;
    const carried = CarriedConversations.of(refusedCreation(OLD, { thread: asked.thread, coach: asked.coach }), roadmapRegistry);
    assert.equal(committed(await a.runner.runAct(new CarryConversations(carried, OLD, placed))).result, 2);
    assert.deepEqual(await a.runner.runAct(new CarryConversations(carried, OLD, placed)), { kind: 'unchanged', result: 0 });
    await a.sync();
    const b = await a.device();
    await b.sync();
    const coach = (device) => ({
      threads: records(device, RoadmapScopes.account, CoachThread).sort((x, y) => x.id.localeCompare(y.id)),
      messages: records(device, RoadmapScopes.account, CoachMessage).map(({ id, f }) => [id, f.threadId, f.role, f.text, f.state ?? null, f.proposalId ?? null])
        .sort(([x], [y]) => x.localeCompare(y)),
      proposals: records(device, RoadmapScopes.account, CoachProposal).map(({ id, f }) => [id, f.treeId, f.threadId, f.messageId, f.state]).sort(([x], [y]) => x.localeCompare(y)),
    });
    const expected = {
      threads: [{ id: asked.thread, f: { treeId: null, stepId: null, title: 'What should I learn?' } }, { id: 'thread0001', f: { treeId: placed, stepId: null, title: 'Where do I start?' } }]
        .sort((x, y) => x.id.localeCompare(y.id)),
      messages: [[asked.person, asked.thread, 'person', 'What should I learn?', null, null], [asked.coach, asked.thread, 'coach', '', 'running', 'proposal0002'],
        ['message0001', 'thread0001', 'person', 'Where do I start?', null, null], ['message0002', 'thread0001', 'coach', 'Read the wind.', 'completed', 'proposal0001']]
        .sort(([x], [y]) => x.localeCompare(y)),
      proposals: [['proposal0001', placed, 'thread0001', 'message0002', 'pending'], ['proposal0002', placed, asked.thread, asked.coach, 'pending']],
    };
    assert.deepEqual({ here: coach(a), there: coach(b) }, { here: expected, there: expected });
  } finally {
    a.close();
  }
});
