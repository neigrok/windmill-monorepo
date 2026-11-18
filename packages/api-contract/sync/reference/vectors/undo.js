// K-3 Undo of an act, the client side: the journal an opted act keeps (undo/journal.json). A session runs
// client steps against the reference server, so every response a vector carries is one the server answered.

import assert from 'node:assert/strict';
import { freshMeta } from '../client/replica.js';
import { pull } from '../server/pull.js';
import { push } from '../server/push.js';
import { ServerState } from '../server/state.js';
import { product, productScope, registry, row, serverState, st, treeScope } from './fixtures.js';
import { runSteps, settle, stepsVector } from './steps.js';

export const REPLICA = 'rp_00000000000000000000000000000001';
export const BOARD = 'b_00000001';
export const TREE = `tree/${BOARD}`;
export const CARD = 'cardAAAA0001';

export const target = (scope, t, id, kind, name) => ({ scope, t, id, slot: name === undefined ? { kind } : { kind, name } });

// A bound replica and its server holding one board, one card and the board's tree.
export function world({ rows = {} } = {}) {
  const confirmed = {
    'self/probe': [
      row({ t: 'board', id: BOARD, born: st(1000), life: ['alive', st(1000)], seq: 1 }),
      row({ t: 'card', id: CARD, born: st(1100), life: ['alive', st(1100)], f: { title: ['Old', st(1100)] }, seq: 2 }),
      ...(rows['self/probe'] ?? []),
    ],
    [TREE]: [
      row({ t: 'meta', id: 'meta', f: { title: ['Root', st(1200)] }, seq: 1 }),
      row({ t: 'tag', id: 'oak', born: st(1300), life: ['alive', st(1300)], f: { label: ['Oak', st(1300)] }, seq: 2 }),
      ...(rows[TREE] ?? []),
    ],
  };
  const device = settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed }] });
  const state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), [`tree:${BOARD}`]: treeScope('A', BOARD) },
    rows: { 'acct:A/probe': confirmed['self/probe'], [`tree:${BOARD}`]: confirmed[TREE] },
  }));
  return { device, state };
}

// Client steps paired with the reference server's answers: `push` and `pull` ask the device for its request
// as the steps so far leave it, let the server answer, and append the answer.
export class Session {
  constructor({ device, state }, input = {}) {
    this.device = device;
    this.state = state;
    this.input = input;
    this.steps = [];
    this.serverNow = 6000;
  }

  local(...steps) {
    this.steps.push(...steps);
    return this;
  }

  run() {
    return runSteps({ device: this.device, ...this.input, steps: this.steps });
  }

  last() {
    return this.run().returns.at(-1);
  }

  push({ deviceNow = this.serverNow, dieAfter, answer = (response) => response } = {}) {
    this.steps.push({ op: 'push', deviceNow });
    const request = this.last();
    if (!request) return null;
    this.serverNow += 1000;
    const pushed = push({ state: this.state, registry, product, account: 'A', request, serverNow: this.serverNow });
    this.state = pushed.state;
    const response = answer(structuredClone(pushed.response));
    this.steps.push({ op: 'pushResponse', response, deviceNow, ...(dieAfter === undefined ? {} : { dieAfter }) });
    return response;
  }

  // Pushes until nothing is left to number, each answer applied.
  flush(limit = 8) {
    for (let k = 0; k < limit; k++) if (this.push() === null) return this;
    throw new Error('the session did not flush');
  }

  pull(scopes, { deviceNow = this.serverNow, dieAfter, settle: perSlice } = {}) {
    this.steps.push({ op: 'pull', scopes, deviceNow });
    const request = this.last();
    if (!request) return null;
    this.serverNow += 1000;
    const pulled = pull({ state: this.state, registry, product, account: 'A', request, serverNow: this.serverNow });
    this.state = pulled.state;
    this.steps.push({ op: 'pullResponse', response: pulled.response, deviceNow,
      ...(dieAfter === undefined ? {} : { dieAfter }), ...(perSlice === undefined ? {} : { settle: perSlice }) });
    return pulled.response;
  }

  vector(name) {
    return stepsVector(name, { device: this.device, ...this.input, steps: structuredClone(this.steps) });
  }
}

const cardTitle = target('self/probe', 'card', CARD, 'field', 'title');
const metaTitle = target(TREE, 'meta', 'meta', 'field', 'title');

// One act over the product scope and the tree, opted into Undo with field recipes for both titles.
export function titleAct({ title = 'New', meta = 'Grown', deviceNow = 5000, recipes = true, gestureId } = {}) {
  return {
    op: 'commitAct', deviceNow,
    segments: [
      { scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: CARD, f: { title } }] },
      { scope: TREE, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: meta } }] },
    ],
    opts: {
      ...(gestureId ? { gestureId } : {}),
      ...(recipes ? { undo: { version: 1, segments: [
        { index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: cardTitle }] }] },
        { index: 1, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree', targets: [{ target: metaTitle }] }] },
      ] } } : {}),
    },
  };
}

