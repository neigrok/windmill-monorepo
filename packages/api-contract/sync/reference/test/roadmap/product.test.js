import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CONSTANTS } from '../../core/constants.js';
import { jcs } from '../../core/jcs.js';
import { admit } from '../../server/admit.js';
import { ServerState } from '../../server/state.js';
import { runSteps } from '../../vectors/steps.js';
import { roadmapProduct, roadmapRegistry } from '../../vectors/roadmap.js';

const load = (file) => JSON.parse(readFileSync(new URL(`../../../corpus/roadmap/${file}`, import.meta.url), 'utf8'));
const admissions = load('admit.json');
const named = (name) => {
  const found = admissions.find((sample) => sample.name === name);
  assert.ok(found, name);
  return found;
};
const R = 't_0000000000000001';
const S = 't_0000000000000002';
const S2 = 't_0000000000000003';
const H = 't_0000000000000005';
const Y = 't_0000000000000004';
const NEW = 't_00000000000000a1';
const rowOf = (state, key, t, id) => state.rows[key]?.find((row) => row.t === t && jcs(row.id) === jcs(id));
const valueAt = (state, key, t, id, field) => rowOf(state, key, t, id)?.f?.[field]?.[0];
const lifeOf = (state, key, t, id) => rowOf(state, key, t, id)?.life?.[0] ?? (state.spent?.[key]?.some((entry) => entry.t === t && entry.id === id) ? 'spent' : undefined);
const reachOf = (state, tree) => valueAt(state, `tree:${tree}`, 'meta', 'meta', 'reach');

test('roadmap/admit.json replays through admit under roadmap.registry.json and roadmap\'s binding', () => {
  for (const { name, input, expect } of admissions) {
    const outcome = admit({ state: new ServerState(input.state), registry: roadmapRegistry, product: roadmapProduct, origin: input.origin, intent: input.intent, serverNow: input.serverNow, limits: CONSTANTS });
    assert.equal(jcs(outcome.result), jcs(expect.result), name);
    assert.equal(jcs(outcome.state.toJSON()), jcs(expect.state), name);
  }
});

test('roadmap/client.json replays through the client steps under roadmap.registry.json', () => {
  for (const { name, input, expect } of load('client.json')) {
    const { returns, device, ended, telemetry, events } = runSteps(input, roadmapRegistry);
    assert.equal(jcs({ returns, device, ended, ...(telemetry.length ? { telemetry } : {}), ...(events.length ? { events } : {}) }), jcs(expect), name);
  }
});

test('a refusal leaves the state as it was', () => {
  for (const { name, input, expect } of admissions.filter((sample) => sample.expect.result.s === 'refused')) assert.equal(jcs(expect.state), jcs(input.state), name);
});

test('setVisibility reaches every standing subtree of the branch and leaves one that does not stand private', () => {
  const { expect } = named('setVisibility writes the root\'s visibility and reach and the reach of every standing subtree of its branch');
  assert.deepEqual([valueAt(expect.state, `tree:${R}`, 'meta', 'meta', 'visibility'), ...[R, S, S2, H].map((tree) => reachOf(expect.state, tree))],
    ['unlisted', 'unlisted', 'unlisted', 'unlisted', 'private']);
  assert.deepEqual(expect.result.write, []);
  assert.deepEqual(expect.result.detail.windmillKit.effects.map(({ scope, rows }) => [scope, rows.map(({ t, id }) => `${t}/${id}`)]),
    [[`tree/${R}`, ['meta/meta']], ['self/roadmap', []], [`tree/${S}`, ['meta/meta']], [`tree/${S2}`, ['meta/meta']], [`tree/${H}`, []]]);
  const same = named('setVisibility to the visibility the root holds writes nothing');
  assert.equal(same.expect.state.scopes[`tree:${R}`].seq, same.input.state.scopes[`tree:${R}`].seq);
});

