// E-8 typed references: registry/references.json (registries that declare refPaths, and the values their
// typed leaves admit), admit/references.json (probe.sprout and probe.adopt admitted by the server),
// write/references.json (client steps: dependencies, folds and id maps through typed leaves) and
// refs/traversal.json (the compiled traversal: each holder's resolved identities, and the holder after
// logical maps applied in order).

import assert from 'node:assert/strict';
import { CONSTANTS } from '../core/constants.js';
import { jcs } from '../core/jcs.js';
import { RecordMap } from '../core/references.js';
import { Registry } from '../core/registry.js';
import { checkArgument, checkFieldValue } from '../core/values.js';
import { intentDigest } from '../core/wire.js';
import { freshMeta } from '../client/replica.js';
import { admit } from '../server/admit.js';
import { push } from '../server/push.js';
import { ServerState } from '../server/state.js';
import { product, productScope, registry, row, serverState, st, treeScope, vector } from './fixtures.js';
import { runSteps, settle, stepsVector } from './steps.js';

const B1 = 'b_00000001';
const B3 = 'b_00000003';
const B9 = 'b_00000009';
const CHILD = 'b_00000002';
const GRANDCHILD = 'b_00000004';
const REPLICA = 'rp_00000000000000000000000000000001';
const SRV = (ms) => `${ms}:0:srv`;

// ── registry/references.json ────────────────────────────────────────────────────────────────────────

function miniDocument() {
  const fixed = { kind: 'fixed', value: 'self/p' };
  return {
    registry: 'mini', version: 2, minVersion: 1, products: { p: {}, q: {} },
    types: [
      {
        type: 'board', scope: 'product:p', identity: 'minted', idSpace: 'global', idPattern: '^b_[0-9a-f]{8}$',
        mint: { prefix: 'b_', alphabet: '0123456789abcdef', length: 8 }, life: true, revivable: false, deadRows: 'keep',
        governs: 'tree', origins: ['replica'],
        fields: {
          parent: {
            kind: 'const', writer: 'server',
            domain: { type: 'object', nullable: true, properties: { tree: { type: 'string' }, step: { type: 'string' } }, required: ['tree', 'step'] },
            refPaths: [{ path: ['tree'], type: 'board', scope: fixed }, { path: ['step'], type: 'node', scope: { kind: 'treeFrom', path: ['tree'] } }],
          },
          pin: {
            kind: 'lww', writer: 'client', domain: { type: 'json', nullable: true },
            refPaths: [
              { path: ['at', 'tree'], type: 'board', scope: fixed },
              { path: ['at', 'step'], type: 'node', scope: { kind: 'treeFrom', path: ['at', 'tree'] }, nullable: true },
            ],
          },
        },
      },
      {
        type: 'node', scope: 'tree', identity: 'derived', idSpace: 'scope', idDomain: { type: 'string', unit: 'chars', min: 1, max: 8 },
        derive: { fallback: 'node' }, mint: { prefix: '', alphabet: 'ab', length: 4 }, life: true, revivable: true, deadRows: 'keep',
        origins: ['replica'], fields: { label: { kind: 'lww', writer: 'client' } },
      },
      {
        type: 'pair', scope: 'tree', identity: 'keyed', key: { tuple: [{ name: 'from', ref: 'node' }, { name: 'to', ref: 'node' }] },
        life: true, deadRows: 'keep', origins: ['replica'], fields: {},
      },
      {
        type: 'note', scope: 'overlay', identity: 'keyed', key: { ref: 'node' }, life: false, origins: ['replica'],
        fields: {
          about: {
            kind: 'lww', writer: 'client', domain: { type: 'object', properties: { step: { type: 'string' } } },
            refPaths: [{ path: ['step'], type: 'node', scope: { kind: 'origin' } }],
          },
          memo: { kind: 'text', writer: 'client', unit: 'bytes', max: 40 },
        },
      },
      {
        type: 'day', scope: 'product:p', identity: 'keyed', idPattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', life: true, deadRows: 'spent',
        origins: ['replica'], fields: {},
      },
    ],
    commands: [{
      name: 'p.grow', scope: 'product:p', origins: ['replica'], serverInternal: false,
      args: {
        tree: { type: 'json', optional: true, domain: { type: 'string' } },
        step: { type: 'json', domain: { type: 'string' } },
        child: { type: 'json', domain: { type: 'string' } },
      },
      refPaths: [
        { path: ['tree'], type: 'board', scope: fixed },
        { path: ['step'], type: 'node', scope: { kind: 'treeFrom', path: ['tree'] } },
        { path: ['child'], type: 'board', scope: fixed, role: 'creation' },
      ],
      predicts: ['board'],
    }],
  };
}