export const activeOf = (vector) => vector.expect.device.replicas.find((replica) => replica.meta.replica === vector.expect.device.active);
const journalOf = (vector) => activeOf(vector)?.journal;

function capture() {
  const opted = new Session(world()).local(titleAct(), { op: 'view', scope: 'self/probe', withHeld: true }).vector(
    'an opted act runs each segment under its scope\'s capture command and journals the first preimages');
  const [entry0, entry1] = opted.expect.device.replicas[0].outbox;
  assert.deepEqual([entry0.intent.cmd, entry1.intent.cmd], [{ name: 'probe.capture', args: {} }, { name: 'probe.captureTree', args: {} }]);
  assert.deepEqual(journalOf(opted)[0].sourceEntries.map(({ preimages }) => preimages[0].value), ['Old', 'Root']);

  const unset = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: TREE, changes: [{ op: 'create', t: 'tag', id: 'elm', f: { label: 'Elm' } }] },
    { scope: TREE, changes: [{ op: 'update', t: 'tag', id: 'oak', f: { label: 'Pine' } }] }] };
  const elmLabel = target(TREE, 'tag', 'elm', 'field', 'label');
  const withRecipes = (targets) => ({ ...unset, opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restoreTree', record: { scope: TREE, t: 'tag', id: 'elm' } }] },
    { index: 1, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree', targets }] }] } } });
  const needsDefault = new Session(world()).local(
    withRecipes([{ target: elmLabel }]),
    withRecipes([{ target: elmLabel, defaultValue: '' }, { target: target(TREE, 'tag', 'oak', 'field', 'label') }]),
  ).vector('an unset slot takes the recipe\'s explicit default, and without one the act throws before anything changes');
  assert.deepEqual(needsDefault.expect.returns[0], { throws: true });
  assert.deepEqual(journalOf(needsDefault)[0].sourceEntries[1].preimages.map(({ value }) => value), ['', 'Oak']);

  const malformed = [
    ['a product command without scoped effects', { op: 'commitAct', deviceNow: 5000,
      segments: [{ scope: 'self/probe', changes: [], opts: { cmd: { name: 'probe.end', args: { runId: 'runAAAA00001', endedAt: 4000 } } } }],
      opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: cardTitle }] }] }] } } }],
    ['a generic target outside its segment scope', titleAct({ recipes: false }), { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: metaTitle }] }] }] }],
    ['a restore command of another scope kind', titleAct({ recipes: false }), { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree', targets: [{ target: cardTitle }] }] }] }],
    ['born, which no restore writes', titleAct({ recipes: false }), { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: target('self/probe', 'card', CARD, 'born') }] }] }] }],
    ['the life of a record no write brings back', titleAct({ recipes: false }), { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: target('self/probe', 'card', CARD, 'life') }] }] }] }],
    ['a recipe for a segment the act does not have', titleAct({ recipes: false }), { version: 1, segments: [{ index: 2, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: cardTitle }] }] }] }],
    ['a created record that exists before its act', titleAct({ recipes: false }), { version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restore', record: { scope: 'self/probe', t: 'card', id: CARD } }] }] }],
  ].map(([what, act, undo]) => {
    const step = undo ? { ...act, opts: { ...act.opts, undo } } : act;
    const sample = new Session(world()).local(step).vector(`an opted act throws for ${what}`);
    assert.deepEqual(sample.expect.returns, [{ throws: true }], what);
    return sample;
  });

  const quiet = new Session(world()).local(titleAct({ title: 'Old', meta: 'Root' }), titleAct({ title: 'Old' }))
    .vector('a segment that writes nothing leaves no source entry, and an act that writes nothing journals nothing');
  assert.equal(quiet.expect.returns[0], null);
  assert.deepEqual(journalOf(quiet)[0].sourceEntries.map(({ originScope }) => originScope), [TREE]);
  return [opted, needsDefault, ...malformed, quiet];
}

