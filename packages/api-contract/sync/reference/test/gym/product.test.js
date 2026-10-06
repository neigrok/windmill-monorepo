import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CommitError, commit } from '../../client/commit.js';
import { onPullResponse, pullRequest } from '../../client/puller.js';
import { Replica } from '../../client/replica.js';
import { drawn } from '../../client/views.js';
import { steadyTiming } from '../../core/clock.js';
import { CONSTANTS } from '../../core/constants.js';
import { ZERO_DIGEST, replaceRow } from '../../core/digest.js';
import { jcs } from '../../core/jcs.js';
import { Registry } from '../../core/registry.js';
import { compareRecords } from '../../core/rows.js';
import { admit } from '../../server/admit.js';
import { pull } from '../../server/pull.js';
import { ServerState } from '../../server/state.js';
import { gymProduct, gymRegistry } from '../../vectors/gym.js';

const load = (file) => JSON.parse(readFileSync(new URL(`../../../corpus/gym/${file}`, import.meta.url), 'utf8'));

test('gym/admit.json replays through admit under gym.registry.json and gym\'s binding', () => {
  for (const { name, input, expect } of load('admit.json')) {
    const outcome = admit({ state: new ServerState(input.state), registry: gymRegistry, product: gymProduct, origin: input.origin, intent: input.intent, serverNow: input.serverNow, limits: CONSTANTS });
    assert.equal(jcs(outcome.result), jcs(expect.result), name);
    assert.equal(jcs(outcome.state.toJSON()), jcs(expect.state), name);
  }
});

test('historical blank names remain readable and repairable while new blank names are refused', () => {
  const vectors = load('admit.json').filter(({ name }) => name.startsWith('historical '));
  assert.equal(vectors.length, 30);
  for (const { name, input, expect } of vectors) {
    const state = new ServerState(input.state);
    const original = state.row('acct:A/gym', 'routine', 'routine0001');
    assert.equal(expect.result.s, name.includes(' refuses ') ? 'refused' : 'ok', name);
    if (expect.result.s === 'refused') {
      assert.equal(expect.result.code, 'invalid', name);
      assert.deepEqual(expect.state, input.state, name);
    }
    const replica = Replica.fresh({ replica: 'rp_00000000000000000000000000000001', state: 'bound', account: 'A' });
    const request = pullRequest(replica, gymRegistry, ['self/gym']);
    const response = pull({ state, registry: gymRegistry, product: gymProduct, account: 'A', request,
      serverNow: input.serverNow, limits: CONSTANTS }).response;
    const rows = response.body.pages.flatMap((page) => page.rows ?? []);
    assert.deepEqual(rows.find((row) => row.t === 'routine'), original, name);
    const proposal = expect.state.rows['acct:A/gym'].find((row) => row.t === 'proposal');
    if (proposal) assert.deepEqual(proposal.f.baseName[0], original.f.name[0], name);
  }
});