// Whether a document loads, and, when a field value or command arguments are given, whether they are
// admitted: the field's whole value check (§6.1 step 2), or the arguments' names, presence, each one's
// check and the command's typed leaves.
function admittedBy(input) {
  let loaded;
  try {
    loaded = new Registry(input.registry);
  } catch {
    return false;
  }
  if (input.field) return checkFieldValue(loaded, loaded.type(input.field.type).field(input.field.name), input.field.value) === null;
  if (input.command) {
    const def = loaded.command(input.command.name);
    const { args } = input.command;
    if (Object.keys(args).some((name) => !Object.hasOwn(def.args, name))) return false;
    for (const [name, arg] of Object.entries(def.args)) {
      if (!Object.hasOwn(args, name)) {
        if (arg.optional) continue;
        return false;
      }
      if (checkArgument(loaded, arg, args[name])) return false;
    }
    return loaded.references.checkArguments(def, args) === null;
  }
  return true;
}

function registryVector(name, input, admitted) {
  const result = vector(name, input, { admitted: admittedBy(input) });
  assert.equal(result.expect.admitted, admitted, name);
  return result;
}

function registryLoads() {
  const board = (r) => r.types[0];
  const parent = (r) => board(r).fields.parent;
  const grow = (r) => r.commands[0];
  const leaf = (r, name) => grow(r).refPaths.find(({ path }) => path.join('.') === name);
  const examples = [
    ['a nested tree and step, a json leaf path and a proposed creation load', () => {}, true],
    ['a scalar ref<board> argument serves as a treeFrom source', (r) => {
      grow(r).args.tree = { type: 'ref<board>' };
      grow(r).refPaths = grow(r).refPaths.filter(({ path }) => path[0] !== 'tree');
    }, true],
    ['an empty path is refused', (r) => { parent(r).refPaths[0].path = []; }, false],
    ['a path holds property names, never an index', (r) => { board(r).fields.pin.refPaths[0].path = ['at', 0]; }, false],
    ['a path runs only through declared object properties', (r) => { parent(r).refPaths[0].path = ['root']; }, false],
    ['a path never runs into a string', (r) => { parent(r).refPaths[0].path = ['tree', 'id']; parent(r).refPaths[1].scope.path = ['tree', 'id']; }, false],
    ['a typed leaf holds a string', (r) => { parent(r).domain.properties.tree = { type: 'number' }; }, false],
    ['an unknown target type is refused', (r) => { parent(r).refPaths[1].type = 'stem'; }, false],
    ['a typed leaf never holds a tuple key', (r) => { parent(r).refPaths[1].type = 'pair'; }, false],
    ['an origin scope from a product scope names no tree type', (r) => { parent(r).refPaths[1].scope = { kind: 'origin' }; }, false],
    ['an origin scope holds kind only', (r) => { r.types[3].fields.about.refPaths[0].scope.value = 'self/p'; }, false],
    ['a fixed scope names a declared product', (r) => { parent(r).refPaths[0].scope.value = 'self/zz'; }, false],
    ['a fixed scope is a product scope reference', (r) => { parent(r).refPaths[0].scope.value = 'tree/b_00000001'; }, false],
    ['a fixed scope holds its target type', (r) => { parent(r).refPaths[0].scope.value = 'self/q'; }, false],
    ['a tree type has no fixed scope', (r) => { parent(r).refPaths[1].scope = { kind: 'fixed', value: 'self/p' }; }, false],
    ['treeFrom names a tree or overlay type', (r) => { parent(r).refPaths[0].scope = { kind: 'treeFrom', path: ['step'] }; }, false],
    ['a treeFrom source is a declared leaf', (r) => { parent(r).refPaths[1].scope.path = ['root']; }, false],
    ['a treeFrom source holds the governing type', (r) => {
      parent(r).domain.properties.near = { type: 'string' };
      parent(r).refPaths.push({ path: ['near'], type: 'node', scope: { kind: 'treeFrom', path: ['step'] } });
    }, false],
    ['two leaves cannot derive their scopes from each other', (r) => {
      parent(r).domain.properties.near = { type: 'string' };
      parent(r).refPaths[1].scope.path = ['near'];
      parent(r).refPaths.push({ path: ['near'], type: 'node', scope: { kind: 'treeFrom', path: ['step'] } });
    }, false],
    ['a proposed creation is no treeFrom source', (r) => { leaf(r, 'step').scope.path = ['child']; }, false],
    ['a leaf is declared once', (r) => { parent(r).refPaths.push(structuredClone(parent(r).refPaths[0])); }, false],
    ['a leaf never sits inside another', (r) => { board(r).fields.pin.refPaths.push({ path: ['at'], type: 'board', scope: { kind: 'fixed', value: 'self/p' } }); }, false],
    ['refPaths reach into json arguments, never a scalar ref argument', (r) => { grow(r).args.child = { type: 'ref<board>' }; }, false],
    ['refPaths name a declared argument', (r) => { leaf(r, 'child').path = ['ghost']; }, false],
    ['a field holds one scalar ref or refPaths', (r) => { parent(r).ref = 'board'; }, false],
    ['refPaths are for an lww, fww or const field', (r) => { r.types[3].fields.memo.refPaths = [{ path: ['step'], type: 'node', scope: { kind: 'origin' } }]; }, false],
    ['only a command argument proposes a creation', (r) => { parent(r).refPaths[0].role = 'creation'; }, false],
    ['a creation names a minted or derived type', (r) => { leaf(r, 'child').type = 'day'; grow(r).predicts.push('day'); }, false],
    ['a creation names a type the command predicts', (r) => { grow(r).predicts = []; }, false],
    ['nullable is true or absent', (r) => { parent(r).refPaths[0].nullable = false; }, false],
    ['role is creation or absent', (r) => { leaf(r, 'tree').role = 'ordinary'; }, false],
    ['a scope kind is origin, fixed or treeFrom', (r) => { parent(r).refPaths[0].scope = { kind: 'global' }; }, false],
    ['refPaths is a nonempty array', (r) => { parent(r).refPaths = []; }, false],
    ['a refPath holds path, type, scope, nullable and role only', (r) => { parent(r).refPaths[0].scopeKey = 'p'; }, false],
  ];
  return examples.map(([name, change, admitted]) => {
    const document = miniDocument();
    change(document);
    return registryVector(name, { registry: document }, admitted);
  });
}

