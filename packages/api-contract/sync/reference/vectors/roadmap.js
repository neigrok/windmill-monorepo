// roadmap/admit.json: §6.1 admission against a roadmap server state, under roadmap.registry.json and roadmap's binding
// (Appendix A.1): its commands and their inverses, the life a change carries, the reach of a branch, the end of a root,
// the owner's workspace, Coach's records, and the caps and bounds the registry states.
// roadmap/client.json: one device committing roadmap's commands offline and settling by the server's answers.

import { readFileSync } from 'node:fs';
import { CONSTANTS } from '../core/constants.js';
import { ZERO_DIGEST, replaceRow } from '../core/digest.js';
import { Registry } from '../core/registry.js';
import { footprintOf } from '../core/restore.js';
import { compactRow, isAlive } from '../core/rows.js';
import { freshMeta } from '../client/replica.js';
import { GENESIS_KINDS, RoadmapProduct } from '../roadmap/product.js';
import { admit } from '../server/admit.js';
import { pull } from '../server/pull.js';
import { push } from '../server/push.js';
import { ServerState } from '../server/state.js';
import { OTHER, st, vector } from './fixtures.js';
import { runSteps, settle } from './steps.js';

export const roadmapRegistry = new Registry(JSON.parse(readFileSync(new URL('../../roadmap.registry.json', import.meta.url), 'utf8')));
export const roadmapProduct = new RoadmapProduct();

const R = 't_0000000000000001';
const S = 't_0000000000000002';
const S2 = 't_0000000000000003';
const H = 't_0000000000000005';
const Y = 't_0000000000000004';
const Z = 't_0000000000000006';
const F = 't_0000000000000007';
const NEW = 't_00000000000000a1';
const NEW2 = 't_00000000000000a2';
const ACCOUNT = 'acct:A/roadmap';
const NOW = 10_000;
const OWNER = { kind: 'replica', account: 'A', replica: 'rp_0000000000000000000000000000000a', n: 1 };
const READER = { kind: 'replica', account: 'B', replica: 'rp_0000000000000000000000000000000b', n: 1 };
const DOOR = { kind: 'server', account: 'A' };
const a = (ms) => st(ms);
const b = (ms) => st(ms, 0, OTHER);
const srv = (ms) => `${ms}:0:srv`;
const MARK = { status: 'complete', outOfOrder: false };

// A stored row: `f` names each register `[value, stamp]`.
function rec(t, id, seq, { born, life, f } = {}) {
  return compactRow({ t, id, seq, rc: seq * 100, ru: seq * 100, ...(born ? { born } : {}), ...(life ? { life } : {}), ...(f ? { f } : {}) });
}
const alive = (stamp) => ({ born: stamp, life: ['alive', stamp] });
const node = (id, seq, f, life = ['alive', a(1000)]) => rec('node', id, seq, { born: a(1000), life, f: { label: [id, a(1000)], ...f } });
const kind = (id, hue, ord, seq = 1, life = ['alive', a(1000)]) => rec('kind', id, seq, {
  born: a(1000), life, f: { hue: [hue, a(1000)], label: [id, a(1000)], description: ['', a(1000)], ord: [ord, a(1000)] },
});
const place = (tree, step, stamp) => ({ parent: [{ tree, step }, stamp] });
const subtreeMeta = (root, tree, step, depth, reach, stamp, reached = stamp) => rec('meta', 'meta', 1, {
  f: { root: [root, stamp], ...place(tree, step, stamp), depth: [depth, stamp], reach: [reach, reached] },
});

// The owner A's account: a public root R whose step `ownership` owns the standing subtree S, whose step `lifetimes`
// owns S2; R's deleted step `macros` owns H, which does not stand; a private root Y whose step `rust` opens R; and the
// dead roadmap Z. B reads R and has marked a step of it.
function world() {
  return {
    [ACCOUNT]: {
      scope: { kind: 'product', owner: 'A' },
      rows: [
        rec('tree', R, 1, alive(a(1000))),
        rec('tree', S, 2, { ...alive(srv(2000)), f: place(R, 'ownership', srv(2000)) }),
        rec('tree', S2, 3, { ...alive(srv(3000)), f: place(S, 'lifetimes', srv(3000)) }),
        rec('tree', Y, 4, alive(a(1500))),
        rec('tree', H, 5, { ...alive(srv(2500)), f: place(R, 'macros', srv(2500)) }),
        rec('tree', Z, 6, { born: a(1600), life: ['dead', a(1700)] }),
      ],
    },
    [`tree:${R}`]: {
      scope: tree(R),
      rows: [
        rec('meta', 'meta', 3, { f: { title: ['Learn Rust', a(1000)], visibility: ['public', a(1100)], reach: ['public', srv(1100)] } }),
        node('basics', 1, { ord: ['a0', a(1000)] }),
        node('ownership', 2, { ord: ['a1', a(1000)], color: ['olive', a(1000)], branch: [S, srv(2000)] }),
        node('macros', 4, { ord: ['a2', a(1000)], color: ['olive', a(1000)], branch: [H, srv(2500)] }, ['dead', a(2600)]),
        rec('edge', ['basics', 'ownership'], 1, { life: ['alive', a(1000)] }),
        kind('build', 'terracotta', 'a0'), kind('learn', 'olive', 'a1'), kind('milestone', 'gold', 'a2'),
      ],
    },
    [`tree:${S}`]: { scope: tree(S), rows: [subtreeMeta(R, R, 'ownership', 1, 'public', srv(2000)),
      node('lifetimes', 2, { ord: ['a0', a(1000)], branch: [S2, srv(3000)] }), node('borrowing', 2, { ord: ['a1', a(1000)] })] },
    [`tree:${S2}`]: { scope: tree(S2), rows: [subtreeMeta(R, S, 'lifetimes', 2, 'public', srv(3000)), node('deep', 2, { ord: ['a0', a(1000)] })] },
    [`tree:${H}`]: { scope: tree(H), rows: [subtreeMeta(R, R, 'macros', 1, 'private', srv(2500))] },
    [`tree:${Y}`]: {
      scope: tree(Y),
      rows: [rec('meta', 'meta', 1, { f: { title: ['Reading', a(1500)] } }), node('rust', 1, { ord: ['a0', a(1500)] }),
        node('gone', 1, { ord: ['a1', a(1500)] }), node('other', 1, { ord: ['a2', a(1500)] })],
    },
    [`tree:${Z}`]: { scope: { ...tree(Z), state: 'dead', deadAt: 1700 }, rows: [node('x', 1, {})] },
    [`acct:A/overlay/${R}`]: { scope: overlay('A', R), rows: [rec('progress', 'basics', 1, { f: { mark: [MARK, a(1200)] } })] },
    [`acct:A/overlay/${Y}`]: {
      scope: overlay('A', Y),
      rows: [rec('pointer', 'rust', 1, { life: ['alive', a(1500)], f: { opens: [R, a(1500)] } }),
        rec('pointer', 'gone', 2, { life: ['dead', a(1800)], f: { opens: [R, a(1500)] } })],
    },
    [`acct:B/overlay/${R}`]: { scope: overlay('B', R), rows: [rec('progress', 'basics', 1, { f: { mark: [MARK, b(1300)] } })] },
  };
}

