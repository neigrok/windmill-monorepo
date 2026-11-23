// K-3 Undo of an act, the client side: the journal an opted act keeps (undo/journal.json). A session runs
// client steps against the reference server, so every response a vector carries is one the server answered.

import assert from 'node:assert/strict';
import { Device, freshMeta } from '../client/replica.js';
import { onPushResponse } from '../client/sender.js';
import { steadyTiming } from '../core/clock.js';
import { CONSTANTS } from '../core/constants.js';
import { pull } from '../server/pull.js';
import { push } from '../server/push.js';
import { ServerState } from '../server/state.js';
import { ACTOR, OTHER, overlayScope, product, productScope, registry, row, serverState, st, treeScope } from './fixtures.js';
import { runSteps, settle, stepsVector } from './steps.js';

export const REPLICA = 'rp_00000000000000000000000000000001';
export const BOARD = 'b_00000001';
export const TREE = `tree/${BOARD}`;
export const CARD = 'cardAAAA0001';

export const target = (scope, t, id, kind, name) => ({ scope, t, id, slot: name === undefined ? { kind } : { kind, name } });

// A bound replica and its server holding one board, one card and the board's tree, and, given its rows, the
// account's overlay of that tree.
export function world({ rows = {}, overlay } = {}) {
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
  if (overlay) confirmed[`self/overlay/${BOARD}`] = overlay;
  const device = settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed }] });
  const state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), [`tree:${BOARD}`]: treeScope('A', BOARD), ...(overlay ? { [`acct:A/overlay/${BOARD}`]: overlayScope('A', BOARD) } : {}) },
    rows: { 'acct:A/probe': confirmed['self/probe'], [`tree:${BOARD}`]: confirmed[TREE], ...(overlay ? { [`acct:A/overlay/${BOARD}`]: overlay } : {}) },
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

  // Intents another replica of the same account pushes meanwhile, each at the server's present.
  elsewhere(...intents) {
    this.serverNow += 1000;
    this.otherN = (this.otherN ?? 0) + intents.length;
    const request = { replica: 'rp_0000000000000000000000000000000b', account: 'A', ackThrough: 0,
      intents: intents.map((intent, k) => ({ n: this.otherN - intents.length + 1 + k, ...intent })) };
    const pushed = push({ state: this.state, registry, product, account: 'A', request, serverNow: this.serverNow });
    assert.ok(pushed.response.body.results.every(({ s }) => s === 'ok'), 'a foreign write lands');
    this.state = pushed.state;
    return this;
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
  const restored = replay.vector('an epoch change drops each source\'s other-epoch proof: the requeued source replays into the new epoch, the collected one\'s history is unavailable');
  const [collected, requeued] = journalOf(restored)[0].sourceEntries;
  assert.deepEqual([collected.attempts, collected.unavailable], [[], true]);
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

const outboxOf = (vector) => activeOf(vector)?.outbox ?? [];
const requestStep = (actId, deviceNow = 9000) => ({ op: 'requestInverse', actId, deviceNow });
const viewStep = (scope) => ({ op: 'view', scope, withHeld: true });
const titleIn = (returned, t, id) => returned.records.find((record) => record.t === t && record.id === id)?.f?.title?.[0];

// A foreign write of the card's fields, as another replica of the account pushes it.
const foreignCard = (session, f, ms) => session.elsewhere({ scope: 'self/probe', d: [{ t: 'card', id: CARD, born: st(1100),
  f: Object.fromEntries(Object.entries(f).map(([name, value]) => [name, [value, st(ms, 0, OTHER)]])) }] });

function settledUndo() {
  const session = new Session(world()).local(titleAct());
  session.flush();
  session.pull(['self/probe', TREE]);
  const at = session.steps.length;
  session.local(requestStep('g1'), viewStep('self/probe'), viewStep(TREE));
  session.flush();
  session.pull(['self/probe', TREE]);
  const sample = session.local({ op: 'readInverseResult', requestId: 'g3' }, viewStep('self/probe'), viewStep(TREE))
    .vector('an Undo after its act settled reserves, projects and restores each field, and settles with what changed');
  const [reserved, cardView, treeView] = sample.expect.returns.slice(at, at + 3);
  assert.deepEqual(reserved, { kind: 'pending', requestId: 'g3', inverseActId: 'g2', localChanged: true });
  assert.deepEqual([titleIn(cardView, 'card', CARD), titleIn(treeView, 'meta', 'meta')], ['Old', 'Root']);
  const [result, cardAfter, treeAfter] = sample.expect.returns.slice(-3);
  assert.deepEqual(result, { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: true, appliedCount: 2, skippedCount: 0 });
  assert.deepEqual([titleIn(cardAfter, 'card', CARD), titleIn(treeAfter, 'meta', 'meta')], ['Old', 'Root']);
  assert.deepEqual(outboxOf(sample), []);
  return [sample];
}

function mixed() {
  const session = new Session(world()).local(titleAct({ meta: 'Thirteen char' }));
  session.push();
  session.local(requestStep('g1'));
  session.flush();
  const sample = session.local({ op: 'readInverseResult', requestId: 'g3' }, viewStep('self/probe'))
    .vector('an Undo requested before every segment settles waits for each source: a refused one owns nothing and its slot settles unnumbered');
  const ended = sample.expect.ended.map(({ localId, event }) => `${localId} ${event}`);
  assert.ok(ended.includes('g2/0 vacate') && ended.includes('g1/1 refuse'), ended.join());
  assert.deepEqual(sample.expect.returns.at(-2), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: true, appliedCount: 1, skippedCount: 0 });
  return [sample];
}

function barrier() {
  const held = { ...titleAct(), segments: titleAct().segments.map((segment) => ({ ...segment, opts: { hold: true } })) };
  const session = new Session(world(), { actors: ['r_cccccccccccc'] }).local(held, { op: 'release', localId: 'g1/0' });
  session.push();
  session.local(requestStep('g1'), { op: 'commit', scope: 'self/probe', deviceNow: 9100, changes: [{ op: 'update', t: 'card', id: CARD, f: { body: 'later' } }] });
  const blocked = session.push();
  assert.equal(blocked, null);
  session.local({ op: 'engineStart' });
  session.flush();
  const sample = session.vector('an inverse slot whose source is still held stops numbering, a restart included, until the source is authoritative');
  const numbered = sample.expect.returns.filter((value) => value?.intents).map(({ intents }) => intents.map(({ cmd }) => cmd?.name ?? 'edit'));
  assert.deepEqual(numbered, [['probe.capture'], ['probe.captureTree'], ['probe.restoreTree'], ['probe.restore'], ['edit']]);
  return [sample];
}

function laterEdit() {
  const session = new Session(world()).local(titleAct());
  session.flush();
  session.local(requestStep('g1'), { op: 'commit', scope: 'self/probe', deviceNow: 9100, changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'Mine' } }] });
  session.flush();
  session.pull(['self/probe']);
  const sample = session.local(viewStep('self/probe')).vector('an edit queued after an Undo wins: the restore\'s ACK reclocks it above the server\'s fresh stamp');
  assert.equal(titleIn(sample.expect.returns.at(-1), 'card', CARD), 'Mine');
  assert.equal(session.state.rows['acct:A/probe'][recordKeyOf('card', CARD)].f.title[0], 'Mine');
  return [sample];
}

const recordKeyOf = (t, id) => JSON.stringify([t, id]);

function aba() {
  const act = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'New', body: 'mine' } }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore',
      targets: [{ target: cardTitle }, { target: target('self/probe', 'card', CARD, 'field', 'body'), defaultValue: '' }] }] }] } } };
  const session = new Session(world()).local(act);
  session.flush();
  foreignCard(session, { title: 'Other' }, 7500);
  foreignCard(session, { title: 'New' }, 8500);
  session.pull(['self/probe']);
  session.local(requestStep('g1'));
  session.flush();
  session.pull(['self/probe']);
  session.local({ op: 'readInverseResult', requestId: 'g3' }, viewStep('self/probe'));
  const undone = session.vector('a field written away and back since its act skips on its own; its sibling restores');
  assert.deepEqual(undone.expect.returns.at(-2), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: true, appliedCount: 1, skippedCount: 1 });
  const record = undone.expect.returns.at(-1).records.find((r) => r.t === 'card');
  assert.deepEqual([record.f.title[0], record.f.body?.[0]], ['New', '']);
  session.local({ op: 'requestInverse', actId: 'g2', deviceNow: 12000 });
  session.flush();
  session.pull(['self/probe']);
  const redone = session.local({ op: 'readInverseResult', requestId: 'g5' }, viewStep('self/probe'))
    .vector('a Redo takes back only what its Undo applied');
  assert.deepEqual(redone.expect.returns.at(-2), { kind: 'settled', requestId: 'g5', inverseActId: 'g4', changed: true, appliedCount: 1, skippedCount: 0 });
  assert.deepEqual(redone.expect.returns.at(-1).records.find((r) => r.t === 'card').f.body[0], 'mine');
  return [undone, redone];
}