function registryValues() {
  const document = miniDocument();
  const parent = (value) => ({ registry: document, field: { type: 'board', name: 'parent', value } });
  const pin = (value) => ({ registry: document, field: { type: 'board', name: 'pin', value } });
  const grow = (args) => ({ registry: document, command: { name: 'p.grow', args } });
  return [
    ['a nested tree and step', parent({ tree: B1, step: 'oak' }), true],
    ['a step of eight code points is within its domain', parent({ tree: B1, step: '学びの木学びの木' }), true],
    ['a step of nine code points exceeds its domain', parent({ tree: B1, step: '学びの木学びの木学' }), false],
    ['an empty step is no id', parent({ tree: B1, step: '' }), false],
    ['a step holding NUL is no id', parent({ tree: B1, step: 'a\u0000b' }), false],
    ['a tree outside the board pattern', parent({ tree: 'oak', step: 'oak' }), false],
    ['a null outer object names nothing', parent(null), true],
    ['a step that is a number', pin({ at: { tree: B1, step: 7 } }), false],
    ['unannotated JSON beside the typed leaves is not read', pin({ at: { tree: B1, step: 'oak' }, note: { tree: 'not a board', step: 9 } }), true],
    ['a string where the path continues is malformed', pin({ at: B1 }), false],
    ['an array where the path continues is malformed', pin({ at: [B1, 'oak'] }), false],
    ['null where the path continues names nothing', pin({ at: null }), true],
    ['absent leaves name nothing', pin({}), true],
    ['a step without its tree names no tree', pin({ at: { step: 'oak' } }), false],
    ['a null tree is no id', pin({ at: { tree: null, step: 'oak' } }), false],
    ['a nullable step may be null', pin({ at: { tree: B1, step: null } }), true],
    ['a proposed child, a step and its tree', grow({ tree: B1, step: 'oak', child: CHILD }), true],
    ['a step whose optional tree is absent names no tree', grow({ step: 'oak', child: CHILD }), false],
    ['a proposed child outside the board pattern', grow({ tree: B1, step: 'oak', child: 'child-1' }), false],
    ['a step beyond its domain in the arguments', grow({ tree: B1, step: 'abcdefghi', child: CHILD }), false],
  ].map(([name, input, admitted]) => registryVector(name, input, admitted));
}

// ── admit/references.json ───────────────────────────────────────────────────────────────────────────

const NOW = 1_000_000;
const A = { kind: 'replica', account: 'A', replica: 'rp_0000000000000000000000000000000a', n: 1 };
const SERVER_A = { kind: 'server', account: 'A' };

function board(id, seq, parent) {
  return row({ t: 'board', id, born: st(1000), life: ['alive', st(1000)], ...(parent ? { f: { parent: [parent, SRV(1000)] } } : {}), seq });
}

function tag(id, label, seq) {
  return row({ t: 'tag', id, born: st(1000), life: ['alive', st(1000)], f: { label: [label, st(1000)] }, seq });
}

// A's boards b1 and b3, with oak labelled Oak in b1's tree, and b9: the subtree b1's oak owns.
function stepState() {
  return serverState({
    scopes: { 'acct:A/probe': productScope('A'), [`tree:${B1}`]: treeScope('A', B1), [`tree:${B3}`]: treeScope('A', B3), [`tree:${B9}`]: treeScope('A', B9) },
    rows: {
      'acct:A/probe': [board(B1, 1), board(B3, 2), board(B9, 3, { board: B1, tag: 'oak' })],
      [`tree:${B1}`]: [tag('oak', 'Oak', 1)],
      [`tree:${B9}`]: [tag('ash', 'Ash', 1)],
    },
  });
}

function admission(name, { origin = A, intent, state = stepState() }) {
  const outcome = admit({ state: new ServerState(state), registry, product, origin, intent, serverNow: NOW, limits: CONSTANTS });
  return vector(name, { state, origin, intent, serverNow: NOW }, { result: outcome.result, state: outcome.state.toJSON() });
}