function tree(id) {
  return { kind: 'tree', owner: 'A', governedBy: `${ACCOUNT}#tree#${id}` };
}

function overlay(owner, id) {
  return { kind: 'overlay', owner, governedBy: `tree:${id}` };
}

// A server state from a world: each scope's seq, digest and capped counters follow its rows.
function stateOf(scopes, { clock = { ms: 3000, counter: 0 } } = {}) {
  const json = { epoch: 'ep-1', clock, accounts: { A: { name: 'Ann' }, B: { name: 'Bob' } }, scopes: {}, rows: {} };
  for (const [key, { scope, rows }] of Object.entries(scopes)) {
    const own = rows.map(compactRow);
    const counters = {};
    for (const type of roadmapRegistry.types.values()) {
      const count = own.filter((row) => row.t === type.type && isAlive(row)).length;
      if (type.cap !== undefined && count) counters[type.type] = count;
    }
    const digest = own.reduce((sum, row) => replaceRow(sum, undefined, row), ZERO_DIGEST);
    json.scopes[key] = { state: 'alive', seq: Math.max(0, ...own.map((row) => row.seq)), ...scope, counters, digest };
    json.rows[key] = own;
  }
  return new ServerState(json).toJSON();
}

// A world edited in place: `edit(world)` changes its rows before the state is drawn.
function stateWith(edit) {
  const scopes = world();
  edit(scopes);
  return stateOf(scopes);
}

function replaceIn(scopes, key, row) {
  scopes[key].rows = [...scopes[key].rows.filter((other) => other.t !== row.t || JSON.stringify(other.id) !== JSON.stringify(row.id)), row];
}

function admitted(name, state, intent, origin = OWNER, serverNow = NOW) {
  const outcome = admit({ state: new ServerState(state), registry: roadmapRegistry, product: roadmapProduct, origin, intent, serverNow, limits: CONSTANTS });
  return vector(name, { state, origin, intent, serverNow }, { result: outcome.result, state: outcome.state.toJSON() });
}

const command = (scope, name, args, d) => ({ scope, cmd: { name, args }, ...(d ? { d } : {}) });
const inTree = (id, d) => ({ scope: `tree/${id}`, d });
const subtree = (args) => command('self/roadmap', 'roadmap.createSubtree', args);