function masked() {
  const session = new Session(world()).local(titleAct());
  session.flush();
  session.local({ op: 'commit', scope: 'self/probe', deviceNow: 9000, changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'Thirteen char' } }] },
    requestStep('g1', 9100));
  session.flush();
  session.pull(['self/probe']);
  const sample = session.local({ op: 'readInverseResult', requestId: 'g4' }, viewStep('self/probe'))
    .vector('a candidate a pending local edit masks stays: that edit is refused, and the restore still applies');
  assert.deepEqual(sample.expect.returns.at(-2).appliedCount, 2);
  assert.equal(titleIn(sample.expect.returns.at(-1), 'card', CARD), 'Old');
  return [sample];
}

function epochReplay() {
  const session = new Session(world(), { ids: ['rp_00000000000000000000000000000002'], actors: ['r_cccccccccccc'] }).local(titleAct());
  session.flush();
  session.local(requestStep('g1'));
  session.state = new ServerState({ ...session.state.toJSON(), epoch: 'ep-2' });
  session.flush();
  const sample = session.local({ op: 'readInverseResult', requestId: 'g3' })
    .vector('a materialized inverse replays after an epoch change only through its own entry, every operation skipping the other epoch');
  assert.deepEqual(sample.expect.returns.at(-1), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: false, appliedCount: 0, skippedCount: 2 });
  const sent = sample.expect.returns.filter((value) => value?.intents).flatMap(({ intents }) => intents).filter(({ cmd }) => cmd?.name?.startsWith('probe.restore'));
  assert.ok(sent.every(({ cmd }) => cmd.args.expectedEpoch === 'ep-1'));
  return [sample];
}

function strictCreation() {
  const made = 'cardCCCC0001';
  const act = { op: 'commitAct', deviceNow: 5000, segments: [
    { scope: 'self/probe', changes: [{ op: 'create', t: 'card', id: made, f: { title: 'Made' } }] },
    { scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: made, f: { title: 'Later' } }, { op: 'update', t: 'card', id: CARD, f: { body: 'x' } }] },
  ], opts: { undo: { version: 1, segments: [
    { index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restore', record: { scope: 'self/probe', t: 'card', id: made } }] },
    { index: 1, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: target('self/probe', 'card', CARD, 'field', 'body'), defaultValue: '' }] }] },
  ] } } };
  const run = (foreign) => {
    const session = new Session(world()).local(act);
    session.push();
    if (foreign) session.elsewhere({ scope: 'self/probe', d: [{ t: 'card', id: made, born: st(5000), f: { body: ['theirs', st(7500, 0, OTHER)] } }] });
    session.flush();
    session.local(requestStep('g1'));
    session.flush();
    session.pull(['self/probe']);
    return session.local({ op: 'readInverseResult', requestId: 'g3' }, viewStep('self/probe'));
  };
  const hidden = run(true).vector('a foreign edit between the creation and a later write of the same act breaks the row history: the created record stays, counted skipped');
  assert.deepEqual(hidden.expect.returns.at(-2), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: true, appliedCount: 1, skippedCount: 1 });
  assert.ok(hidden.expect.returns.at(-1).records.some((record) => record.id === made));
  const owned = run(false).vector('a record whose every write since its creation is the act\'s own is deleted by its Undo');
  assert.deepEqual(owned.expect.returns.at(-2).appliedCount, 2);
  assert.ok(!owned.expect.returns.at(-1).records.some((record) => record.id === made));
  return [hidden, owned];
}

function discarded() {
  const anon = 'rp_00000000000000000000000000000009';
  const bound = 'rp_00000000000000000000000000000002';
  const device = settle({ active: anon, replicas: [{ meta: freshMeta(anon, 'anon'), confirmed: { 'self/probe': [
    row({ t: 'card', id: CARD, born: st(1100), life: ['alive', st(1100)], f: { title: ['Old', st(1100)] }, seq: 2 })] } }] });
  const act = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'New' } }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: cardTitle }] }] }] } } };
  const sample = stepsVector('a Discard at sign-in settles a pending inverse skipped and withdraws its values', {
    device, ids: [bound], steps: [act, requestStep('g1'), { op: 'anonCount', replica: anon, product: 'probe' },
      { op: 'signIn', account: 'A', holdsRecords: { probe: true }, decisions: { probe: 'discard' } }],
  });
  assert.deepEqual(sample.expect.returns[2], { card: 1 });
  assert.equal(sample.expect.device.replicas.some((replica) => replica.outbox || replica.journal), false);
  return [sample];
}

// probe.branch as an opted act whose Undo is the product's probe.unbranch, over evidence the engine builds
// from the branch's own receipt.
function productInverse() {
  const child = 'b_00000002';
  const branch = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: 'self/probe', changes: [], opts: {
    cmd: { name: 'probe.branch', args: { parent: BOARD, child, title: 'Branch' } },
    scopedPredict: [{ scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: child }] },
      { scope: TREE, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Branch' } }] },
      { scope: `tree/${child}`, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Branch' } }] }] } }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'command', command: 'probe.unbranch',
      input: { parent: BOARD, child, title: 'Root' },
      evidence: { ownedFields: [metaTitle], unchangedCreatedRecords: [{ scope: 'self/probe', t: 'board', id: child }],
        unchangedCreatedScopes: [`tree/${child}`] } }] }] } } };
  const run = (foreign) => {
    const session = new Session(world()).local(branch);
    session.flush();
    if (foreign) session.elsewhere({ scope: `tree/${child}`, d: [{ t: 'tag', id: 'pine', born: st(7500, 0, OTHER), life: ['alive', st(7500, 0, OTHER)], f: { label: ['Pine', st(7500, 0, OTHER)] } }] });
    session.local(requestStep('g1'));
    session.flush();
    session.pull(['self/probe', TREE]);
    return session.local({ op: 'readInverseResult', requestId: 'g3' }, viewStep('self/probe'), viewStep(TREE));
  };
  const undone = run(false).vector('a product inverse runs over the engine\'s evidence: the created board dies with its tree and the parent takes back its title');
  assert.deepEqual(undone.expect.returns.at(-3), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: true, appliedCount: 1, skippedCount: 0 });
  assert.ok(!undone.expect.returns.at(-2).records.some((record) => record.id === child));
  assert.equal(titleIn(undone.expect.returns.at(-1), 'meta', 'meta'), 'Root');
  const sent = undone.expect.returns.filter((value) => value?.intents).flatMap(({ intents }) => intents).find(({ cmd }) => cmd?.name === 'probe.unbranch');
  assert.deepEqual(sent.cmd.args.evidence.unchangedCreatedScopes, [{ scope: `tree/${child}`, seq: 1 }]);
  const grown = run(true).vector('a product inverse whose created tree grew since skips whole, and nothing changes');
  assert.deepEqual(grown.expect.returns.at(-3), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: false, appliedCount: 0, skippedCount: 1 });
  return [undone, grown];
}

// An explicit replacement of the stored recipes, by source ordinal, as a product's Redo supplies them.
function replacement() {
  const session = new Session(world()).local(titleAct());
  session.flush();
  session.local({ op: 'requestInverse', actId: 'g1', deviceNow: 9000, slots: [{ index: 1, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree', targets: [{ target: metaTitle }] }] }] });
  session.flush();
  session.pull(['self/probe', TREE]);
  const sample = session.local({ op: 'readInverseResult', requestId: 'g3' }, viewStep('self/probe'), viewStep(TREE))
    .vector('explicit inverse slots replace the stored recipes whole: a source they name nothing for restores nothing');
  assert.deepEqual(sample.expect.returns.at(-3).appliedCount, 1);
  assert.deepEqual([titleIn(sample.expect.returns.at(-2), 'card', CARD), titleIn(sample.expect.returns.at(-1), 'meta', 'meta')], ['New', 'Root']);
  const unjournaled = new Session(world()).local(titleAct());
  unjournaled.flush();
  const before = unjournaled.run().device;
  const refused = unjournaled.local({ op: 'requestInverse', actId: 'g1', deviceNow: 9000,
    slots: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: target('self/probe', 'card', CARD, 'field', 'body') }] }] }] })
    .vector('inverse slots that name a target the act never journaled throw malformed and change nothing');
  assert.deepEqual(refused.expect.returns.at(-1), { throws: true });
  assert.deepEqual(refused.expect.device, before);
  return [sample, refused];
}