function admissions() {
  const sprout = (args) => ({ scope: 'self/probe', cmd: { name: 'probe.sprout', args } });
  const adopt = (tree, args) => ({ scope: `tree/${tree}`, cmd: { name: 'probe.adopt', args } });
  const created = admission('a sprout creates its child board, owned by the step, at the server stamp', { intent: sprout({ board: B1, tag: 'pine', child: CHILD }) });
  assert.equal(created.expect.result.s, 'ok');
  assert.deepEqual(created.expect.result.write, [{ t: 'board', id: CHILD, born: SRV(NOW), f: { parent: SRV(NOW) } }]);
  assert.ok(created.expect.state.scopes[`tree:${CHILD}`]);
  const owned = admission('a sprout of a step that owns a subtree answers that board', { intent: sprout({ board: B1, tag: 'oak', child: CHILD }) });
  assert.deepEqual(owned.expect.result.write, [{ t: 'board', id: B9, from: CHILD, born: st(1000) }]);
  assert.deepEqual(owned.expect.state.rows, stepState().rows);
  const sibling = admission('the same step id in another tree is another step', { intent: sprout({ board: B3, tag: 'oak', child: CHILD }) });
  assert.equal(sibling.expect.result.write[0].from, undefined);
  const absent = admission('a step in an absent tree is admitted: a reference requires no record', { intent: sprout({ board: 'b_0000000a', tag: 'gone', child: CHILD }) });
  assert.equal(absent.expect.result.s, 'ok');
  const taken = admission('a proposed child that exists is id-taken', { intent: sprout({ board: B1, tag: 'pine', child: B3 }) });
  assert.equal(taken.expect.result.code, 'id-taken');
  const refused = [
    ['a step that is a number is refused before any change', { board: B1, tag: 7, child: CHILD }],
    ['a step outside the tag pattern is refused', { board: B1, tag: 'Oak!', child: CHILD }],
    ['an empty step is refused', { board: B1, tag: '', child: CHILD }],
    ['a tree that is no board id is refused', { board: 'oak', tag: 'oak', child: CHILD }],
    ['a proposed child that is no board id is refused', { board: B1, tag: 'oak', child: 'child-1' }],
  ].map(([name, args]) => {
    const sample = admission(name, { intent: sprout(args) });
    assert.equal(sample.expect.result.code, 'invalid', name);
    assert.deepEqual(sample.expect.state, stepState(), name);
    return sample;
  });
  const parentDelta = (parent) => ({ scope: 'self/probe', d: [{ t: 'board', id: CHILD, born: null, life: ['alive', null], f: { parent: [parent, null] } }] });
  const serverWrite = admission('a server create holds a nested parent', { origin: SERVER_A, intent: parentDelta({ board: B1, tag: 'oak' }) });
  assert.equal(serverWrite.expect.result.s, 'ok');
  const nullParent = admission('a null parent names no record', { origin: SERVER_A, intent: parentDelta(null) });
  assert.equal(nullParent.expect.result.s, 'ok');
  const malformed = [
    ['a nested parent whose step breaks the tag pattern is refused before any change', { board: B1, tag: 'Bad Tag' }],
    ['a nested parent whose tree is no board id is refused before any change', { board: 'b_nothex0', tag: 'oak' }],
  ].map(([name, parent]) => {
    const sample = admission(name, { origin: SERVER_A, intent: parentDelta(parent) });
    assert.equal(sample.expect.result.code, 'invalid', name);
    assert.deepEqual(sample.expect.state, stepState(), name);
    return sample;
  });
  const adopted = admission('adopt creates its tag with its label', { intent: adopt(B1, { tag: 'ash', label: 'Ash' }) });
  assert.deepEqual(adopted.expect.result.write, [{ t: 'tag', id: 'ash', born: SRV(NOW), f: { label: SRV(NOW) } }]);
  const joined = admission('adopt answers the tree\'s tag already labelled, a scope-local id map', { intent: adopt(B1, { tag: 'elm', label: 'Oak' }) });
  assert.deepEqual(joined.expect.result.write, [{ t: 'tag', id: 'oak', from: 'elm', born: st(1000) }]);
  const elsewhere = admission('adopt reads only its own tree', { intent: adopt(B3, { tag: 'elm', label: 'Oak' }) });
  assert.deepEqual(elsewhere.expect.result.write, [{ t: 'tag', id: 'elm', born: SRV(NOW), f: { label: SRV(NOW) } }]);
  const adoptTaken = admission('adopt of a taken id is id-taken', { intent: adopt(B1, { tag: 'oak', label: 'Elm' }) });
  assert.equal(adoptTaken.expect.result.code, 'id-taken');
  return [created, owned, sibling, absent, taken, ...refused, serverWrite, nullParent, ...malformed, adopted, joined, elsewhere, adoptTaken];
}

// ── write/references.json ───────────────────────────────────────────────────────────────────────────

function deviceWith(confirmed) {
  return settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed }] });
}