function commands() {
  const base = stateOf(world());
  const depth = (n) => stateWith((scopes) => replaceIn(scopes, `tree:${S2}`, subtreeMeta(R, S, 'lifetimes', n, 'public', srv(3000))));
  const deadKind = stateWith((scopes) => replaceIn(scopes, `tree:${R}`, kind('milestone', 'gold', 'a2', 2, ['dead', a(2000)])));
  const deadStep = stateWith((scopes) => replaceIn(scopes, `tree:${R}`, node('basics', 2, { ord: ['a0', a(1000)] }, ['dead', a(2000)])));
  return [
    admitted('createSubtree plants a subtree: its record and place, its meta one deeper with the reach above, the genesis kinds and the step\'s branch', base,
      subtree({ tree: R, root: R, step: 'basics', subtree: NEW })),
    admitted('createSubtree under a subtree takes its root and the depth below it', base, subtree({ tree: S, root: R, step: 'borrowing', subtree: NEW })),
    admitted('createSubtree on a step that owns a subtree answers that subtree', base, subtree({ tree: R, root: R, step: 'ownership', subtree: NEW })),
    admitted('createSubtree on a deleted step that owns a subtree revives the step, and the subtree stands again', base,
      subtree({ tree: R, root: R, step: 'macros', subtree: NEW })),
    admitted('createSubtree on a step deleted elsewhere revives it and plants a standing subtree', deadStep, subtree({ tree: R, root: R, step: 'basics', subtree: NEW })),
    admitted('createSubtree on a step whose pointer opens a roadmap is refused step-opens-a-tree', base, subtree({ tree: Y, root: Y, step: 'rust', subtree: NEW })),
    admitted('createSubtree on a step whose pointer is deleted plants a subtree', base, subtree({ tree: Y, root: Y, step: 'gone', subtree: NEW })),
    admitted('createSubtree at depth 7 plants at MAX_DEPTH', depth(7), subtree({ tree: S2, root: R, step: 'deep', subtree: NEW })),
    admitted('createSubtree at MAX_DEPTH is refused depth-limit', depth(8), subtree({ tree: S2, root: R, step: 'deep', subtree: NEW })),
    admitted('createSubtree naming another root is refused invalid', base, subtree({ tree: S, root: S, step: 'borrowing', subtree: NEW })),
    admitted('createSubtree on a step the roadmap never held is refused unknown-record', base, subtree({ tree: R, root: R, step: 'traits', subtree: NEW })),
    admitted('createSubtree under a taken id is refused id-taken', base, subtree({ tree: R, root: R, step: 'basics', subtree: Y })),
    admitted('createSubtree in a deleted roadmap is refused scope-dead', base, subtree({ tree: Z, root: Z, step: 'x', subtree: NEW })),
    admitted('recolourKind writes the kind\'s hue and the colour of every step wearing it, present or not, and revives none', base,
      command(`tree/${R}`, 'roadmap.recolourKind', { kind: 'learn', hue: 'sky' })),
    admitted('recolourKind of the kind unset colours wear recolours them', base, command(`tree/${R}`, 'roadmap.recolourKind', { kind: 'build', hue: 'brick' })),
    admitted('recolourKind of a kind deleted elsewhere revives the kind', deadKind, command(`tree/${R}`, 'roadmap.recolourKind', { kind: 'milestone', hue: 'plum' })),
    admitted('recolourKind to the hue the kind wears writes nothing', base, command(`tree/${R}`, 'roadmap.recolourKind', { kind: 'learn', hue: 'olive' })),
    admitted('recolourKind of a kind the roadmap never held is refused unknown-record', base, command(`tree/${R}`, 'roadmap.recolourKind', { kind: 'reading', hue: 'sky' })),
  ];
}

// K-3's product inverses: evidence as the engine builds it from the act's receipts.
const field = (name) => ({ kind: 'field', name });
const created = (state, key, scope, t, id) => {
  const row = state.rows[key].find((r) => r.t === t && r.id === id);
  return { record: { scope, t, id }, rowSeq: row.seq, footprint: footprintOf(row) };
};
const owned = (target, stamp) => ({ target, version: { kind: 'stamp', stamp } });
const evidence = ({ ownedFields = [], unchangedCreatedRecords = [], unchangedCreatedScopes = [], expectedEpoch = 'ep-1' }) => ({
  expectedEpoch, ownedFields, unchangedCreatedRecords, unchangedCreatedScopes,
});
const inverse = (scope, name, input, proof) => command(scope, name, { input, evidence: proof });
const after = (state, intent, origin = OWNER) => admit({ state: new ServerState(state), registry: roadmapRegistry, product: roadmapProduct, origin, intent, serverNow: NOW, limits: CONSTANTS }).state.toJSON();
const stampOf = (state, key, t, id, name) => state.rows[key].find((r) => r.t === t && r.id === id).f[name][1];