test('R118 metadata reflects admitted facts and preserves immutable receipts', () => {
  const rows = (name) => load('admit.json').find((v) => v.name === name).expect.state.rows['acct:A/gym'];
  const row = (name, t, id) => rows(name).find((r) => r.t === t && r.id === id);
  const edited = 'R118 a name and entries edit increments revision once and preserves creation metadata';
  const routine = row(edited, 'routine', 'routine0002');
  assert.deepEqual([routine.f.revision[0], routine.f.createdEntries[0], routine.f.entries[0].length], [2, 2, 1]);
  const death = 'R118 a routine death preserves its independent creation snapshot';
  assert.equal(row(death, 'routine', 'routine0002'), undefined);
  assert.deepEqual(row(death, 'routineCreation', 'routine0002').f.snapshot[0], {
    id: 'routine0002', name: 'Upper', position: 0, revision: 1,
    entries: [{ exerciseId: 'dip', position: 1 }, { exerciseId: 'bench-press', position: 2 }],
  });
  const reordered = row('R118 note reorder advances ru while preserving content time', 'note', 'note0000001');
  assert.equal(reordered.f.updatedAt[0], 1_760_000_000_000);
  assert.equal(reordered.ru, 1_760_036_000_000);
  const changed = row('R118 a note title edit uses server admission time rather than the replica stamp', 'note', 'note0000001');
  assert.equal(changed.f.updatedAt[0], changed.ru);
  const proposal = row('R118 proposal count includes one rename and one reorder with no moved targets', 'proposal', 'proposal003');
  assert.deepEqual([proposal.f.baseRevision[0], proposal.f.baseName[0], proposal.f.changeCount[0]], [7, 'Lower A', 2]);
  const superseded = row('R118 supersession preserves frozen base name revision and count', 'proposal', 'proposal003');
  assert.deepEqual([superseded.f.baseRevision, superseded.f.baseName, superseded.f.changeCount],
    [proposal.f.baseRevision, proposal.f.baseName, proposal.f.changeCount]);
  for (const first of ['routine', 'proposal']) {
    const mixed = row(`R118 mixed intent freezes joined base and supersedes the proposal with ${first} first`, 'proposal', 'proposal003');
    assert.deepEqual([mixed.f.baseRevision[0], mixed.f.baseName[0], mixed.f.changeCount[0], mixed.f.state[0]], [8, 'Renamed', 1, 'superseded']);
  }
});

test('R118 client storage and drawn views retain metadata and refuse authored server fields', () => {
  const vector = load('admit.json').find((v) => v.name === 'R118 a routine death preserves its independent creation snapshot');
  const scope = 'self/gym';
  const replica = new Replica({ meta: Replica.fresh({ replica: 'rp_1', state: 'bound', account: 'A' }).meta,
    confirmed: { [scope]: vector.expect.state.rows['acct:A/gym'] } });
  const restarted = new Replica(replica.toJSON());
  const records = [...drawn(restarted, gymRegistry, scope).values()];
  for (const row of replica.confirmedRows(scope)) assert.deepEqual(records.find((record) => record.t === row.t && record.id === row.id).f, row.f);
  assert.equal(records.find((row) => row.t === 'routineCreation').f.snapshot[0].name, 'Upper');
  const context = { registry: gymRegistry, actor: 'r_aaaaaaaaaaaa', deviceNow: vector.input.serverNow + 1000,
    ended: [], nextGestureId: () => 'g1' };
  const before = restarted.toJSON();
  for (const [t, field, value] of [['routine', 'revision', 9], ['routine', 'createdEntries', 9], ['proposal', 'baseRevision', 9],
    ['proposal', 'baseName', 'Forged'], ['proposal', 'changeCount', 9], ['note', 'updatedAt', 1], ['routineCreation', 'snapshot', {}]]) {
    assert.throws(() => commit(restarted, context, scope, [{ op: 'create', t, id: 'forged0001', f: { [field]: value } }]), CommitError);
    assert.deepEqual(restarted.toJSON(), before);
  }
});