const productRows = () => [board(B1, 1), board(B3, 2)];
const sprout = (args, deviceNow, predicted = args.child) => ({ op: 'commit', scope: 'self/probe', deviceNow, changes: [], opts: {
  cmd: { name: 'probe.sprout', args },
  predict: [{ op: 'create', t: 'board', id: predicted, f: { parent: { board: args.board, tag: args.tag } } }],
} });
const adopt = (tree, args, deviceNow) => ({ op: 'commit', scope: `tree/${tree}`, deviceNow, changes: [], opts: {
  cmd: { name: 'probe.adopt', args }, predict: [{ op: 'create', t: 'tag', id: args.tag, f: { label: args.label } }],
} });
const mark = (tree, id, deviceNow) => ({ op: 'commit', scope: `self/overlay/${tree}`, deviceNow, changes: [{ op: 'write', t: 'mark', id, f: { done: true } }] });

// The server's answer to the pushed entries: the reference server admits the request against `state`.
function served(state, request, serverNow) {
  const pushed = push({ state: new ServerState(state), registry, product, account: 'A', request, serverNow });
  return { response: pushed.response, state: pushed.state.toJSON() };
}

const outboxOf = (sample) => sample.expect.device.replicas[0].outbox;

function redirectedChild() {
  const device = deviceWith({ 'self/probe': productRows(), [`tree/${B1}`]: [tag('oak', 'Oak', 1)] });
  const queued = [
    sprout({ board: B1, tag: 'oak', child: CHILD }, 2000),
    { op: 'commit', scope: `tree/${CHILD}`, deviceNow: 2001, changes: [{ op: 'create', t: 'tag', id: CHILD, f: { label: 'Spelled' } }] },
    sprout({ board: CHILD, tag: CHILD, child: GRANDCHILD }, 2002),
    { op: 'commit', scope: 'self/probe', deviceNow: 2003, changes: [{ op: 'create', t: 'card', id: 'card0001', f: { title: CHILD, attachment: { id: CHILD } } }] },
    { op: 'commit', scope: `tree/${CHILD}`, deviceNow: 2004, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: CHILD } }] },
    { op: 'commit', scope: `self/overlay/${CHILD}`, deviceNow: 2005, changes: [{ op: 'write', t: 'mark', id: CHILD, x: { memo: CHILD } }] },
    { op: 'push', deviceNow: 2006 },
  ];
  const sent = runSteps({ device, steps: queued });
  const request = sent.returns.at(-1);
  assert.deepEqual(request.intents.map(({ cmd }) => cmd?.name), ['probe.sprout']);
  const answer = served(stepState(), request, 3000);
  assert.deepEqual(answer.response.body.results[0].write, [{ t: 'board', id: B9, from: CHILD, born: st(1000) }]);
  const ack = { op: 'pushResponse', deviceNow: 3000, response: answer.response };
  const mapped = stepsVector('a redirected child moves a queued grandchild\'s parent.board and never its parent.tag, a title, JSON or text that spell the id', {
    device, steps: [...queued, ack, { op: 'push', deviceNow: 3001 }],
  });
  const outbox = outboxOf(mapped);
  const before = sent.device.replicas[0].outbox;
  assert.deepEqual(outbox[0].intent, before[0].intent);
  assert.equal(outbox[0].digest, intentDigest(before[0].intent));
  assert.equal(outbox[0].predict[0].id, B9);
  assert.deepEqual(outbox.map(({ scope }) => scope), ['self/probe', `tree/${B9}`, 'self/probe', 'self/probe', `tree/${B9}`, `self/overlay/${B9}`]);
  assert.equal(outbox[1].intent.d[0].id, CHILD);
  assert.deepEqual(outbox[2].intent.cmd.args, { board: B9, tag: CHILD, child: GRANDCHILD });
  assert.deepEqual(outbox[2].predict[0].f.parent[0], { board: B9, tag: CHILD });
  assert.deepEqual(outbox[3].intent.d[0].f.title[0], CHILD);
  assert.deepEqual(outbox[3].intent.d[0].f.attachment[0], { id: CHILD });
  assert.equal(outbox[4].intent.d[0].f.title[0], CHILD);
  assert.deepEqual([outbox[5].intent.d[0].id, outbox[5].intent.d[0].x.memo.text], [CHILD, CHILD]);
  const restarted = stepsVector('a persisted queue holds everything the map needs: the redirect after a restart lands the same', {
    device: sent.device, steps: [ack, { op: 'push', deviceNow: 3001 }],
  });
  assert.deepEqual(restarted.expect.device, mapped.expect.device);
  return [mapped, restarted];
}