function inverses() {
  const base = stateOf(world());

  const planted = after(base, subtree({ tree: R, root: R, step: 'basics', subtree: NEW }));
  const branch = (state) => owned({ scope: `tree/${R}`, t: 'node', id: 'basics', slot: field('branch') }, stampOf(state, `tree:${R}`, 'node', 'basics', 'branch'));
  const proof = (state, edit = {}) => evidence({ ownedFields: [branch(state)], unchangedCreatedRecords: [created(state, ACCOUNT, 'self/roadmap', 'tree', NEW)],
    unchangedCreatedScopes: [{ scope: `tree/${NEW}`, seq: state.scopes[`tree:${NEW}`].seq }], ...edit });
  const undo = (edit, input = { tree: R, step: 'basics', subtree: NEW }) => inverse('self/roadmap', 'roadmap.undoCreateSubtree', input, proof(planted, edit));
  const grown = after(planted, inTree(NEW, [{ t: 'node', id: 'first', ...alive(a(5000)), f: { label: ['First', a(5000)] } }]));
  const marked = after(planted, { scope: `self/overlay/${NEW}`, d: [{ t: 'progress', id: 'build', f: { mark: [MARK, a(5000)] } }] });
  const undone = after(planted, undo({}));
  const redo = () => inverse('self/roadmap', 'roadmap.redoCreateSubtree', { tree: R, root: R, step: 'basics', subtree: NEW2 }, evidence({ ownedFields: [branch(undone)] }));
  const replanted = after(undone, subtree({ tree: R, root: R, step: 'basics', subtree: NEW2 }));

  const made = after(after(base, { scope: 'self/roadmap', d: [{ t: 'tree', id: F, ...alive(a(5000)) }] }),
    inTree(F, [{ t: 'meta', id: 'meta', f: { title: ['Fresh', a(5000)] } }, { t: 'kind', id: 'build', ...alive(a(5000)), f: { hue: ['terracotta', a(5000)], ord: ['a0', a(5000)] } }]));
  const rootProof = (state) => evidence({ unchangedCreatedRecords: [created(state, ACCOUNT, 'self/roadmap', 'tree', F)], unchangedCreatedScopes: [{ scope: `tree/${F}`, seq: state.scopes[`tree:${F}`].seq }] });
  const uncreate = (proofOf) => inverse('self/roadmap', 'roadmap.undoCreateRoadmap', { tree: F }, proofOf);
  const markedRoot = after(made, { scope: `self/overlay/${F}`, d: [{ t: 'progress', id: 'first', f: { mark: [MARK, a(6000)] } }] });

  return [
    admitted('undoCreateSubtree while the connection and the subtree are unchanged kills the subtree and clears the step\'s branch together', planted, undo({})),
    admitted('undoCreateSubtree after a step was added in the subtree skips scope-changed', grown, undo({})),
    admitted('undoCreateSubtree after the owner marked the subtree skips scope-changed', marked, undo({})),
    admitted('undoCreateSubtree after the branch moved skips version-changed', planted,
      inverse('self/roadmap', 'roadmap.undoCreateSubtree', { tree: R, step: 'basics', subtree: NEW }, proof(planted, { ownedFields: [owned(branch(planted).target, srv(1))] }))),
    admitted('undoCreateSubtree naming another step of the subtree is invalid', planted, undo({}, { tree: R, step: 'ownership', subtree: NEW })),
    admitted('undoCreateSubtree without proof of the created scope is invalid', planted, undo({ unchangedCreatedScopes: [] })),
    admitted('redoCreateSubtree while the Undo\'s branch stands plants a new subtree under a fresh id', undone, redo()),
    admitted('redoCreateSubtree after the step took another subtree skips version-changed', replanted, redo()),
    admitted('undoCreateRoadmap while the roadmap is as its creation left it kills it', made, uncreate(rootProof(made))),
    admitted('undoCreateRoadmap after the owner marked a step of it skips scope-changed', markedRoot, uncreate(rootProof(made))),
    admitted('undoCreateRoadmap without proof of its scope is invalid', made, uncreate(evidence({ unchangedCreatedRecords: rootProof(made).unchangedCreatedRecords }))),
  ];
}

// Decision 17: a root's visibility is the owner's field, ordered by gesture time; its change writes the branch's reach.
function visibilities() {
  const base = stateOf(world());
  const hidden = stateWith((scopes) => {
    replaceIn(scopes, `tree:${R}`, rec('meta', 'meta', 3, { f: { title: ['Learn Rust', a(1000)], visibility: ['private', a(3000)], reach: ['private', srv(3000)] } }));
    replaceIn(scopes, `tree:${S}`, subtreeMeta(R, R, 'ownership', 1, 'private', srv(2000), srv(3000)));
    replaceIn(scopes, `tree:${S2}`, subtreeMeta(R, S, 'lifetimes', 2, 'private', srv(3000)));
  });
  const visibility = (tree, value, stamp) => inTree(tree, [{ t: 'meta', id: 'meta', f: { visibility: [value, stamp] } }]);
  const restore = (stamp) => command(`tree/${R}`, 'roadmap.restoreTree', { expectedEpoch: 'ep-1', operations: [
    { kind: 'field', t: 'meta', id: 'meta', slot: { kind: 'field', name: 'visibility' }, expected: { kind: 'stamp', stamp }, before: 'private' }] });
  return [
    admitted('the owner\'s visibility of a root writes its reach and the reach of every standing subtree of its branch', hidden, visibility(R, 'public', a(5000))),
    admitted('a visibility older than the root\'s changes nothing: a stale public never overrides a newer private', hidden, visibility(R, 'public', a(2000))),
    admitted('a visibility restamped with the value the root holds writes no reach', base, visibility(R, 'public', a(5000))),
    admitted('a root with no subtree takes its visibility as its reach', base, visibility(Y, 'public', a(5000))),
    admitted('a visibility written on a subtree is refused not-a-root', base, visibility(S, 'private', a(5000))),
    admitted('a visibility outside private and public, unlisted among them, is refused invalid', base, visibility(R, 'unlisted', a(5000))),
    admitted('a reader\'s visibility is refused forbidden', base, visibility(R, 'private', b(5000)), READER),
    admitted('the server\'s door writes a root\'s visibility as the owner does', base, visibility(R, 'private', null), DOOR),
    admitted('an Undo restoring the earlier visibility writes the branch\'s reach back', base, restore(a(1100))),
    admitted('an Undo after another write of the visibility skips it and writes no reach', base, restore(a(1000))),
  ];
}