function retention() {
  const acked = new Session(world()).local(titleAct());
  acked.flush();
  acked.pull(['self/probe', TREE]);
  const settled = acked.local({ op: 'view', scope: 'self/probe', withHeld: true })
    .vector('each ACK retains its accepted receipt in the journal before its entry settles and is collected');
  assert.equal(settled.expect.device.replicas[0].outbox, undefined);
  const attempts = journalOf(settled)[0].sourceEntries.map(({ attempts }) => attempts);
  assert.deepEqual(attempts.map((list) => list.map(({ outcome, epoch }) => [outcome, epoch])), [[['ok', 'ep-1']], [['ok', 'ep-1']]]);
  assert.equal(attempts[0][0].acceptedEffects[0].rows[0].slots[0].slot.name, 'title');

  const crash = new Session(world()).local(titleAct());
  crash.push({ dieAfter: 0 });
  crash.push();
  crash.pull(['self/probe'], { dieAfter: 0 });
  const died = crash.vector('a death before the ACK records nothing; the resent entry\'s replayed result is retained, and a death before its settling keeps it');
  const source = journalOf(died)[0].sourceEntries[0];
  assert.equal(source.attempts.length, 1);
  assert.equal(died.expect.device.replicas[0].outbox[0].state, 'acked');

  const refused = new Session(world()).local(titleAct({ title: 'Twelve chars+' }));
  refused.flush();
  const refusal = refused.vector('a refused source keeps its refusal and owns nothing');
  assert.deepEqual(journalOf(refusal)[0].sourceEntries.map(({ attempts }) => attempts.map(({ outcome }) => outcome)), [['refused'], ['ok']]);
  return [settled, died, refusal];
}

function epochs() {
  const replay = new Session(world(), { ids: ['rp_00000000000000000000000000000002'], actors: ['r_cccccccccccc'] }).local(titleAct());
  replay.push();
  const backup = replay.state;
  replay.push();
  replay.pull(['self/probe']);
  replay.state = new ServerState({ ...backup.toJSON(), epoch: 'ep-2' });
  replay.local({ op: 'epochChange', epoch: 'ep-2' });
  replay.flush();
  const restored = replay.vector('an epoch change drops each source\'s other-epoch proof: the requeued source replays into the new epoch, the collected one has none');
  const [collected, requeued] = journalOf(restored)[0].sourceEntries;
  assert.deepEqual(collected.attempts, []);
  assert.deepEqual(requeued.attempts.map(({ epoch }) => epoch), ['ep-2']);

  const changed = new Session(world(), { ids: ['rp_00000000000000000000000000000002'], actors: ['r_cccccccccccc'] }).local(titleAct());
  changed.state = new ServerState({ ...changed.state.toJSON(), epoch: 'ep-2' });
  changed.push();
  const answered = changed.vector('a changed-epoch answer with no older retained acknowledgement keeps the proof it records before the change');
  assert.deepEqual(journalOf(answered)[0].sourceEntries[0].attempts.map(({ epoch }) => epoch), ['ep-2']);
  return [restored, answered];
}

function retire() {
  const deletion = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: TREE, changes: [{ op: 'delete', t: 'tag', id: 'oak' }], opts: { hold: true } }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree', targets: [{ target: target(TREE, 'tag', 'oak', 'life') }] }] }] } } };
  const back = new Session(world()).local(deletion, { op: 'commit', scope: TREE, deviceNow: 5100, changes: [{ op: 'revive', t: 'tag', id: 'oak' }],
    opts: { retire: [{ t: 'tag', id: 'oak' }] } }).vector('a create in a held removal\'s window retires the opted removal, its capture command being the deltas\' own');
  assert.deepEqual(back.expect.returns[1].retired, ['g1']);
  return [back];
}

function release() {
  const sample = new Session(world()).local(titleAct(), { op: 'releaseReversibleAct', actId: 'g1' }, { op: 'releaseReversibleAct', actId: 'g1' })
    .vector('releasing an act removes its journal record, values with it');
  assert.deepEqual(sample.expect.returns.slice(1), [true, false]);
  assert.equal(journalOf(sample), undefined);
  return [sample];
}

function lifecycle() {
  const anon = 'rp_00000000000000000000000000000009';
  const bound = 'rp_00000000000000000000000000000002';
  const device = settle({ active: anon, replicas: [{ meta: freshMeta(anon, 'anon') }] });
  const act = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: 'self/probe', changes: [{ op: 'create', t: 'card', id: CARD, f: { title: 'Anon' } }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restore', record: { scope: 'self/probe', t: 'card', id: CARD } }] }] } } };
  const signIn = (decision) => ({ op: 'signIn', account: 'A', holdsRecords: { probe: true }, decisions: { probe: decision } });
  const added = stepsVector('an Add carries the anonymous journal into the bound replica', { device, ids: [bound], steps: [act, signIn('add')] });
  assert.equal(added.expect.device.replicas[0].journal[0].sourceEntries[0].localId, 'g1/0');
  const discarded = stepsVector('a Discard removes the product\'s whole source entries and their preimages', { device, ids: [bound], steps: [act, signIn('discard')] });
  assert.equal(discarded.expect.device.replicas.some((replica) => replica.journal), false);
  return [added, discarded];
}

export function files() {
  return { 'undo/journal.json': [...capture(), ...retention(), ...epochs(), ...retire(), ...release(), ...lifecycle()] };
}