function dependencies() {
  const device = deviceWith({ 'self/probe': productRows() });
  const oak = (opts) => ({ op: 'commit', scope: `tree/${B1}`, deviceNow: 2000, changes: [{ op: 'create', t: 'tag', id: 'oak', f: { label: 'Oak' } }], ...(opts ? { opts } : {}) });
  const queued = [sprout({ board: B3, tag: 'oak', child: CHILD }, 2001), sprout({ board: B1, tag: 'oak', child: GRANDCHILD }, 2002)];
  const undone = stepsVector('undoing a held step folds the sprout whose step names it and keeps the same step id in another tree', {
    device, steps: [oak({ hold: true }), ...queued, { op: 'undo', gestureId: 'g1' }, { op: 'push', deviceNow: 2003 }],
  });
  assert.deepEqual(outboxOf(undone).map(({ intent }) => intent.cmd.args.board), [B3]);
  assert.deepEqual(undone.expect.returns.at(-1).intents.map(({ cmd }) => cmd.args.board), [B3]);
  const sent = runSteps({ device, steps: [oak(), ...queued, { op: 'push', deviceNow: 2003 }] });
  assert.deepEqual(sent.returns.at(-1).intents.map(({ scope }) => scope), [`tree/${B1}`, 'self/probe']);
  const refused = stepsVector('refusing a step folds only the sprout that names it in its tree', { device, steps: [oak(), ...queued, { op: 'push', deviceNow: 2003 },
    { op: 'pushResponse', deviceNow: 3000, response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 3000, lastN: 2, results: [
      { n: 1, s: 'refused', code: 'invalid' },
      { n: 2, s: 'ok', seq: 3, write: [{ t: 'board', id: CHILD, born: SRV(3000), f: { parent: SRV(3000) } }] },
    ] } } }, { op: 'push', deviceNow: 3001 }],
  });
  const notice = refused.expect.device.replicas[0].notices[0];
  assert.deepEqual(notice.content.dependents.map(({ cmd }) => cmd.args.board), [B1]);
  assert.deepEqual(outboxOf(refused).map(({ state, intent }) => [state, intent.cmd.args.board]), [['acked', B3]]);
  const proposed = stepsVector('a proposed child depends on no earlier create of its id, and a sprout under it depends on its sprout', {
    device, steps: [
      { op: 'commit', scope: 'self/probe', deviceNow: 2000, changes: [{ op: 'create', t: 'board', id: CHILD }], opts: { hold: true } },
      sprout({ board: B1, tag: 'oak', child: CHILD }, 2001),
      { op: 'undo', gestureId: 'g1' },
      sprout({ board: CHILD, tag: 'pine', child: GRANDCHILD }, 2002),
      { op: 'push', deviceNow: 2003 },
      { op: 'pushResponse', deviceNow: 3000, response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 3000, lastN: 1, results: [
        { n: 1, s: 'refused', code: 'id-taken' },
      ] } } },
    ],
  });
  assert.equal(proposed.expect.returns[4].intents[0].cmd.args.child, CHILD);
  assert.deepEqual(proposed.expect.device.replicas[0].notices[0].content.dependents.map(({ cmd }) => cmd.args.board), [CHILD]);
  assert.equal(outboxOf(proposed), undefined);
  const acked = runSteps({ device, steps: [sprout({ board: B1, tag: 'pine', child: CHILD }, 2000), { op: 'push', deviceNow: 2001 },
    { op: 'pushResponse', deviceNow: 3000, response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 3000, lastN: 1, results: [
      { n: 1, s: 'ok', seq: 3, write: [{ t: 'board', id: CHILD, born: SRV(3000), f: { parent: SRV(3000) } }] },
    ] } } }] }).device;
  delete acked.replicas[0].outbox[0].writeTargets;
  const replayed = stepsVector('epoch replay rebuilds a retained sprout\'s target from its proposed child, not its tree', {
    device: acked, ids: ['rp_00000000000000000000000000000002'], actors: ['r_bbbbbbbbbbbb'], steps: [{ op: 'epochChange', epoch: 'ep-2' }],
  });
  assert.deepEqual(outboxOf(replayed)[0].writeTargets, [{ t: 'board', from: CHILD, id: CHILD, born: SRV(3000) }]);
  const malformed = [
    ['a sprout whose step is not a string throws before any change', sprout({ board: B1, tag: 7, child: CHILD }, 2000)],
    ['a predicted parent without its tree throws before any change', { ...sprout({ board: B1, tag: 'oak', child: CHILD }, 2000), opts: {
      cmd: { name: 'probe.sprout', args: { board: B1, tag: 'oak', child: CHILD } },
      predict: [{ op: 'create', t: 'board', id: CHILD, f: { parent: { tag: 'oak' } } }],
    } }],
    ['a predicted parent naming no board id throws before any change', { ...sprout({ board: B1, tag: 'oak', child: CHILD }, 2000), opts: {
      cmd: { name: 'probe.sprout', args: { board: B1, tag: 'oak', child: CHILD } },
      predict: [{ op: 'create', t: 'board', id: CHILD, f: { parent: { board: 'oak', tag: 'oak' } } }],
    } }],
  ].map(([name, step]) => {
    const sample = stepsVector(name, { device, steps: [step] });
    assert.deepEqual(sample.expect.returns[0], { throws: true }, name);
    assert.deepEqual(sample.expect.device, device, name);
    return sample;
  });
  return [undone, refused, proposed, replayed, ...malformed];
}