function consequences() {
  const base = stateOf(world());
  const withoutOwnership = (edit = () => {}) => stateWith((scopes) => {
    replaceIn(scopes, `tree:${R}`, node('ownership', 5, { ord: ['a1', a(1000)], color: ['olive', a(1000)], branch: [S, srv(2000)] }, ['dead', a(5000)]));
    replaceIn(scopes, `tree:${S}`, subtreeMeta(R, R, 'ownership', 1, 'private', srv(2000), srv(5000)));
    replaceIn(scopes, `tree:${S2}`, subtreeMeta(R, S, 'lifetimes', 2, 'private', srv(3000), srv(5000)));
    edit(scopes);
  });
  const revive = inTree(R, [{ t: 'node', id: 'ownership', born: a(1000), life: ['alive', a(6000)] }]);
  const restore = command(`tree/${R}`, 'roadmap.restoreTree', { expectedEpoch: 'ep-1', operations: [
    { kind: 'field', t: 'node', id: 'ownership', slot: { kind: 'life' }, expected: { kind: 'stamp', stamp: a(5000) }, before: 'alive' }] });
  return [
    admitted('a step\'s death that ends its subtree\'s standing writes reach private on every subtree under it', base,
      inTree(R, [{ t: 'node', id: 'ownership', born: a(1000), life: ['dead', a(5000)] }])),
    admitted('the step\'s revival writes the reach above back on the subtrees under it', withoutOwnership(), revive),
    admitted('a revival leaves private a subtree whose own step is absent', withoutOwnership((scopes) => {
      replaceIn(scopes, `tree:${S}`, node('lifetimes', 3, { ord: ['a0', a(1000)], branch: [S2, srv(3000)] }, ['dead', a(5500)]));
    }), revive),
    admitted('an Undo restoring a deleted step writes the reach above back on the subtrees under it', withoutOwnership(), restore),
    admitted('a step deleted under a private root changes no reach', base, inTree(Y, [{ t: 'node', id: 'rust', born: a(1000), life: ['dead', a(5000)] }])),
    admitted('a root\'s death kills every subtree under it and deletes each step of the owner\'s other roadmaps whose pointer opens it', base,
      { scope: 'self/roadmap', d: [{ t: 'tree', id: R, born: a(1000), life: ['dead', a(5000)] }] }),
    admitted('a person\'s delete of a subtree\'s record is refused not-a-root', base,
      { scope: 'self/roadmap', d: [{ t: 'tree', id: S, born: srv(2000), life: ['dead', a(5000)] }] }),
    admitted('the server\'s door deletes a subtree with every subtree under it', base,
      { scope: 'self/roadmap', d: [{ t: 'tree', id: S, born: srv(2000), life: ['dead', null] }] }, DOOR),
  ];
}

function revivals() {
  const deleted = (stamp) => stateWith((scopes) => {
    replaceIn(scopes, `tree:${R}`, node('basics', 2, { ord: ['a0', a(1000)] }, ['dead', stamp]));
    replaceIn(scopes, `tree:${R}`, kind('learn', 'olive', 'a1', 2, ['dead', stamp]));
  });
  const change = (t, id, stamp, f) => inTree(R, [{ t, id, born: a(1000), life: ['alive', stamp], f }]);
  return [
    admitted('a change to a step deleted elsewhere, made before the delete, is revived by the server', deleted(a(5000)),
      change('node', 'basics', a(4000), { label: ['The basics', a(4000)] })),
    admitted('a change made after the delete revives the step by its own life', deleted(a(5000)), change('node', 'basics', a(6000), { label: ['The basics', a(6000)] })),
    admitted('a change to a kind deleted elsewhere is revived by the server', deleted(a(5000)), change('kind', 'learn', a(4000), { label: ['Study', a(4000)] })),
    admitted('a change to a step that owns a subtree, deleted elsewhere, revives the step and the subtree stands again', stateOf(world()),
      inTree(R, [{ t: 'node', id: 'macros', born: a(1000), life: ['alive', a(2500)], f: { label: ['Macros', a(2500)] } }])),
    admitted('a delete older than the step\'s life changes nothing', stateOf(world()), inTree(R, [{ t: 'node', id: 'basics', born: a(1000), life: ['dead', a(900)] }])),
  ];
}

function access() {
  const base = stateOf(world());
  const overlayOf = (id) => `self/overlay/${id}`;
  const workspace = (stamp) => [
    { t: 'subtask', id: 'subtask0001', ...alive(stamp), f: { step: ['basics', stamp], label: ['Read chapter 1', stamp], ord: ['a0', stamp] } },
    { t: 'stepLink', id: 'steplink001', ...alive(stamp), f: { step: ['basics', stamp], url: ['https://doc.rust-lang.org/book/', stamp], ord: ['a0', stamp] } },
    { t: 'stepNote', id: 'basics', x: { text: { text: 'Start here.', base: { rev: 0 } } } },
  ];
  return [
    admitted('a reader\'s mark is admitted in their own overlay', base, { scope: overlayOf(R), d: [{ t: 'progress', id: 'ownership', f: { mark: [MARK, b(5000)] } }] }, READER),
    admitted('a pointer in a reader\'s overlay is refused forbidden', base,
      { scope: overlayOf(R), d: [{ t: 'pointer', id: 'basics', life: ['alive', b(5000)], f: { opens: [R, b(5000)] } }] }, READER),
    ...workspace(b(5000)).map((delta) => admitted(`a ${delta.t} in a reader's overlay is refused forbidden`, base, { scope: overlayOf(R), d: [delta] }, READER)),
    admitted('the owner\'s workspace and pointer are admitted in their own overlay', base,
      { scope: overlayOf(R), d: [...workspace(a(5000)), { t: 'pointer', id: 'basics', life: ['alive', a(5000)], f: { opens: [Y, a(5000)] } }] }),
  ];
}