test('createSubtree plants the record, the meta, the genesis kinds and the branch, and a retry answers what the step owns', () => {
  const { expect } = named('createSubtree plants a subtree: its record and place, its meta one deeper with the reach above, the genesis kinds and the step\'s branch');
  const stamp = '10000:0:srv';
  assert.deepEqual(rowOf(expect.state, 'acct:A/roadmap', 'tree', NEW).f, { parent: [{ tree: R, step: 'basics' }, stamp] });
  assert.deepEqual(rowOf(expect.state, `tree:${NEW}`, 'meta', 'meta').f, {
    depth: [1, stamp], parent: [{ tree: R, step: 'basics' }, stamp], reach: ['public', stamp], root: [R, stamp],
  });
  assert.deepEqual(expect.state.rows[`tree:${NEW}`].filter((row) => row.t === 'kind').map((row) => [row.id, row.f.hue[0], row.f.label[0], row.f.ord[0]]),
    [['build', 'terracotta', 'Build', 'a0'], ['learn', 'olive', 'Learn', 'a1'], ['milestone', 'gold', 'Milestone', 'a2']]);
  assert.deepEqual(valueAt(expect.state, `tree:${R}`, 'node', 'basics', 'branch'), NEW);
  assert.deepEqual(expect.result.write, [{ t: 'tree', id: NEW, born: stamp, f: { parent: stamp } }]);
  assert.equal(expect.state.scopes[`tree:${NEW}`].governedBy, `acct:A/roadmap#tree#${NEW}`);
  assert.deepEqual(named('createSubtree on a step that owns a subtree answers that subtree').expect.result.write, [{ t: 'tree', id: S, from: NEW, born: '2000:0:srv' }]);
  const revived = named('createSubtree on a deleted step that owns a subtree revives the step, and the subtree stands again').expect.state;
  assert.deepEqual([lifeOf(revived, `tree:${R}`, 'node', 'macros'), reachOf(revived, H)], ['alive', 'public']);
  assert.equal(valueAt(named('createSubtree at depth 7 plants at MAX_DEPTH').expect.state, `tree:${NEW}`, 'meta', 'meta', 'depth'), 8);
});

test('recolourKind recolours every wearer, present or not, revives the kind and no step', () => {
  const { expect } = named('recolourKind writes the kind\'s hue and the colour of every step wearing it, present or not, and revives none');
  assert.deepEqual(['ownership', 'macros', 'basics'].map((id) => [valueAt(expect.state, `tree:${R}`, 'node', id, 'color') ?? null, lifeOf(expect.state, `tree:${R}`, 'node', id)]),
    [['sky', 'alive'], ['sky', 'dead'], [null, 'alive']]);
  assert.equal(valueAt(expect.state, `tree:${R}`, 'kind', 'learn', 'hue'), 'sky');
  const revived = named('recolourKind of a kind deleted elsewhere revives the kind').expect.state;
  assert.deepEqual([lifeOf(revived, `tree:${R}`, 'kind', 'milestone'), valueAt(revived, `tree:${R}`, 'kind', 'milestone', 'hue')], ['alive', 'plum']);
});

test('the inverses hold all or nothing on their evidence', () => {
  const outcome = (name) => named(name).expect.result.detail.command.inverse.outcomes;
  const undone = named('undoCreateSubtree while the connection and the subtree are unchanged kills the subtree and clears the step\'s branch together').expect.state;
  assert.deepEqual([lifeOf(undone, 'acct:A/roadmap', 'tree', NEW), undone.scopes[`tree:${NEW}`].state, valueAt(undone, `tree:${R}`, 'node', 'basics', 'branch')], ['dead', 'dead', null]);
  for (const [name, code] of [['undoCreateSubtree after a step was added in the subtree skips scope-changed', 'scope-changed'],
    ['undoCreateSubtree after the owner marked the subtree skips scope-changed', 'scope-changed'],
    ['undoCreateSubtree after the branch moved skips version-changed', 'version-changed'],
    ['redoCreateSubtree after the step took another subtree skips version-changed', 'version-changed'],
    ['revertVisibility after another write of the visibility skips version-changed', 'version-changed'],
    ['undoCreateRoadmap after the owner marked a step of it skips scope-changed', 'scope-changed']]) {
    assert.deepEqual(outcome(name), [{ index: 0, s: 'skipped', code }], name);
    assert.equal(jcs(named(name).expect.state.rows), jcs(named(name).input.state.rows), name);
  }
  const redone = named('redoCreateSubtree while the Undo\'s branch stands plants a new subtree under a fresh id').expect.state;
  assert.deepEqual([valueAt(redone, `tree:${R}`, 'node', 'basics', 'branch'), lifeOf(redone, 'acct:A/roadmap', 'tree', NEW)], ['t_00000000000000a2', 'dead']);
  const reverted = named('revertVisibility while the act\'s visibility stands takes the root and its standing branch back').expect.state;
  assert.deepEqual([R, S, S2, H].map((tree) => reachOf(reverted, tree)), ['private', 'private', 'private', 'private']);
});