function scopedTagMap() {
  const device = deviceWith({ 'self/probe': productRows(), [`tree/${B1}`]: [tag('oak', 'Oak', 1)] });
  const queued = [
    adopt(B1, { tag: 'elm', label: 'Oak' }, 2000),
    mark(B1, 'elm', 2001),
    mark(B3, 'elm', 2002),
    { op: 'commit', scope: `tree/${B1}`, deviceNow: 2003, changes: [{ op: 'put', t: 'link', id: ['elm', 'ash'], present: true, f: { strength: 1 } }] },
    sprout({ board: B1, tag: 'elm', child: CHILD }, 2004),
    sprout({ board: B3, tag: 'elm', child: GRANDCHILD }, 2005),
    { op: 'push', deviceNow: 2006 },
  ];
  const sent = runSteps({ device, steps: queued });
  const answer = served(stepState(), sent.returns.at(-1), 3000);
  assert.deepEqual(answer.response.body.results[0].write, [{ t: 'tag', id: 'oak', from: 'elm', born: st(1000) }]);
  const mapped = stepsVector('a scoped tag map renames every reference into its tree, an overlay mark\'s key included, and never the same id in a sibling tree', {
    device, steps: [...queued, { op: 'pushResponse', deviceNow: 3000, response: answer.response }],
  });
  const outbox = outboxOf(mapped);
  assert.deepEqual(mapped.expect.ended.map(({ localId, outcome }) => [localId, outcome]), [['g1/0', 'resolved']]);
  assert.deepEqual(outbox.map(({ scope, intent }) => [scope, intent.d?.[0].id ?? intent.cmd.args.tag]), [
    [`self/overlay/${B1}`, 'oak'], [`self/overlay/${B3}`, 'elm'], [`tree/${B1}`, ['oak', 'ash']], ['self/probe', 'oak'], ['self/probe', 'elm'],
  ]);
  assert.deepEqual(outbox[3].predict[0].f.parent[0], { board: B1, tag: 'oak' });
  assert.deepEqual(outbox[4].predict[0].f.parent[0], { board: B3, tag: 'elm' });
  return [mapped];
}

function renamedText() {
  const overlay = `self/overlay/${B1}`;
  const memo = (id, text, seq) => row({ t: 'mark', id, x: { memo: { text, rev: seq, merged: false } }, seq });
  const device = deviceWith({ 'self/probe': productRows(), [overlay]: [memo('tag-a', 'old', 1)] });
  const steps = [
    adopt(B1, { tag: 'tag-a', label: 'Ash' }, 2000),
    { op: 'push', deviceNow: 2001 },
    { op: 'commit', scope: overlay, deviceNow: 2002, changes: [{ op: 'write', t: 'mark', id: 'tag-a', x: { memo: 'old!' } }] },
  ];
  const state = serverState({ scopes: { 'acct:A/probe': productScope('A'), [`tree:${B1}`]: treeScope('A', B1) },
    rows: { 'acct:A/probe': productRows(), [`tree:${B1}`]: [tag('tag-b', 'Ash', 1)] } });
  const answer = served(state, runSteps({ device, steps }).returns[1], 3000);
  assert.deepEqual(answer.response.body.results[0].write, [{ t: 'tag', id: 'tag-b', from: 'tag-a', born: st(1000) }]);
  const recovered = stepsVector('a renamed mark key keeps the text it was edited from, which a base-unknown refusal resends', {
    device, steps: [...steps, { op: 'pushResponse', deviceNow: 3000, response: answer.response }, { op: 'push', deviceNow: 3001 },
      { op: 'pushResponse', deviceNow: 3002, response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 3002, lastN: 2,
        results: [{ n: 2, s: 'refused', code: 'base-unknown' }] } } }, { op: 'push', deviceNow: 3003 }],
  });
  assert.deepEqual(recovered.expect.returns[4].intents[0].d[0], { t: 'mark', id: 'tag-b', x: { memo: { text: 'old!', base: { rev: 1 } } } });
  assert.deepEqual(recovered.expect.returns.at(-1).intents[0].d[0], { t: 'mark', id: 'tag-b', x: { memo: { text: 'old!', base: { text: 'old' } } } });
  return [recovered];
}

function composedMaps() {
  const device = deviceWith({ 'self/probe': productRows(), [`tree/${B1}`]: [tag('oak', 'Oak', 1)] });
  const queued = [
    sprout({ board: B1, tag: 'oak', child: CHILD }, 2000),
    adopt(CHILD, { tag: 'elm', label: 'Ash' }, 2001),
    mark(CHILD, 'elm', 2002),
    sprout({ board: CHILD, tag: 'elm', child: GRANDCHILD }, 2003),
  ];
  const first = runSteps({ device, steps: [...queued, { op: 'push', deviceNow: 2004 }] });
  const redirect = served(stepState(), first.returns.at(-1), 3000);
  const second = runSteps({ device, steps: [...queued, { op: 'push', deviceNow: 2004 }, { op: 'pushResponse', deviceNow: 3000, response: redirect.response }, { op: 'push', deviceNow: 3001 }] });
  assert.equal(second.returns.at(-1).intents[0].scope, `tree/${B9}`);
  const adoption = served(redirect.state, second.returns.at(-1), 4000);
  assert.deepEqual(adoption.response.body.results[0].write, [{ t: 'tag', id: 'ash', from: 'elm', born: st(1000) }]);
  const composed = stepsVector('a governor redirect then a tag map in the redirected tree rename an overlay key and a step through both', {
    device, steps: [...queued, { op: 'push', deviceNow: 2004 }, { op: 'pushResponse', deviceNow: 3000, response: redirect.response },
      { op: 'push', deviceNow: 3001 }, { op: 'pushResponse', deviceNow: 4000, response: adoption.response }],
  });
  const outbox = outboxOf(composed);
  assert.deepEqual(outbox.slice(2).map(({ scope, intent }) => [scope, intent.d?.[0].id ?? intent.cmd.args]), [
    [`self/overlay/${B9}`, 'ash'], ['self/probe', { board: B9, tag: 'ash', child: GRANDCHILD }],
  ]);
  return [composed];
}