function guides() {
  const inherited = stateWith((scopes) => replaceIn(scopes, `tree:${R}`, rec('meta', 'meta', 3, {
    f: { title: ['Learn Rust', a(1000)], guide: ['Their guide', srv(1100)], guideInherited: [true, srv(1100)], visibility: ['public', a(1100)], reach: ['public', srv(1100)] },
  })));
  const meta = (f) => inTree(R, [{ t: 'meta', id: 'meta', f }]);
  return [
    admitted('the owner\'s guide clears guideInherited', inherited, meta({ guide: ['My guide', a(5000)] })),
    admitted('a title leaves guideInherited', inherited, meta({ title: ['Rust', a(5000)] })),
    admitted('a guide older than the inherited one changes nothing', inherited, meta({ guide: ['Old guide', a(1000)] })),
    admitted('the server\'s door writing a guide it marks inherited keeps guideInherited', inherited, meta({ guide: ['Forked guide', null], guideInherited: [true, null] }), DOOR),
  ];
}

function limits() {
  const base = stateOf(world());
  const six = stateWith((scopes) => {
    for (const [id, hue, ord] of [['read', 'brick', 'a3'], ['write', 'sky', 'a4'], ['ship', 'plum', 'a5']]) scopes[`tree:${R}`].rows.push(kind(id, hue, ord));
  });
  const create = (t, id, f) => inTree(R, [{ t, id, ...alive(a(5000)), ...(f ? { f } : {}) }]);
  return [
    admitted('a seventh kind is refused cap', six, create('kind', 'extra', { hue: ['terracotta', a(5000)], ord: ['a6', a(5000)] })),
    admitted('a kind wearing a hue another kind wears lands', base, create('kind', 'reading', { hue: ['terracotta', a(5000)], ord: ['a3', a(5000)] })),
    admitted('a link closing a loop lands', base, inTree(R, [{ t: 'edge', id: ['ownership', 'basics'], life: ['alive', a(5000)] }])),
    admitted('a title past 200 chars is refused invalid', base, inTree(R, [{ t: 'meta', id: 'meta', f: { title: ['x'.repeat(201), a(5000)] } }])),
    admitted('a step status outside none and complete is refused invalid', base, inTree(R, [{ t: 'node', id: 'basics', born: a(1000), life: ['alive', a(5000)], f: { status: ['active', a(5000)] } }])),
    admitted('a person\'s write of a subtree\'s depth is refused invalid', base, inTree(S, [{ t: 'meta', id: 'meta', f: { depth: [2, a(5000)] } }])),
    admitted('a step with 33 links is refused invalid', base, inTree(R, [{ t: 'node', id: 'basics', born: a(1000), life: ['alive', a(5000)],
      f: { links: [Array.from({ length: 33 }, (_, i) => ({ url: `https://example.com/${i}`, label: '' })), a(5000)] } }])),
  ];
}

// A conversation about R with a turn ended, its proposal and a write fate, and a conversation about all roadmaps.
const conversations = () => [
  rec('coachThread', 'thread0001', 7, { ...alive(a(2000)), f: { treeId: [R, a(2000)], title: ['Plan my week', a(2000)] } }),
  rec('coachMessage', 'message0001', 7, { ...alive(a(2000)), f: { threadId: ['thread0001', a(2000)], role: ['person', a(2000)], text: ['Plan my week', a(2000)], at: [2000, a(2000)] } }),
  rec('coachMessage', 'message0002', 8, { ...alive(a(2100)), f: { threadId: ['thread0001', a(2100)], role: ['coach', a(2100)], text: ['Done.', a(2200)], state: ['completed', a(2200)], at: [2100, a(2100)] } }),
  rec('coachProposal', 'proposal001', 8, { ...alive(a(2200)), f: { threadId: ['thread0001', a(2200)], messageId: ['message0002', a(2200)], treeId: [R, a(2200)] } }),
  rec('coachWriteFate', 'fate000001', 8, { ...alive(a(2300)), f: { messageId: ['message0002', a(2300)], receipt: [0, a(2300)], fate: ['undone', a(2300)] } }),
  rec('coachThread', 'thread0002', 8, { ...alive(a(2400)), f: { treeId: [null, a(2400)], title: ['All roadmaps', a(2400)] } }),
];

function coach() {
  const turn = stateWith((scopes) => scopes[ACCOUNT].rows.push(...conversations()));
  const message = (f) => ({ scope: 'self/roadmap', d: [{ t: 'coachMessage', id: 'message0002', born: a(2100), f }] });
  return [
    admitted('a message\'s text is final once its writer ended the turn: turn-final', turn, message({ text: ['Changed', a(5000)] })),
    admitted('a message\'s receipts are final once its writer ended the turn: turn-final', turn, message({ receipts: [[], a(5000)] })),
    admitted('truncated stays writable after the turn', turn, message({ truncated: [true, a(5000)] })),
    admitted('a conversation\'s death kills its messages, their write fates and its proposals, and no other conversation', turn,
      { scope: 'self/roadmap', d: [{ t: 'coachThread', id: 'thread0001', born: a(2000), life: ['dead', a(5000)] }] }),
    admitted('a message\'s death kills its write fates', turn, { scope: 'self/roadmap', d: [{ t: 'coachMessage', id: 'message0002', born: a(2100), life: ['dead', a(5000)] }] }),
  ];
}