// A held act cancelled in place leaves a receipt of what disappeared; its Redo writes that back only where the
// version each change now reads still stands, and creates again only what is wholly absent.
function heldRedo() {
  const held = { op: 'commitAct', deviceNow: 5000, segments: [
    { scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'New' } }], opts: { hold: true } },
    { scope: TREE, changes: [{ op: 'create', t: 'tag', id: 'elm', f: { label: 'Elm' } }], opts: { hold: true } },
  ], opts: { undo: { version: 1, segments: [
    { index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: cardTitle }] }] },
    { index: 1, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restoreTree', record: { scope: TREE, t: 'tag', id: 'elm' } }] },
  ] } } };
  const session = new Session(world()).local(held, requestStep('g1'), requestStep('g2', 9500));
  session.flush();
  session.pull(['self/probe', TREE]);
  const redone = session.local({ op: 'readInverseResult', requestId: 'g5' }, viewStep('self/probe'), viewStep(TREE))
    .vector('a Redo of a held cancellation writes back each change against the accepted version it found and creates the record again');
  const cancellation = activeOf(redone).cancellations?.[0] ?? redone.expect.returns[1];
  assert.deepEqual(redone.expect.returns[1], { kind: 'cancelled', requestId: 'g3', inverseActId: 'g2', changed: true });
  assert.deepEqual(redone.expect.returns.at(-3), { kind: 'settled', requestId: 'g5', inverseActId: 'g4', changed: true, appliedCount: 2, skippedCount: 0 });
  assert.equal(titleIn(redone.expect.returns.at(-2), 'card', CARD), 'New');
  assert.ok(redone.expect.returns.at(-1).records.some((record) => record.id === 'elm' && record.f.label[0] === 'Elm'));
  assert.ok(cancellation);

  const first = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'First' } }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: cardTitle }] }] }] } } };
  const second = { ...first, deviceNow: 5100, segments: [{ ...first.segments[0], changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'Second' } }], opts: { hold: true } }] };
  const waited = new Session(world()).local(first, second, requestStep('g2'), requestStep('g3', 9500));
  waited.flush();
  waited.pull(['self/probe']);
  const pending = waited.local({ op: 'readInverseResult', requestId: 'g6' }, viewStep('self/probe'))
    .vector('a Redo whose change now reads a pending entry\'s write waits for that entry\'s accepted version, then binds it');
  assert.deepEqual(pending.expect.returns[2], { kind: 'cancelled', requestId: 'g4', inverseActId: 'g3', changed: true });
  assert.deepEqual(pending.expect.returns.at(-2).appliedCount, 1);
  assert.equal(titleIn(pending.expect.returns.at(-1), 'card', CARD), 'Second');

  const masked = new Session(world()).local(second, { op: 'commit', scope: 'self/probe', deviceNow: 5200, changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'Mine' } }] },
    requestStep('g1'), requestStep('g3', 9500)).vector('a held write a later local edit masks takes nothing out when cancelled, and its Redo restores nothing');
  assert.deepEqual(masked.expect.returns.slice(2), [{ kind: 'cancelled', requestId: 'g4', inverseActId: 'g3', changed: false },
    { kind: 'settled', requestId: 'g6', inverseActId: 'g5', changed: false, appliedCount: 0, skippedCount: 0 }]);
  return [redone, pending, masked];
}

function requests() {
  const held = { ...titleAct(), segments: titleAct().segments.map((segment) => ({ ...segment, opts: { hold: true } })) };
  const cancelled = new Session(world()).local(held, requestStep('g1'), requestStep('g1'), viewStep('self/probe'), { op: 'requestInverse', actId: 'g9' })
    .vector('an act still wholly held is cancelled in place; asking again answers the same request, and an act with no journal is unavailable');
  assert.deepEqual(cancelled.expect.returns.slice(1, 3), [{ kind: 'cancelled', requestId: 'g3', inverseActId: 'g2', changed: true },
    { kind: 'cancelled', requestId: 'g3', inverseActId: 'g2', changed: true }]);
  assert.equal(titleIn(cancelled.expect.returns[3], 'card', CARD), 'Old');
  assert.deepEqual(cancelled.expect.returns[4], { kind: 'unavailable', requestId: null, reason: 'not-reversible' });
  return [cancelled];
}

// probe.adopt answered with the tree's labelled tag renames the proposed tag in a later opted act's queued entry,
// and the journal's target, preimage and receipt follow the same map.
function remapped() {
  const session = new Session(world()).local(
    { op: 'commit', scope: TREE, deviceNow: 5000, changes: [], opts: { cmd: { name: 'probe.adopt', args: { tag: 'pine', label: 'Oak' } },
      predict: [{ op: 'create', t: 'tag', id: 'pine', f: { label: 'Oak' } }] } },
    { op: 'commitAct', deviceNow: 5100, segments: [{ scope: TREE, changes: [{ op: 'update', t: 'tag', id: 'pine', f: { label: 'Fir' } }] }],
      opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree',
        targets: [{ target: target(TREE, 'tag', 'pine', 'field', 'label') }] }] }] } } });
  session.flush();
  const sample = session.vector('a write map renames the record a journaled act names, in its recipe, preimage and receipt');
  const source = journalOf(sample)[0].sourceEntries[0];
  assert.deepEqual([source.recipes[0].targets[0].target.id, source.preimages[0].target.id, source.attempts[0].acceptedEffects[0].rows[0].id], ['oak', 'oak', 'oak']);
  return [sample];
}

// Review findings, each the behaviour an Undo or Redo must keep.
const settledOf = (vector) => vector.expect.returns.filter((value) => value?.kind === 'settled');
const serverValue = (session, key, t, id, read) => read(session.state.rows[key][JSON.stringify([t, id])]);

function redoWritesTheAct() {
  const session = new Session(world()).local(titleAct());
  session.flush();
  session.pull(['self/probe']);
  session.local({ op: 'commit', scope: 'self/probe', deviceNow: 9000, changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'Refused' } }],
    opts: { guard: [{ t: 'card', id: CARD, field: 'body' }] } }, requestStep('g1', 9100));
  session.elsewhere({ scope: 'self/probe', d: [{ t: 'card', id: CARD, born: st(1100), f: { body: ['theirs', st(8800, 0, OTHER)] } }] });
  session.flush();
  session.pull(['self/probe']);
  session.local({ op: 'requestInverse', actId: 'g3', deviceNow: 12000 });
  session.flush();
  session.pull(['self/probe']);
  const sample = session.local({ op: 'readInverseResult', requestId: 'g6' })
    .vector('a Redo writes back the act\'s own value, never a later local edit the server refused');
  assert.equal(serverValue(session, 'acct:A/probe', 'card', CARD, (r) => r.f.title[0]), 'New');
  return [sample];
}