test('R118 metadata the server writes converges a v4 store through ordinary live pulls with unknown fields and types', () => {
  const metadata = { routine: ['revision', 'createdEntries'], proposal: ['baseRevision', 'baseName', 'changeCount'], note: ['updatedAt'] };
  const json = JSON.parse(readFileSync(new URL('../../../gym.registry.json', import.meta.url), 'utf8'));
  json.version = json.minVersion = 4;
  json.types = json.types.filter((type) => type.type !== 'routineCreation');
  for (const [t, fields] of Object.entries(metadata)) {
    for (const field of fields) delete json.types.find((type) => type.type === t).fields[field];
  }
  const v4 = new Registry(json);
  const key = 'acct:A/gym';
  const limits = { ...CONSTANTS, PULL_PAGE_BYTES: 1 << 30 };
  const delivered = new Set();
  const writes = load('admit.json').filter((v) => v.name.startsWith('R118') && v.expect.result.s === 'ok' && jcs(v.expect.state) !== jcs(v.input.state));
  for (const { name, input, expect } of writes) {
    const before = new ServerState(input.state);
    const after = new ServerState(expect.state);
    const now = input.serverNow;
    const ctx = { registry: v4, actor: 'r_aaaaaaaaaaaa', deviceNow: now, limits: CONSTANTS, ended: [], telemetry: [], appVersion: 'v4' };
    let replica = Replica.fresh({ replica: 'rp_00000000000000000000000000000001', state: 'bound', account: 'A' });
    const boot = pullRequest(replica, v4, ['self/gym']);
    onPullResponse(replica, ctx, boot, pull({ state: before, registry: gymRegistry, product: gymProduct, account: 'A', request: boot, serverNow: now, limits }).response, steadyTiming(now, now));
    const cursor = replica.cursorOf('self/gym').cursor;
    const request = pullRequest(replica, v4, ['self/gym']);
    assert.equal(request.scopes[0].cursor, cursor, name);
    const live = pull({ state: after, registry: gymRegistry, product: gymProduct, account: 'A', request, serverNow: now, limits });
    const [page] = live.response.body.pages;
    assert.equal(page.kind, 'rows', name);
    assert.ok(page.rows.every((row) => row.seq > before.scope(key).seq), name);
    for (const row of page.rows) {
      if (row.t === 'routineCreation') delivered.add('routineCreation');
      for (const field of metadata[row.t] ?? []) if (row.f?.[field]) delivered.add(`${row.t}.${field}`);
    }
    onPullResponse(replica, ctx, request, live.response, steadyTiming(now, now));
    replica = new Replica(replica.toJSON());
    assert.deepEqual(replica.confirmedRows('self/gym'), after.rowsOf(key).sort(compareRecords), name);
    assert.equal(replica.cursorOf('self/gym').digest, after.scope(key).digest, name);
    assert.equal(replica.meta.serverEpoch, before.epoch, name);
    assert.deepEqual(ctx.telemetry, [], name);
  }
  assert.deepEqual([...delivered].sort(), ['note.updatedAt', 'proposal.baseName', 'proposal.baseRevision', 'proposal.changeCount',
    'routine.createdEntries', 'routine.revision', 'routineCreation']);
});

test('gym.start treats prototype names as ids and stores own receipts through restart', () => {
  for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const input = load('admit.json').find((v) => v.input.intent.cmd?.name === 'gym.start' && v.expect.result.s === 'ok').input;
    input.intent.cmd.args.id = id;
    const first = admit({ ...input, state: new ServerState(input.state), registry: gymRegistry, product: gymProduct });
    assert.equal(first.result.s, 'ok', id);
    assert.ok(first.result.write.some((w) => w.id === id), id);
    const key = 'acct:A/gym';
    assert.equal(Object.hasOwn(first.state.product.starts[key], id), true, id);
    const again = admit({ ...input, state: new ServerState(first.state.toJSON()), registry: gymRegistry, product: gymProduct });
    assert.equal(again.result.s, 'ok', id);
    assert.deepEqual(again.state.toJSON(), first.state.toJSON(), id);
  }
});

for (const [name, arg, ledger] of [['gym.importSession', 'id', 'imports'], ['gym.correctSession', 'requestId', 'corrections']]) {
  test(`${name} __proto__ receipts survive restart and pin payloads`, () => {
    const input = load('admit.json').find((v) => v.input.intent.cmd?.name === name && v.expect.result.s === 'ok').input;
    input.intent.cmd.args[arg] = '__proto__';
    const first = admit({ ...input, state: new ServerState(input.state), registry: gymRegistry, product: gymProduct });
    assert.equal(first.result.s, 'ok', name);
    assert.equal(Object.hasOwn(first.state.product[ledger]['acct:A/gym'], '__proto__'), true, name);
    const again = admit({ ...input, state: new ServerState(first.state.toJSON()), registry: gymRegistry, product: gymProduct });
    assert.equal(again.result.s, 'ok', name);
    assert.deepEqual(again.state.toJSON(), first.state.toJSON(), name);
    input.intent.cmd.args.startedAt -= 1;
    assert.equal(admit({ ...input, state: new ServerState(first.state.toJSON()), registry: gymRegistry, product: gymProduct }).result.code, 'payload-conflict', name);
  });
}