// Roadmap Coach §9: a roadmap's death takes the conversations about it and about every subtree it takes, and the
// proposals about them in a conversation about all roadmaps; a conversation about all roadmaps, and one about another
// roadmap, stay.
function roadmapDeaths() {
  const state = stateWith((scopes) => scopes[ACCOUNT].rows.push(...conversations(),
    rec('coachThread', 'thread0003', 9, { ...alive(a(2500)), f: { treeId: [S, a(2500)], stepId: ['lifetimes', a(2500)], title: ['Lifetimes?', a(2500)] } }),
    rec('coachMessage', 'message0003', 9, { ...alive(a(2500)), f: { threadId: ['thread0003', a(2500)], role: ['person', a(2500)], text: ['Lifetimes?', a(2500)], at: [2500, a(2500)] } }),
    rec('coachThread', 'thread0004', 9, { ...alive(a(2600)), f: { treeId: [Y, a(2600)], title: ['Reading list', a(2600)] } }),
    rec('coachProposal', 'proposal002', 9, { ...alive(a(2700)), f: { threadId: ['thread0002', a(2700)], messageId: ['message0002', a(2700)], treeId: [R, a(2700)] } }),
    rec('coachProposal', 'proposal003', 9, { ...alive(a(2800)), f: { threadId: ['thread0002', a(2800)], messageId: ['message0002', a(2800)], treeId: [Y, a(2800)] } }),
  ));
  const death = (tree, born, stamp, more = []) => ({ scope: 'self/roadmap', d: [{ t: 'tree', id: tree, born, life: ['dead', stamp] }, ...more] });
  const killed = (t, id, born) => ({ t, id, born, life: ['dead', a(5000)] });
  return [
    admitted('a root\'s death kills the conversations about it and about every subtree under it, with their messages, write fates and proposals, and its proposals in a conversation about all roadmaps', state,
      death(R, a(1000), a(5000))),
    admitted('a root\'s death the device wrote with its conversations and proposals takes nothing more of Coach\'s', state,
      death(R, a(1000), a(5000), [killed('coachThread', 'thread0001', a(2000)), killed('coachThread', 'thread0003', a(2500)), killed('coachProposal', 'proposal001', a(2200)),
        killed('coachProposal', 'proposal002', a(2700))])),
    admitted('the server\'s door deleting a subtree kills the conversations about it and every subtree under it, and none about the root', state,
      death(S, srv(2000), null), DOOR),
  ];
}

// ── roadmap/client.json ───────────────────────────────────────────────────────────────────────────────

const REPLICA = OWNER.replica;

function deviceOf(state) {
  const confirmed = {};
  for (const [key, ref] of [[ACCOUNT, 'self/roadmap'], [`tree:${R}`, `tree/${R}`]]) confirmed[ref] = state.rows[key].filter(isAlive);
  return settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed }] });
}

// A device's createSubtree as the domain plans it: the command, and its predictions in every scope it changes.
function planted(step, tree, sub, deviceNow) {
  return { op: 'commit', scope: 'self/roadmap', deviceNow, changes: [], opts: {
    cmd: { name: 'roadmap.createSubtree', args: { tree, root: R, step, subtree: sub } },
    scopedPredict: [
      { scope: 'self/roadmap', changes: [{ op: 'create', t: 'tree', id: sub, f: { parent: { tree, step } } }] },
      { scope: `tree/${sub}`, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { root: R, parent: { tree, step }, depth: 1, reach: 'public' } },
        ...GENESIS_KINDS.map(({ id, ...f }) => ({ op: 'create', t: 'kind', id, f }))] },
      { scope: `tree/${tree}`, changes: [{ op: 'update', t: 'node', id: step, f: { branch: sub } }] },
    ],
  } };
}

function served(state, request, serverNow) {
  const pushed = push({ state: new ServerState(state), registry: roadmapRegistry, product: roadmapProduct, account: 'A', request, serverNow });
  return { response: pushed.response, state: pushed.state.toJSON() };
}

function pulled(state, scopes, serverNow) {
  return pull({ state: new ServerState(state), registry: roadmapRegistry, product: roadmapProduct, account: 'A',
    request: { scopes: scopes.map((scope) => ({ scope, cursor: null })) }, serverNow }).response;
}

function stepsVector(name, input) {
  const out = runSteps(input, roadmapRegistry);
  const expect = { returns: out.returns, device: out.device, ended: out.ended };
  if (out.telemetry.length) expect.telemetry = out.telemetry;
  if (out.events.length) expect.events = out.events;
  return { name, input, expect };
}