// ── refs/traversal.json ─────────────────────────────────────────────────────────────────────────────

function traversed(name, input) {
  const { references } = registry;
  const holder = structuredClone(input.record ?? input.cmd);
  const leaves = input.record ? references.recordLeaves(holder.t) : references.commandLeaves(holder.name);
  const resolved = references.resolve(leaves, holder, input.scope)
    .map(({ leaf, scope, t, id }) => ({ role: leaf.role, scope, t, id }))
    .sort((a, b) => (jcs(a) < jcs(b) ? -1 : 1));
  for (const mappings of input.maps) {
    const map = new RecordMap(registry, mappings);
    if (input.record) references.remapRecord(input.scope, holder, map);
    else references.remapCommand(input.scope, holder, map);
  }
  return vector(name, input, { references: resolved, after: holder });
}

function traversal() {
  const toNine = { t: 'board', from: CHILD, id: B9 };
  const elmToOak = (tree) => ({ t: 'tag', from: 'elm', id: 'oak', scope: `tree/${tree}` });
  const parent = { t: 'board', id: GRANDCHILD, born: st(2000), life: ['alive', st(2000)], f: { parent: [{ board: CHILD, tag: 'elm' }, st(2000)] } };
  const orders = [
    ['one map, its scoped key named before the redirect', [[toNine, elmToOak(CHILD)]]],
    ['one map, its scoped key named after the redirect', [[toNine, elmToOak(B9)]]],
    ['the redirect, then the tag map in the redirected tree', [[toNine], [elmToOak(B9)]]],
    ['the tag map, then the redirect', [[elmToOak(CHILD)], [toNine]]],
  ].map(([order, maps]) => traversed(`a nested parent through global and scoped maps: ${order}`, { scope: 'self/probe', record: parent, maps }));
  for (const sample of orders) assert.deepEqual(sample.expect.after.f.parent[0], { board: B9, tag: 'oak' }, sample.name);
  const mark = { t: 'mark', id: 'elm', f: { done: [true, st(2000)] } };
  const overlay = traversed('a plain ref<tag> key held in an overlay resolves into its tree', { scope: `self/overlay/${B1}`, record: mark, maps: [[elmToOak(B1)]] });
  assert.equal(overlay.expect.after.id, 'oak');
  const sibling = traversed('a tag map of one tree leaves the same key in a sibling tree\'s overlay', { scope: `self/overlay/${B3}`, record: mark, maps: [[elmToOak(B1)]] });
  assert.equal(sibling.expect.after.id, 'elm');
  const chain = traversed('one map applies atomically: no mapping feeds another', {
    scope: 'self/probe', record: { t: 'lap', id: 'lap00001', f: { runId: ['run00001', st(2000)] } },
    maps: [[{ t: 'run', from: 'run00001', id: 'run00002' }, { t: 'run', from: 'run00002', id: 'run00003' }]],
  });
  assert.equal(chain.expect.after.f.runId[0], 'run00002');
  const command = traversed('a sprout names its tree and its step, and a redirect never renames its proposed child', {
    scope: 'self/probe', cmd: { name: 'probe.sprout', args: { board: CHILD, tag: 'elm', child: CHILD } }, maps: [[toNine, elmToOak(B9)]],
  });
  assert.deepEqual(command.expect.after.args, { board: B9, tag: 'oak', child: CHILD });
  const link = traversed('a tuple key\'s parts resolve into the link\'s own tree', { scope: `tree/${B1}`, record: { t: 'link', id: ['elm', 'elm'], life: ['alive', st(2000)] }, maps: [[elmToOak(B1)]] });
  assert.deepEqual(link.expect.after.id, ['oak', 'oak']);
  assert.deepEqual(link.expect.references.find(({ role }) => role === 'identity').id, ['elm', 'elm']);
  const untouched = traversed('unannotated JSON and text are never read', {
    scope: 'self/probe', record: { t: 'card', id: CHILD, f: { title: [CHILD, st(2000)], attachment: [{ id: CHILD }, st(2000)] } }, maps: [[{ t: 'card', from: 'card0009', id: 'card0010' }, toNine]],
  });
  assert.deepEqual(untouched.expect.references, [{ role: 'identity', scope: 'self/probe', t: 'card', id: CHILD }]);
  return [...orders, overlay, sibling, chain, command, link, untouched];
}

export function files() {
  return {
    'registry/references.json': [...registryLoads(), ...registryValues()],
    'admit/references.json': admissions(),
    'write/references.json': [...redirectedChild(), ...dependencies(), ...scopedTagMap(), ...renamedText(), ...composedMaps()],
    'refs/traversal.json': traversal(),
  };
}