function noErase() {
  const lww = new Session(world()).local({ op: 'commitAct', deviceNow: 5000, segments: [{ scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'Mine' } }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: cardTitle }] }] }] } } });
  lww.elsewhere({ scope: 'self/probe', d: [{ t: 'card', id: CARD, born: st(1100), f: { title: ['Theirs', st(4000, 0, OTHER)] } }] });
  lww.flush();
  lww.local(requestStep('g1'));
  lww.flush();
  const kept = lww.local({ op: 'readInverseResult', requestId: 'g3' })
    .vector('an Undo never erases a write the device had not seen when it acted: the field skips, and the other device\'s write stays under the act\'s');
  assert.deepEqual(kept.expect.returns.at(-1), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: false, appliedCount: 0, skippedCount: 1 });
  assert.equal(serverValue(lww, 'acct:A/probe', 'card', CARD, (r) => r.f.title[0]), 'Mine');

  const overlay = `self/overlay/${BOARD}`;
  const key = `acct:A/overlay/${BOARD}`;
  const mark = row({ t: 'mark', id: 'oak', x: { memo: { text: 'buy milk', rev: 1, merged: false } }, seq: 1 });
  const board = row({ t: 'board', id: BOARD, born: st(1000), life: ['alive', st(1000)], seq: 1 });
  const device = settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed: { 'self/probe': [board], [overlay]: [mark] } }] });
  const state = new ServerState(serverState({ scopes: { 'acct:A/probe': productScope('A'), [`tree:${BOARD}`]: treeScope('A', BOARD), [key]: overlayScope('A', BOARD) },
    rows: { 'acct:A/probe': [board], [key]: [mark] } }));
  const memo = target(overlay, 'mark', 'oak', 'text', 'memo');
  const text = new Session({ device, state }).local({ op: 'commitAct', deviceNow: 5000, segments: [{ scope: overlay, changes: [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'buy milk and eggs' } }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreOverlay', targets: [{ target: memo }] }] }] } } });
  text.elsewhere({ scope: overlay, d: [{ t: 'mark', id: 'oak', x: { memo: { text: 'call mum; buy milk', base: { rev: 1 } } } }] });
  text.flush();
  text.pull([overlay]);
  const merged = serverValue(text, key, 'mark', 'oak', (r) => r.x.memo.text);
  text.local(requestStep('g1'));
  text.flush();
  const textKept = text.local({ op: 'readInverseResult', requestId: 'g3' })
    .vector('an Undo of a text the server merged with another device\'s edit skips, keeping the merged words');
  assert.deepEqual(textKept.expect.returns.at(-1).skippedCount, 1);
  assert.equal(serverValue(text, key, 'mark', 'oak', (r) => r.x.memo.text), merged);
  return [kept, textKept];
}

function cancelledCommand() {
  const child = 'b_00000002';
  const branch = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: 'self/probe', changes: [], opts: { hold: true,
    cmd: { name: 'probe.branch', args: { parent: BOARD, child, title: 'Branch' } },
    scopedPredict: [{ scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: child }] },
      { scope: TREE, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Branch' } }] },
      { scope: `tree/${child}`, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Branch' } }] }] } }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'command', command: 'probe.unbranch', input: { parent: BOARD, child, title: 'Root' },
      evidence: { ownedFields: [metaTitle], unchangedCreatedRecords: [{ scope: 'self/probe', t: 'board', id: child }], unchangedCreatedScopes: [`tree/${child}`] } }] }] } } };
  const slots = [{ index: 0, recipes: [{ kind: 'command', command: 'probe.unbranch', input: { parent: BOARD, child, title: 'Root' },
    evidence: { ownedFields: [], unchangedCreatedRecords: [{ scope: 'self/probe', t: 'board', id: child }], unchangedCreatedScopes: [`tree/${child}`] } }] }];
  const sample = new Session(world()).local(branch, requestStep('g1', 5100), requestStep('g2', 5200), { op: 'requestInverse', actId: 'g2', deviceNow: 5300, slots })
    .vector('a held product command leaves no generic redo: its Redo is unavailable without the product\'s slots, and takes them when given');
  assert.deepEqual(sample.expect.returns[2], { kind: 'unavailable', requestId: null, reason: 'product-redo-required' });
  assert.deepEqual(sample.expect.returns[3], { kind: 'settled', requestId: 'g5', inverseActId: 'g4', changed: false, appliedCount: 0, skippedCount: 1 });
  assert.deepEqual(activeOf(sample).cancellations[0].units, []);
  return [sample];
}

function plainReference() {
  const plain = { op: 'commit', scope: 'self/probe', deviceNow: 5000, changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'First' } }] };
  const held = { op: 'commitAct', deviceNow: 5100, segments: [{ scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'Second' } }], opts: { hold: true } }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: cardTitle }] }] }] } } };
  const session = new Session(world()).local(plain, held, requestStep('g2', 9000), requestStep('g3', 9500));
  session.flush();
  session.pull(['self/probe']);
  const sample = session.local({ op: 'readInverseResult', requestId: 'g6' })
    .vector('a Redo whose change now reads an ordinary pending edit binds that edit\'s accepted write and applies');
  assert.deepEqual(sample.expect.returns.at(-1).appliedCount, 1);
  assert.equal(serverValue(session, 'acct:A/probe', 'card', CARD, (r) => r.f.title[0]), 'Second');
  return [sample];
}

function ownCreation() {
  const act = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: TREE, changes: [{ op: 'create', t: 'tag', id: 'elm', f: { label: 'ActOwn' } }], opts: { hold: true } }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restoreTree', record: { scope: TREE, t: 'tag', id: 'elm' } }] }] } } };
  const later = { op: 'commit', scope: TREE, deviceNow: 5100, changes: [{ op: 'update', t: 'tag', id: 'elm', f: { label: 'LaterEdit' } }] };
  const sample = new Session(world()).local(act, later, requestStep('g1', 5200))
    .vector('a held cancellation keeps the act\'s own creation for its Redo, not a later gesture\'s edit of the record');
  assert.deepEqual(activeOf(sample).cancellations[0].units[0].redoValues, { f: { label: 'ActOwn' } });
  return [sample];
}

function malformedOutcomes() {
  const session = new Session(world()).local(titleAct());
  session.flush();
  session.local(requestStep('g1'), { op: 'commit', scope: 'self/probe', deviceNow: 9100, changes: [{ op: 'update', t: 'card', id: CARD, f: { body: 'later' } }] });
  const strip = (response) => {
    for (const result of response.body.results) if (result.detail?.command?.inverse) delete result.detail.command.inverse;
    return response;
  };
  session.push({ answer: strip });
  session.flush();
  const sample = session.local({ op: 'readInverseResult', requestId: 'g3' })
    .vector('a result whose inverse outcomes are malformed still acknowledges its entry, settles its slot skipped invalid, reports it, and later work goes on');
  assert.deepEqual(sample.expect.telemetry, [{ event: 'sync-push-malformed' }]);
  assert.deepEqual(sample.expect.returns.at(-1), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: true, appliedCount: 1, skippedCount: 1 });
  assert.ok(sample.expect.returns.filter((value) => value?.intents).flatMap(({ intents }) => intents).some(({ cmd }) => cmd === undefined));
  return [sample];
}

// A cancellation's receipt and its request follow their product's work at sign-in: an Add carries them, a
// Discard takes them with that work, values and all.
function cancellationLifecycle() {
  const anon = 'rp_00000000000000000000000000000009';
  const bound = 'rp_00000000000000000000000000000002';
  const device = settle({ active: anon, replicas: [{ meta: freshMeta(anon, 'anon'), confirmed: { 'self/probe': [
    row({ t: 'card', id: CARD, born: st(1100), life: ['alive', st(1100)], f: { title: ['Old', st(1100)] }, seq: 2 })] } }] });
  const held = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: CARD, f: { title: 'Private' } }], opts: { hold: true } }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: cardTitle }] }] }] } } };
  const other = { op: 'commit', scope: 'self/probe', deviceNow: 5100, changes: [{ op: 'update', t: 'card', id: CARD, f: { body: 'kept' } }] };
  const signIn = (decision) => ({ op: 'signIn', account: 'A', holdsRecords: { probe: true }, decisions: { probe: decision } });
  const added = stepsVector('an Add carries a cancellation and its request into the bound replica', {
    device, ids: [bound], steps: [held, requestStep('g1', 5050), other, signIn('add')] });
  assert.equal(activeOf(added).cancellations[0].units[0].redoValue, 'Private');
  assert.equal(activeOf(added).inverses[0].result.kind, 'cancelled');
  const discarded = stepsVector('a Discard takes the product\'s cancellations and requests with its work, keeping none of their values', {
    device, ids: [bound], steps: [held, requestStep('g1', 5050), other, signIn('discard')] });
  assert.equal(JSON.stringify(discarded.expect.device).includes('Private'), false);
  assert.equal(discarded.expect.device.replicas.some((replica) => replica.cancellations || replica.inverses || replica.journal), false);
  return [added, discarded];
}

// A scope that dies keeps none of its values in the journal: its sources there become unavailable, and a request
// keeps no values once settled.
function deadScope() {
  const session = new Session(world()).local(titleAct());
  session.flush();
  session.pull(['self/probe', TREE]);
  session.local(requestStep('g1'));
  session.flush();
  session.elsewhere({ scope: 'self/probe', d: [{ t: 'board', id: BOARD, born: st(1000), life: ['dead', st(9500, 0, OTHER)] }] });
  session.pull(['self/probe', TREE]);
  const sample = session.local({ op: 'readInverseResult', requestId: 'g3' })
    .vector('a tree that dies takes its values out of the journal, and its sources become unavailable');
  const replica = activeOf(sample);
  assert.equal(/"(Root|Grown)"/.test(JSON.stringify([replica.journal, replica.inverses])), false);
  assert.deepEqual(replica.journal.flatMap((act) => act.sourceEntries).filter((source) => source.originScope === TREE)
    .map(({ preimages, written, unavailable }) => ({ preimages, written, unavailable })), [
    { preimages: [], written: [], unavailable: true }, { preimages: [], written: [], unavailable: true }]);
  return [sample];
}