function clientVectors() {
  const server = stateOf(world());
  const device = deviceOf(server);
  const views = [`tree/${R}`, `tree/${NEW}`, 'self/roadmap'].map((scope) => ({ op: 'view', scope, withHeld: true }));

  const offline = [planted('basics', R, NEW, 5000), ...views, { op: 'push', deviceNow: 5001 }];
  const sent = runSteps({ device, steps: offline }, roadmapRegistry);
  const answer = served(server, sent.returns.at(-1), 6000);
  const changed = ['self/roadmap', `self/overlay/${R}`, `tree/${R}`, `tree/${NEW}`];
  const settled = stepsVector('an offline subtree draws its record, meta, genesis kinds and the step\'s branch, and settles by the server\'s answer and pull', {
    device,
    steps: [...offline, { op: 'pushResponse', deviceNow: 6000, response: answer.response },
      { op: 'pull', scopes: changed }, { op: 'pullResponse', deviceNow: 6001, response: pulled(answer.state, changed, 6001) }, ...views],
  });

  const queued = [planted('ownership', R, NEW, 5000),
    { op: 'commit', scope: `tree/${NEW}`, deviceNow: 5001, changes: [{ op: 'create', t: 'node', id: 'first', f: { label: 'First', ord: 'a0' } }] },
    planted('first', NEW, NEW2, 5002), { op: 'push', deviceNow: 5003 }];
  const first = runSteps({ device, steps: queued }, roadmapRegistry);
  const owner = served(server, first.returns.at(-1), 6000);
  const redirected = stepsVector('a step that already owns a subtree answers it: the write map renames the proposed subtree, and the work queued in it follows', {
    device, steps: [...queued, { op: 'pushResponse', deviceNow: 6000, response: owner.response }, { op: 'push', deviceNow: 6001 }],
  });

  const followed = conversationAbout(NEW, 5001);
  const asked = [planted('ownership', R, NEW, 5000), followed.opened, followed.proposed, { op: 'push', deviceNow: 5003 }];
  const joined = served(server, runSteps({ device, steps: asked }, roadmapRegistry).returns.at(-1), 6000);
  const following = stepsVector('a conversation and a pending proposal queued about a proposed subtree follow the write map to the subtree the step owns', {
    device, steps: [...asked, { op: 'pushResponse', deviceNow: 6000, response: joined.response }, { op: 'push', deviceNow: 6001 }],
  });

  const lost = conversationAbout(Z, 5001);
  const everyRoadmap = { op: 'commit', scope: 'self/roadmap', deviceNow: 5003, changes: [
    { op: 'create', t: 'coachThread', id: 'thread0010', f: { treeId: null, stepId: null, title: 'What next?' } }] };
  const refusing = [planted('basics', R, Z, 5000), lost.opened, lost.ended, everyRoadmap, { op: 'push', deviceNow: 5004 }];
  const spent = served(server, runSteps({ device, steps: refusing }, roadmapRegistry).returns.at(-1), 6000);
  const folded = stepsVector('a refused subtree folds the conversation about it with the messages its own entry holds and a later update of one, and the next push sends only the conversation about every roadmap', {
    device, steps: [...refusing, { op: 'pushResponse', deviceNow: 6000, response: spent.response }, { op: 'push', deviceNow: 6001 }],
  });

  const chain = [planted('basics', R, Z, 5000),
    { op: 'commit', scope: 'self/roadmap', deviceNow: 5001, opts: { atomic: true }, changes: [
      { op: 'create', t: 'coachThread', id: 'thread0019', f: { treeId: Z, stepId: null, title: 'Chain' } },
      { op: 'create', t: 'coachMessage', id: 'message0019', f: { threadId: 'thread0019', role: 'coach', replica: REPLICA, at: 5001 } },
      { op: 'create', t: 'coachWriteFate', id: 'fate00000019', f: { messageId: 'message0019', receipt: 1, fate: 'undone' } },
      { op: 'create', t: 'coachThread', id: 'thread0020', f: { treeId: null, stepId: null, title: 'Free' } },
      { op: 'create', t: 'coachMessage', id: 'message0020', f: { threadId: 'thread0020', role: 'person', text: 'Hi', at: 5001 } }] },
    { op: 'commit', scope: 'self/roadmap', deviceNow: 5002, opts: { atomic: true }, changes: [
      { op: 'update', t: 'coachWriteFate', id: 'fate00000019', f: { code: 'x' } },
      { op: 'update', t: 'coachMessage', id: 'message0020', f: { text: 'Hello' } }] },
    { op: 'push', deviceNow: 5003 }];
  const chainAnswer = served(server, runSteps({ device, steps: chain }, roadmapRegistry).returns.at(-1), 6000);
  const chained = stepsVector('a chain of three Coach records in one entry folds whole with a later update of its last; the independent conversation and its message stay and are sent', {
    device, steps: [...chain, { op: 'pushResponse', deviceNow: 6000, response: chainAnswer.response }, { op: 'push', deviceNow: 6001 }],
  });
  return [settled, redirected, following, folded, chained];
}

// A turn about `tree` as roadmap's domain writes it: the conversation with the person's question and Coach's message in
// one act, then Coach's answer ending the turn, or a pending proposal on it in one act.
function conversationAbout(tree, deviceNow) {
  const thread = { op: 'create', t: 'coachThread', id: 'thread0009', f: { treeId: tree, stepId: null, title: 'What goes in here?' } };
  const question = { op: 'create', t: 'coachMessage', id: 'message0008', f: { threadId: 'thread0009', role: 'person', text: 'What goes in here?', at: deviceNow } };
  const answer = { op: 'create', t: 'coachMessage', id: 'message0009', f: { threadId: 'thread0009', role: 'coach', replica: REPLICA, at: deviceNow } };
  return {
    opened: { op: 'commit', scope: 'self/roadmap', deviceNow, opts: { atomic: true }, changes: [thread, question, answer] },
    ended: { op: 'commit', scope: 'self/roadmap', deviceNow: deviceNow + 1, opts: { atomic: true }, changes: [
      { op: 'update', t: 'coachMessage', id: 'message0009', f: { state: 'completed', text: 'Start with the clouds.' } }] },
    proposed: { op: 'commit', scope: 'self/roadmap', deviceNow: deviceNow + 1, opts: { atomic: true }, changes: [
      { op: 'create', t: 'coachProposal', id: 'proposal0009', f: { treeId: tree, threadId: 'thread0009', messageId: 'message0009', base: [], changes: [], state: 'pending' } },
      { op: 'update', t: 'coachMessage', id: 'message0009', f: { proposalId: 'proposal0009' } }] },
  };
}

export function files() {
  return {
    'roadmap/admit.json': [...commands(), ...visibilities(), ...inverses(), ...consequences(), ...revivals(), ...access(), ...guides(), ...limits(), ...coach(), ...roadmapDeaths()],
    'roadmap/client.json': clientVectors(),
  };
}