test('a step\'s presence decides the reach of the branch under it, and a root\'s death ends its branch', () => {
  const ended = named('a step\'s death that ends its subtree\'s standing writes reach private on every subtree under it').expect.state;
  assert.deepEqual([S, S2].map((tree) => reachOf(ended, tree)), ['private', 'private']);
  const back = named('the step\'s revival writes the reach above back on the subtrees under it').expect.state;
  assert.deepEqual([S, S2].map((tree) => reachOf(back, tree)), ['public', 'public']);
  const restored = named('an Undo restoring a deleted step writes the reach above back on the subtrees under it').expect;
  assert.deepEqual([restored.result.detail.command, ...[S, S2].map((tree) => reachOf(restored.state, tree))],
    [{ inverse: { outcomes: [{ index: 0, s: 'applied' }] } }, 'public', 'public']);
  const partly = named('a revival leaves private a subtree whose own step is absent').expect.state;
  assert.deepEqual([S, S2].map((tree) => reachOf(partly, tree)), ['public', 'private']);
  const { expect } = named('a root\'s death kills every subtree under it and deletes each step of the owner\'s other roadmaps whose pointer opens it');
  assert.deepEqual([R, S, S2, H, Y].map((tree) => expect.state.scopes[`tree:${tree}`].state), ['dead', 'dead', 'dead', 'dead', 'alive']);
  assert.deepEqual(['rust', 'gone', 'other'].map((id) => lifeOf(expect.state, `tree:${Y}`, 'node', id)), ['dead', 'alive', 'alive']);
  assert.equal(expect.state.scopes[`acct:B/overlay/${R}`].state, 'dead');
});

test('a change to a step or a kind deleted elsewhere lands present', () => {
  for (const [name, t, id] of [['a change to a step deleted elsewhere, made before the delete, is revived by the server', 'node', 'basics'],
    ['a change to a kind deleted elsewhere is revived by the server', 'kind', 'learn']]) {
    const { expect } = named(name);
    assert.deepEqual(rowOf(expect.state, `tree:${R}`, t, id).life, ['alive', '10000:0:srv'], name);
  }
  const owning = named('a change to a step that owns a subtree, deleted elsewhere, revives the step and the subtree stands again').expect.state;
  assert.equal(reachOf(owning, H), 'public');
});

test('the workspace and pointers are the owner\'s, and the owner\'s guide replaces an inherited one', () => {
  for (const t of ['pointer', 'subtask', 'stepLink', 'stepNote']) {
    assert.deepEqual(named(`a ${t} in a reader's overlay is refused forbidden`).expect.result, { s: 'refused', code: 'forbidden' }, t);
  }
  const guide = (name) => valueAt(named(name).expect.state, `tree:${R}`, 'meta', 'meta', 'guideInherited');
  assert.deepEqual(['the owner\'s guide clears guideInherited', 'a title leaves guideInherited', 'a guide older than the inherited one changes nothing',
    'the server\'s door writing a guide it marks inherited keeps guideInherited'].map(guide), [false, true, true, true]);
});

test('Coach\'s conversation takes its messages, their write fates and its proposals with it', () => {
  const { expect } = named('a conversation\'s death kills its messages, their write fates and its proposals, and no other conversation');
  assert.deepEqual(['coachThread/thread0001', 'coachMessage/message0001', 'coachMessage/message0002', 'coachProposal/proposal001', 'coachWriteFate/fate000001', 'coachThread/thread0002']
    .map((key) => lifeOf(expect.state, 'acct:A/roadmap', ...key.split('/'))), ['spent', 'spent', 'spent', 'spent', 'spent', 'alive']);
});