// No product stack outlives its process: engine start keeps only what an unsettled request reads.
function startRelease() {
  const session = new Session(world(), { actors: ['r_cccccccccccc'] }).local(titleAct(), titleAct({ title: 'Newer', meta: 'Taller', deviceNow: 6000 }));
  session.flush();
  session.local(requestStep('g2'), { op: 'engineStart' });
  const sample = session.vector('engine start releases every act no unsettled request reads');
  assert.deepEqual(activeOf(sample).journal.map(({ actId }) => actId), ['g2']);
  return [sample];
}

// A segment named with no recipes runs as a scoped intent and journals its receipts for evidence: a creation in
// two segments proves the tree it created to its Undo only through the second segment's receipt.
function evidenceOnly() {
  const child = 'b_00000002';
  const childTree = `tree/${child}`;
  const unbranch = { kind: 'command', command: 'probe.unbranch', input: { parent: BOARD, child, title: 'Root' },
    evidence: { ownedFields: [], unchangedCreatedRecords: [{ scope: 'self/probe', t: 'board', id: child }], unchangedCreatedScopes: [childTree] } };
  const create = (named) => ({ op: 'commitAct', deviceNow: 5000, segments: [
    { scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: child }] },
    { scope: childTree, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Child' } }] },
  ], opts: { undo: { version: 1, segments: [{ index: 0, recipes: [unbranch] }, ...(named ? [{ index: 1, recipes: [] }] : [])] } } });
  const run = (named) => {
    const session = new Session(world()).local(create(named));
    session.flush();
    session.local(requestStep('g1'));
    session.flush();
    session.pull(['self/probe']);
    return session.local({ op: 'readInverseResult', requestId: 'g3' }, viewStep('self/probe'));
  };
  const proven = run(true).vector('a segment named with no recipes journals its receipts, which prove the tree its act created to the act\'s Undo');
  assert.deepEqual(journalOf(proven)[0].sourceEntries.map(({ originScope, recipes }) => [originScope, recipes.length]), [['self/probe', 1], [childTree, 0]]);
  assert.deepEqual(proven.expect.returns.at(-2), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: true, appliedCount: 1, skippedCount: 0 });
  assert.ok(!proven.expect.returns.at(-1).records.some((record) => record.t === 'board' && record.id === child));
  const unproven = run(false).vector('a created tree another segment of the act wrote is unproven without that segment\'s receipt, and the Undo skips');
  assert.deepEqual(unproven.expect.returns.at(-2), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: false, appliedCount: 0, skippedCount: 1 });
  const bare = new Session(world()).local({ ...titleAct({ recipes: false }), opts: { undo: { version: 1, segments: [{ index: 0, recipes: [] }, { index: 1, recipes: [] }] } } })
    .vector('an act whose Undo names no recipe at all throws malformed before anything changes');
  assert.deepEqual(bare.expect.returns, [{ throws: true }]);
  return [proven, unproven, bare];
}

// A restore that revives a record draws it at once with the values its preimage read, though the replica already
// pulled its death; a Redo of a created record's Undo draws it back the same way.
function revival() {
  const labelOf = (returned, id) => returned.records.find((record) => record.t === 'tag' && record.id === id && record.life?.[0] === 'alive')?.f?.label?.[0] ?? null;
  const remove = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: TREE, changes: [{ op: 'delete', t: 'tag', id: 'oak' }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree', targets: [{ target: target(TREE, 'tag', 'oak', 'life') }] }] }] } } };
  const undone = new Session(world()).local(remove);
  undone.flush();
  undone.pull([TREE]);
  const at = undone.steps.length;
  undone.local(viewStep(TREE), requestStep('g1'), viewStep(TREE));
  const offline = undone.vector('an Undo of a delete whose death the replica already pulled draws the record back at once, with the fields it had');
  const [before, , after] = offline.expect.returns.slice(at);
  assert.deepEqual([labelOf(before, 'oak'), labelOf(after, 'oak')], [null, 'Oak']);

  const create = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: TREE, changes: [{ op: 'create', t: 'tag', id: 'elm', f: { label: 'Elm' } }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restoreTree', record: { scope: TREE, t: 'tag', id: 'elm' } }] }] } } };
  const redone = new Session(world()).local(create);
  redone.flush();
  redone.local(requestStep('g1'));
  redone.flush();
  redone.pull([TREE]);
  const from = redone.steps.length;
  redone.local(viewStep(TREE), requestStep('g2', 9500), viewStep(TREE));
  const redrawn = redone.vector('a Redo of a created record\'s Undo draws the record back at once, with the fields the Undo took away');
  const [gone, , back] = redrawn.expect.returns.slice(from);
  assert.deepEqual([labelOf(gone, 'elm'), labelOf(back, 'elm')], [null, 'Elm']);
  return [offline, redrawn];
}

// A revival of a tag the device knows only by its spent id: its preimages are read over the dead row the spent id
// keeps, so the Undo walks from that row to the revival's receipt and applies. A spent id that keeps no seq, and a
// write another device made before the revival reached the server, leave nothing to walk from, and the Undo skips.
function spentRevival() {
  const oak = { t: 'tag', id: 'oak', born: st(1300) };
  const revive = { op: 'commitAct', deviceNow: 8000, segments: [{ scope: TREE, changes: [{ op: 'revive', t: 'tag', id: 'oak', f: { label: 'Next' } }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree', targets: [
      { target: target(TREE, 'tag', 'oak', 'life'), defaultValue: 'dead' },
      { target: target(TREE, 'tag', 'oak', 'field', 'label'), defaultValue: 'Oak' }] }] }] } } };
  const deletedElsewhere = () => {
    const session = new Session(world());
    session.elsewhere({ scope: TREE, d: [{ ...oak, life: ['dead', st(6500, 0, OTHER)] }] });
    session.pull([TREE]);
    return session;
  };
  const undo = (session) => {
    session.flush();
    session.local(requestStep('g1', session.serverNow));
    session.flush();
    session.pull([TREE]);
    return session.local({ op: 'readInverseResult', requestId: 'g3' }, viewStep(TREE));
  };
  const oakOf = (session) => session.state.rows[`tree:${BOARD}`][JSON.stringify(['tag', 'oak'])];
  const aliveIn = (returned) => returned.records.some((record) => record.t === 'tag' && record.id === 'oak' && record.life?.[0] === 'alive');

  const spent = deletedElsewhere();
  const deathSeq = oakOf(spent).seq;
  const applied = undo(spent.local(revive))
    .vector('an Undo of a revival of a tag the device knew only by its spent id walks from the dead row that id keeps, and the tag dies again with its label back');
  assert.deepEqual(journalOf(applied)[0].sourceEntries[0].preimages.map(({ rowSeq }) => rowSeq), [deathSeq, deathSeq]);
  assert.deepEqual(applied.expect.returns.at(-2), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: true, appliedCount: 2, skippedCount: 0 });
  assert.equal(aliveIn(applied.expect.returns.at(-1)), false);
  assert.deepEqual([oakOf(spent).life[0], oakOf(spent).f.label[0]], ['dead', 'Oak']);

  const pulled = deletedElsewhere();
  const device = pulled.run().device;
  for (const replica of device.replicas) for (const ids of Object.values(replica.spentIds ?? {})) ids.forEach((id) => delete id.seq);
  const withoutSeq = new Session({ device, state: pulled.state });
  withoutSeq.serverNow = pulled.serverNow;
  const unknown = undo(withoutSeq.local(revive))
    .vector('an Undo of a revival from a spent id that keeps no seq skips: nothing proves the revival wrote over the row the server held');
  assert.deepEqual(unknown.expect.returns.at(-2), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: false, appliedCount: 0, skippedCount: 2 });
  assert.equal(aliveIn(unknown.expect.returns.at(-1)), true);

  const raced = deletedElsewhere().local(revive);
  raced.elsewhere({ scope: TREE, d: [{ ...oak, life: ['alive', st(8200, 0, OTHER)], f: { label: ['Theirs', st(8200, 0, OTHER)] } }] });
  const unseen = undo(raced)
    .vector('an Undo of a revival from a spent id skips when another device wrote the tag before the revival reached the server');
  assert.deepEqual(unseen.expect.returns.at(-2), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: false, appliedCount: 0, skippedCount: 2 });
  assert.deepEqual([oakOf(raced).life[0], oakOf(raced).f.label[0]], ['alive', 'Next']);
  return [applied, unknown, unseen];
}