test('gym routine metadata retains __proto__ ids as ordinary data', () => {
  const key = 'acct:A/gym';
  const created = load('admit.json').find((v) => v.name === 'a routine created with entries takes revision 1').input;
  created.intent.d[0].id = '__proto__';
  const first = admit({ ...created, state: new ServerState(created.state), registry: gymRegistry, product: gymProduct });
  assert.equal(first.result.s, 'ok');
  assert.equal(first.state.row(key, 'routine', '__proto__').f.revision[0], 1);
  const routine = first.state.row(key, 'routine', '__proto__');
  const renamed = admit({ ...created, origin: { kind: 'server', account: 'A' }, state: first.state,
    intent: { scope: 'self/gym', d: [{ t: 'routine', id: '__proto__', born: routine.born, f: { name: ['Renamed', null] } }] },
    registry: gymRegistry, product: gymProduct });
  assert.equal(renamed.result.s, 'ok');
  assert.equal(renamed.state.row(key, 'routine', '__proto__').f.revision[0], 2);
  assert.equal(renamed.state.row(key, 'routine', '__proto__').f.createdEntries[0], 1);
});

test('gym proposal bases store __proto__ ids in frozen wire registers', () => {
  const key = 'acct:A/gym';
  const proposal = load('admit.json').find((v) => v.input.intent.d?.some((d) => d.t === 'proposal') && v.expect.result.s === 'ok').input;
  const delta = proposal.intent.d.find((d) => d.t === 'proposal');
  delta.id = '__proto__';
  delta.f.routineId[0] = '__proto__';
  const state = new ServerState(proposal.state);
  const routine = state.row(key, 'routine', 'routine0001');
  state.deleteRow(key, 'routine', 'routine0001');
  state.putRow(key, { ...routine, id: '__proto__' });
  state.scope(key).digest = state.rowsOf(key).reduce((sum, row) => replaceRow(sum, undefined, row), ZERO_DIGEST);
  const next = admit({ ...proposal, state, registry: gymRegistry, product: gymProduct });
  assert.equal(next.result.s, 'ok');
  const row = new ServerState(next.state.toJSON()).row(key, 'proposal', '__proto__');
  assert.deepEqual([row.f.baseRevision[0], row.f.baseName[0], row.f.changeCount[0]], [1, 'Lower A', 1]);
});

test('gym seed overrides require an own seed and support __proto__ seed ids', () => {
  const input = load('admit.json').find((v) => v.name === "renaming a seed writes its exerciseName, whose aliases take the seed's own name").input;
  input.intent.d[0].id = 'constructor';
  assert.equal(admit({ ...input, state: new ServerState(input.state), registry: gymRegistry, product: gymProduct }).result.code, 'invalid');
  input.intent.d[0].id = '__proto__';
  Object.defineProperty(input.state.product.seeds, '__proto__', { value: { name: 'Original' }, enumerable: true });
  const out = admit({ ...input, state: new ServerState(input.state), registry: gymRegistry, product: gymProduct });
  assert.equal(out.result.s, 'ok');
  assert.deepEqual(out.state.row('acct:A/gym', 'exerciseName', '__proto__').f.aliases[0], ['Original']);
});

// C.6's adopted base runs in the registry's type order, which lists each gym type after the types its ref fields and
// key name, so a boot's rows arrive after the records they reference.
test('gym.registry.json lists each type after the types its references name', () => {
  const order = [...gymRegistry.types.keys()];
  for (const type of gymRegistry.types.values()) {
    const named = [type.key?.ref, ...Object.values(type.fields).map((field) => field.ref)].filter((ref) => ref !== undefined && ref !== type.type);
    for (const ref of named) assert.ok(order.indexOf(ref) < order.indexOf(type.type), `${type.type} names ${ref}`);
  }
});