// A write map that redirects a governor moves the journal with the queue: an Undo requested, or a held act
// cancelled, in the tree of a child board the server redirects follows it into the redirected tree.
function redirected() {
  const child = 'b_00000002';
  const owned = 'b_00000009';
  const sprout = { op: 'commit', scope: 'self/probe', deviceNow: 5000, changes: [], opts: {
    cmd: { name: 'probe.sprout', args: { board: BOARD, tag: 'oak', child } },
    predict: [{ op: 'create', t: 'board', id: child, f: { parent: { board: BOARD, tag: 'oak' } } }] } };
  const ownedElsewhere = (session) => session.elsewhere({ scope: 'self/probe', cmd: { name: 'probe.sprout', args: { board: BOARD, tag: 'oak', child: owned } } });

  const titled = { op: 'commitAct', deviceNow: 5100, segments: [{ scope: `tree/${child}`, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Mine' } }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree',
      targets: [{ target: target(`tree/${child}`, 'meta', 'meta', 'field', 'title'), defaultValue: '' }] }] }] } } };
  const undone = ownedElsewhere(new Session(world())).local(sprout, titled, requestStep('g2', 5200));
  undone.flush();
  undone.pull([`tree/${owned}`]);
  const followed = undone.local({ op: 'readInverseResult', requestId: 'g4' })
    .vector('an Undo requested before a write map redirects its act\'s tree follows the act into the redirected tree');
  assert.deepEqual(followed.expect.returns.at(-1), { kind: 'settled', requestId: 'g4', inverseActId: 'g3', changed: true, appliedCount: 1, skippedCount: 0 });
  assert.equal(serverValue(undone, `tree:${owned}`, 'meta', 'meta', (r) => r.f.title[0]), '');
  assert.ok(!JSON.stringify(activeOf(followed).inverses).includes(`tree/${child}`));

  const created = { op: 'commitAct', deviceNow: 5100, segments: [{ scope: `tree/${child}`, changes: [{ op: 'create', t: 'tag', id: 'elm', f: { label: 'Elm' } }], opts: { hold: true } }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restoreTree', record: { scope: `tree/${child}`, t: 'tag', id: 'elm' } }] }] } } };
  const redone = ownedElsewhere(new Session(world())).local(sprout, created, requestStep('g2', 5200));
  redone.flush();
  redone.local(requestStep('g3', 9500));
  redone.flush();
  redone.pull([`tree/${owned}`]);
  const moved = redone.local({ op: 'readInverseResult', requestId: 'g6' })
    .vector('a cancellation of a held act in a tree a write map then redirects keeps its Redo in the redirected tree');
  assert.deepEqual(moved.expect.returns.at(-1), { kind: 'settled', requestId: 'g6', inverseActId: 'g5', changed: true, appliedCount: 1, skippedCount: 0 });
  assert.equal(serverValue(redone, `tree:${owned}`, 'tag', 'elm', (r) => r.f.label[0]), 'Elm');
  assert.ok(!JSON.stringify(activeOf(moved).cancellations).includes(`tree/${child}`));
  return [followed, moved];
}

// A recorded value that holds a typed reference follows the write map like the record that holds it: a mark's
// `opens` (a ref<board>, as roadmap's pointer.opens is a ref<tree>) restored, written back or redone after the
// server redirects the board it names, and a cancelled lap's runId after the server joins its run.
function typedValues() {
  const child = 'b_00000002';
  const owned = 'b_00000009';
  const overlay = `self/overlay/${BOARD}`;
  const key = `acct:A/overlay/${BOARD}`;
  const marked = () => world({ overlay: [row({ t: 'mark', id: 'oak', f: { done: [true, st(1400)], opens: [BOARD, st(1400)] }, seq: 1 })] });
  const sprout = { op: 'commit', scope: 'self/probe', deviceNow: 5000, changes: [], opts: {
    cmd: { name: 'probe.sprout', args: { board: BOARD, tag: 'oak', child } },
    predict: [{ op: 'create', t: 'board', id: child, f: { parent: { board: BOARD, tag: 'oak' } } }] } };
  const opens = (value, deviceNow, opts = {}) => ({ op: 'commitAct', deviceNow, segments: [{ scope: overlay, changes: [{ op: 'write', t: 'mark', id: 'oak', f: { opens: value } }], opts }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreOverlay', targets: [{ target: target(overlay, 'mark', 'oak', 'field', 'opens') }] }] }] } } });
  const session = () => new Session(marked()).elsewhere({ scope: 'self/probe', cmd: { name: 'probe.sprout', args: { board: BOARD, tag: 'oak', child: owned } } });
  const opensOn = (run) => serverValue(run, key, 'mark', 'oak', (r) => r.f.opens[0]);
  const settled = (requestId, inverseActId) => ({ kind: 'settled', requestId, inverseActId, changed: true, appliedCount: 1, skippedCount: 0 });

  const restored = (early) => {
    const run = session().local(sprout, opens(child, 5100), opens('b_00000003', 5200));
    if (early) run.local(requestStep('g3', 5300));
    run.flush();
    if (!early) run.local(requestStep('g3', 9000));
    run.flush();
    return run;
  };
  const late = restored(false);
  const preimage = late.local({ op: 'readInverseResult', requestId: 'g5' })
    .vector('an Undo after a write map redirects the board its preimage names restores the redirected id');
  assert.deepEqual(preimage.expect.returns.at(-1), settled('g5', 'g4'));
  assert.equal(opensOn(late), owned);
  const early = restored(true);
  const reserved = early.local({ op: 'readInverseResult', requestId: 'g5' })
    .vector('an Undo reserved before a write map redirects the board its operation names restores the redirected id');
  assert.deepEqual(reserved.expect.returns.at(-1), settled('g5', 'g4'));
  assert.equal(opensOn(early), owned);

  const redone = session().local(sprout, opens(child, 5100));
  redone.flush();
  redone.local(requestStep('g2', 9000));
  redone.flush();
  redone.local(requestStep('g3', 9500));
  redone.flush();
  const written = redone.local({ op: 'readInverseResult', requestId: 'g6' })
    .vector('a Redo after a write map redirects the board its act wrote writes back the redirected id');
  assert.deepEqual(written.expect.returns.at(-1), settled('g6', 'g5'));
  assert.equal(opensOn(redone), owned);

  const cancelled = session().local(sprout, opens(child, 5100, { hold: true }), requestStep('g2', 5200));
  cancelled.flush();
  cancelled.local(requestStep('g3', 9500));
  cancelled.flush();
  const unit = cancelled.local({ op: 'readInverseResult', requestId: 'g6' })
    .vector('a Redo of a held act cancelled before a write map redirects the board it wrote writes the redirected id');
  assert.deepEqual(unit.expect.returns.at(-1), settled('g6', 'g5'));
  assert.equal(opensOn(cancelled), owned);

  const joined = new Session(world()).elsewhere({ scope: 'self/probe', cmd: { name: 'probe.start', args: { id: 'run00009', startedAt: 1500, join: false } } })
    .local({ op: 'commit', scope: 'self/probe', deviceNow: 5000, changes: [], opts: { cmd: { name: 'probe.start', args: { id: 'run00002', startedAt: 5000, join: true } },
      predict: [{ op: 'create', t: 'run', id: 'run00002', f: { startedAt: 5000 } }] } },
    { op: 'commitAct', deviceNow: 5100, segments: [{ scope: 'self/probe', changes: [{ op: 'create', t: 'lap', id: 'lap00001', f: { runId: 'run00002', at: 5100, weight: 40 } }], opts: { hold: true } }],
      opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restore', record: { scope: 'self/probe', t: 'lap', id: 'lap00001' } }] }] } } },
    requestStep('g2', 5200));
  joined.flush();
  joined.local(requestStep('g3', 9500));
  joined.flush();
  const created = joined.local({ op: 'readInverseResult', requestId: 'g6' })
    .vector('a Redo of a held creation cancelled before a write map joins the run it named creates it in the joined run');
  assert.deepEqual(created.expect.returns.at(-1), settled('g6', 'g5'));
  assert.equal(serverValue(joined, 'acct:A/probe', 'lap', 'lap00001', (r) => r.f.runId[0]), 'run00009');
  return [preimage, reserved, written, unit, created];
}

// A tag born by an act whose journal the product releases at once, as roadmap's Add Kind keeps no Undo, then removed
// by an act opted into Undo: the removal's preimage was read over the birth's write, so its Undo walks from the row that
// birth left, whichever pushes the two reach the server in. Another device's write between them still breaks the walk,
// and so does a birth the device wrote as an ordinary entry, whose answer carries no receipt. A preimage steps over
// writes made before its act only, never over an earlier segment of the act itself, and over several in commit order.
// Signed out, a day born and removed and its removal undone comes back once sign-in adds the work and sends it.
function releasedBirth() {
  const elm = { scope: TREE, t: 'tag', id: 'elm' };
  const birth = { op: 'commitAct', deviceNow: 5000, segments: [{ scope: TREE, changes: [{ op: 'create', t: 'tag', id: 'elm', f: { label: 'Elm' } }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restoreTree', record: elm }] }] } } };
  const released = { op: 'releaseReversibleAct', actId: 'g1' };
  const removal = { op: 'commitAct', deviceNow: 5100, segments: [{ scope: TREE, changes: [{ op: 'delete', t: 'tag', id: 'elm' }] }],
    opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree', targets: [{ target: target(TREE, 'tag', 'elm', 'life') }] }] }] } } };
  const undone = (session) => {
    session.flush();
    session.pull([TREE]);
    return session.local({ op: 'readInverseResult', requestId: 'g4' }, viewStep(TREE));
  };
  const elmOf = (session) => session.state.rows[`tree:${BOARD}`][recordKeyOf('tag', 'elm')];
  const labelOf = (returned) => returned.records.find((record) => record.t === 'tag' && record.id === 'elm' && record.life?.[0] === 'alive')?.f?.label?.[0] ?? null;
  const restored = (name, session) => {
    const sample = undone(session).vector(name);
    assert.deepEqual(sample.expect.returns.at(-2), { kind: 'settled', requestId: 'g4', inverseActId: 'g3', changed: true, appliedCount: 1, skippedCount: 0 });
    assert.equal(labelOf(sample.expect.returns.at(-1)), 'Elm');
    assert.deepEqual([elmOf(session).life[0], elmOf(session).f.label[0]], ['alive', 'Elm']);
    return sample;
  };
  const skipped = (name, session) => {
    const sample = undone(session).vector(name);
    assert.deepEqual(sample.expect.returns.at(-2), { kind: 'settled', requestId: 'g4', inverseActId: 'g3', changed: false, appliedCount: 0, skippedCount: 1 });
    assert.equal(labelOf(sample.expect.returns.at(-1)), null);
    assert.equal(elmOf(session).life[0], 'dead');
    return sample;
  };

  const together = new Session(world()).local(birth, released, removal);
  together.flush();
  together.pull([TREE]);
  together.local(requestStep('g2'));
  const unsentBoth = restored('an Undo of a removal brings back a record whose birth, by an act that keeps no journal, was still unsent when it was removed', together);

  const unsent = new Session(world()).local(birth, released, removal, requestStep('g2'), viewStep(TREE));
  const pending = restored('an Undo of a removal asked before the record\'s birth or removal was sent draws it at once and brings it back once both went up', unsent);
  assert.deepEqual(pending.expect.returns[3], { kind: 'pending', requestId: 'g4', inverseActId: 'g3', localChanged: true });
  assert.equal(labelOf(pending.expect.returns[4]), 'Elm');

  const alone = new Session(world()).local(birth, released);
  alone.flush();
  alone.pull([TREE]);
  alone.local(removal, requestStep('g2'));
  const birthAlone = restored('an Undo of a removal brings back a record whose birth went up alone before it was removed', alone);

  const acked = new Session(world()).local(birth, released);
  acked.flush();
  const birthSeq = elmOf(acked).seq;
  acked.local(removal, requestStep('g2'));
  const unpulled = restored('an Undo of a removal brings back a record whose birth the server acknowledged before the device pulled it, the removal\'s preimage read over that birth\'s row', acked);
  assert.deepEqual(journalOf(unpulled).find(({ actId }) => actId === 'g2').sourceEntries[0].preimages.map(({ rowSeq }) => rowSeq), [birthSeq]);

  const apart = new Session(world()).local(birth, released);
  apart.flush();
  apart.pull([TREE]);
  apart.local(removal);
  apart.flush();
  apart.pull([TREE]);
  apart.local(requestStep('g2'));
  const eachAlone = restored('an Undo of a removal brings back a record whose birth and removal each went up alone', apart);

  const raced = new Session(world()).local(birth, released);
  raced.flush();
  raced.elsewhere({ scope: TREE, d: [{ t: 'tag', id: 'elm', born: st(5000), f: { label: ['Theirs', st(7500, 0, OTHER)] } }] });
  raced.local(removal);
  raced.flush();
  raced.local(requestStep('g2'));
  const unseen = skipped('an Undo of a removal skips when another device wrote the record between its birth and its removal', raced);

  const plain = new Session(world()).local({ op: 'commit', scope: TREE, deviceNow: 5000, changes: [{ op: 'create', t: 'tag', id: 'elm', f: { label: 'Elm' } }] }, removal);
  plain.flush();
  plain.pull([TREE]);
  plain.local(requestStep('g2'));
  const ordinary = skipped('an Undo of a removal skips when the record\'s birth was an ordinary entry, whose answer proves nothing of the row it wrote', plain);

  const oak = target(TREE, 'tag', 'oak', 'life');
  const renamedAndRemoved = new Session(world()).local({ op: 'commitAct', deviceNow: 5000, segments: [
    { scope: TREE, changes: [{ op: 'update', t: 'tag', id: 'oak', f: { label: 'Pine' } }] },
    { scope: TREE, changes: [{ op: 'delete', t: 'tag', id: 'oak' }] },
  ], opts: { undo: { version: 1, segments: [{ index: 0, recipes: [] },
    { index: 1, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree', targets: [{ target: oak }] }] }] } } });
  renamedAndRemoved.flush();
  renamedAndRemoved.local(requestStep('g1'));
  renamedAndRemoved.flush();
  renamedAndRemoved.pull([TREE]);
  const ownSegment = renamedAndRemoved.local({ op: 'readInverseResult', requestId: 'g3' })
    .vector('a preimage never steps over an earlier segment of its own act, which the act read it before');
  assert.deepEqual(journalOf(ownSegment)[0].sourceEntries[1].preimages.map(({ rowSeq }) => rowSeq), [2]);
  assert.deepEqual(ownSegment.expect.returns.at(-1), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: true, appliedCount: 1, skippedCount: 0 });

  const anon = 'rp_00000000000000000000000000000009';
  const day = { scope: 'self/probe', t: 'day', id: '2026-11-23' };
  const dayOf = (returned) => returned.records.some((record) => record.t === 'day' && record.id === day.id && record.life?.[0] === 'alive');
  const signedOut = new Session({ device: settle({ active: anon, replicas: [{ meta: freshMeta(anon, 'anon') }] }),
    state: new ServerState(serverState({ scopes: { 'acct:A/probe': productScope('A') }, rows: {} })) }, { ids: ['rp_00000000000000000000000000000002'] }).local(
    { op: 'commitAct', deviceNow: 5000, segments: [{ scope: 'self/probe', changes: [{ op: 'put', t: 'day', id: day.id, f: { score: 7 } }] }],
      opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restore', record: day }] }] } } },
    { op: 'releaseReversibleAct', actId: 'g1' },
    { op: 'commitAct', deviceNow: 5100, segments: [{ scope: 'self/probe', changes: [{ op: 'delete', t: 'day', id: day.id }] }],
      opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: target('self/probe', 'day', day.id, 'life') }] }] }] } } },
    requestStep('g2', 5200), viewStep('self/probe'),
    { op: 'signIn', account: 'A', holdsRecords: { probe: true }, decisions: { probe: 'add' } });
  signedOut.flush();
  signedOut.pull(['self/probe']);
  const added = signedOut.local({ op: 'readInverseResult', requestId: 'g4' }, viewStep('self/probe'))
    .vector('an Undo asked signed out of a removal whose record was born there brings it back once sign-in adds the work and sends it');
  assert.deepEqual(added.expect.returns[3], { kind: 'pending', requestId: 'g4', inverseActId: 'g3', localChanged: true });
  assert.ok(dayOf(added.expect.returns[4]) && dayOf(added.expect.returns.at(-1)));
  assert.deepEqual(added.expect.returns.at(-2), { kind: 'settled', requestId: 'g4', inverseActId: 'g3', changed: true, appliedCount: 1, skippedCount: 0 });
  assert.equal(signedOut.state.rows['acct:A/probe'][recordKeyOf('day', day.id)].life[0], 'alive');

  const renamed = new Session(world()).local(birth, released,
    { op: 'commitAct', deviceNow: 5010, segments: [{ scope: TREE, changes: [{ op: 'update', t: 'tag', id: 'elm', f: { label: 'Elder' } }] }],
      opts: { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree', targets: [{ target: target(TREE, 'tag', 'elm', 'field', 'label') }] }] }] } } },
    { op: 'releaseReversibleAct', actId: 'g2' });
  renamed.flush();
  const renamedSeq = elmOf(renamed).seq;
  renamed.local(removal, requestStep('g3'));
  renamed.flush();
  renamed.pull([TREE]);
  const twoWrites = renamed.local({ op: 'readInverseResult', requestId: 'g5' }, viewStep(TREE))
    .vector('an Undo of a removal walks over two acknowledged own writes of the record in commit order, its birth and then its rename');
  assert.deepEqual(journalOf(twoWrites).find(({ actId }) => actId === 'g3').sourceEntries[0].preimages.map(({ rowSeq }) => rowSeq), [renamedSeq]);
  assert.deepEqual(twoWrites.expect.returns.at(-2), { kind: 'settled', requestId: 'g5', inverseActId: 'g4', changed: true, appliedCount: 1, skippedCount: 0 });
  assert.equal(labelOf(twoWrites.expect.returns.at(-1)), 'Elder');
  return [unsentBoth, pending, birthAlone, unpulled, eachAlone, unseen, ordinary, ownSegment, added, twoWrites];
}

// An act made signed out never read what the account's dormant replica wrote meanwhile, and sign-in's Add numbers the
// act after it: the dormant write reaches the server first. So the Add makes each adopted act give up every target whose
// record the dormant replica holds a write of, an unsent entry, an entry acknowledged but not yet pulled, or a receipt
// its journal keeps, and the act's Undo restores nothing there. The journaled ones close a hole older than the step over
// own writes: the walk took any journaled receipt for a write the act had seen. A waiting Undo counts what it gives up,
// and a write of another record takes nothing away.
function adoptedAct() {
  const id = '2026-11-24';
  const day = { scope: 'self/probe', t: 'day', id };
  const put = (value, deviceNow, undo, dayId = id) => ({ op: 'commitAct', deviceNow,
    segments: [{ scope: 'self/probe', changes: [{ op: 'put', t: 'day', id: dayId, f: { score: value } }] }], ...(undo ? { opts: { undo } } : {}) });
  const created = (dayId = id) => ({ version: 1, segments: [{ index: 0, recipes: [{ kind: 'createdRecord', restoreCommand: 'probe.restore',
    record: { ...day, id: dayId } }] }] });
  const scored = { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore',
    targets: [{ target: target('self/probe', 'day', id, 'field', 'score'), defaultValue: 0 }] }] }] };
  const signOut = { op: 'signOut', choice: 'keep', deviceNow: 5050 };
  const signIn = { op: 'signIn', account: 'A', holdsRecords: { probe: true }, decisions: { probe: 'add' } };
  const anon = { ids: ['rp_00000000000000000000000000000009'] };
  const scoreOf = (session) => session.state.rows['acct:A/probe'][recordKeyOf('day', id)].f.score[0];
  const undone = (session, actId, requestId, name) => {
    session.flush();
    session.pull(['self/probe']);
    session.local(requestStep(actId));
    session.flush();
    session.pull(['self/probe']);
    return session.local({ op: 'readInverseResult', requestId }).vector(name);
  };
  const givenUp = (session, name) => {
    const sample = undone(session, 'g2', 'g4', name);
    assert.deepEqual(sample.expect.returns.at(-1), { kind: 'settled', requestId: 'g4', inverseActId: 'g3', changed: false, appliedCount: 0, skippedCount: 0 });
    const adopted = journalOf(sample).find(({ actId }) => actId === 'g2').sourceEntries[0];
    assert.deepEqual([adopted.recipes, adopted.preimages, adopted.written], [[], [], []]);
    assert.equal(scoreOf(session), 9);
    return sample;
  };

  const released = givenUp(new Session(world(), anon).local(put(3, 5000, created()), { op: 'releaseReversibleAct', actId: 'g1' }, signOut,
    put(9, 5100, scored), signIn), 'an act made signed out gives up at sign-in a target the dormant replica holds an unsent write of, by an act that keeps no journal');
  const journaled = givenUp(new Session(world(), anon).local(put(3, 5000, created()), signOut, put(9, 5100, scored), signIn),
    'an act made signed out gives up at sign-in a target the dormant replica\'s journaled act writes unsent, which the walk once took for a write the act had seen');

  const kept = new Session(world(), anon).local(put(3, 5000, created()));
  kept.flush();
  kept.pull(['self/probe']);
  kept.local(signOut, put(9, 5100, scored), signIn);
  const receipt = givenUp(kept, 'an act made signed out gives up at sign-in a target whose receipt the dormant replica\'s journal keeps');

  const late = new Session(world(), anon).local(put(3, 5000, created()), { op: 'releaseReversibleAct', actId: 'g1' }, { op: 'push', deviceNow: 5010 });
  const request = late.last();
  late.serverNow += 1000;
  const answered = push({ state: late.state, registry, product, account: 'A', request, serverNow: late.serverNow });
  late.state = answered.state;
  const signedOut = new Device(late.local(signOut).run().device);
  const dormant = signedOut.replicas.find((replica) => replica.meta.state === 'dormant');
  onPushResponse(dormant, { registry, ended: [], telemetry: [], events: [], limits: CONSTANTS, actor: ACTOR, deviceNow: 5060 }, request,
    answered.response, steadyTiming(5060, 5060));
  assert.deepEqual(dormant.entries().map(({ state }) => state), ['acked']);
  const answeredLate = new Session({ device: signedOut.toJSON(), state: late.state }).local(put(9, 5100, scored), signIn);
  answeredLate.serverNow = late.serverNow;
  const acked = givenUp(answeredLate, 'an act made signed out gives up at sign-in a target the dormant replica holds a write of acknowledged after sign-out and not yet pulled');

  const alone = new Session(world(), anon).local(signOut, put(9, 5100, scored), signIn);
  const control = undone(alone, 'g1', 'g3', 'an act made signed out keeps at sign-in a target the dormant replica holds no write of, and its Undo restores it');
  assert.deepEqual(control.expect.returns.at(-1), { kind: 'settled', requestId: 'g3', inverseActId: 'g2', changed: true, appliedCount: 1, skippedCount: 0 });
  assert.equal(scoreOf(alone), 0);

  const elsewhere = new Session(world(), anon).local(put(3, 5000, created('2026-11-25'), '2026-11-25'), signOut, put(9, 5100, scored), signIn);
  const other = undone(elsewhere, 'g2', 'g4', 'an act made signed out keeps at sign-in a target when the dormant replica writes only another record');
  assert.deepEqual(other.expect.returns.at(-1), { kind: 'settled', requestId: 'g4', inverseActId: 'g3', changed: true, appliedCount: 1, skippedCount: 0 });
  assert.equal(scoreOf(elsewhere), 0);

  const asked = new Session(world(), anon).local(put(3, 5000, created()), { op: 'releaseReversibleAct', actId: 'g1' }, signOut,
    put(9, 5100, scored), requestStep('g2', 5200), viewStep('self/probe'), signIn, viewStep('self/probe'));
  asked.flush();
  asked.pull(['self/probe']);
  const waiting = asked.local({ op: 'readInverseResult', requestId: 'g4' })
    .vector('an Undo waiting signed out withdraws at sign-in its operation on a target the dormant replica holds a write of, and counts it skipped');
  const scoreIn = (returned) => returned.records.find((record) => record.t === 'day' && record.id === id)?.f?.score?.[0];
  assert.deepEqual([scoreIn(waiting.expect.returns[5]), scoreIn(waiting.expect.returns[7])], [0, 9]);
  assert.deepEqual(waiting.expect.returns.at(-1), { kind: 'settled', requestId: 'g4', inverseActId: 'g3', changed: false, appliedCount: 0, skippedCount: 1 });
  assert.equal(scoreOf(asked), 9);
  return [released, journaled, receipt, acked, control, other, waiting];
}

export function files() {
  return {
    'undo/journal.json': [...capture(), ...retention(), ...epochs(), ...retire(), ...release(), ...lifecycle(), ...remapped(),
      ...cancellationLifecycle(), ...deadScope(), ...startRelease()],
    'undo/restore.json': [...settledUndo(), ...mixed(), ...barrier(), ...laterEdit(), ...aba(), ...masked(), ...epochReplay(), ...strictCreation(), ...productInverse(), ...replacement(), ...requests(), ...heldRedo(), ...discarded(),
      ...redoWritesTheAct(), ...noErase(), ...cancelledCommand(), ...plainReference(), ...ownCreation(), ...malformedOutcomes(), ...evidenceOnly(), ...revival(), ...spentRevival(), ...redirected(), ...typedValues(), ...releasedBirth(), ...adoptedAct()],
  };
}
