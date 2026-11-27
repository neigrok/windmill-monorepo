// Roadmap's server rules (engine.md Appendix A.1): its commands and their inverses, the life a change to a step or a
// kind carries, a root's visibility and the reach of its branch, the end of a roadmap with Coach's records about it, the
// owner's workspace and Coach's records.
// corpus/README.md states the same rules.

import { DEFAULT_KINDS } from '../../../genesis.js';
import { compareBytes, utf8 } from '../core/encoding.js';
import { sameJson } from '../core/jcs.js';
import { recordKey } from '../core/rows.js';
import { evidenceSkip } from '../core/restore.js';
import { Refusal } from '../server/admit.js';

export const GENESIS_KINDS = DEFAULT_KINDS.map((kind, index) => ({ ...kind, ord: `a${index}` }));
const MAX_DEPTH = 8;
const OWNER_ONLY = ['pointer', 'subtask', 'stepLink', 'stepNote'];
const WRITER_TERMINAL = ['completed', 'declined', 'failed', 'stopped'];
const FINAL_REGISTERS = ['state', 'text', 'calls', 'receipts'];
const REVIVED_BY_A_CHANGE = ['node', 'kind'];

const valueOf = (record, field) => record?.f?.[field]?.[0];
const present = (record) => record !== undefined && record.life?.[0] === 'alive';
const compareIds = (a, b) => compareBytes(utf8(a), utf8(b));
const accountOf = (ctx) => `acct:${ctx.account}/roadmap`;
const overlayOf = (ctx, tree) => `acct:${ctx.account}/overlay/${tree}`;
const died = (record) => present(record.original) && !present(record.after);
const inverseDetail = (s, code) => ({ inverse: { outcomes: [{ index: 0, s, ...(code ? { code } : {}) }] } });
const skipped = (code) => ({ deltas: [], write: [], detail: inverseDetail('skipped', code) });

// A record of a type with life written whatever its life: a dead one keeps its stored life, so the write revives nothing.
function written(record, f) {
  return { t: record.t, id: record.id, born: record.born, ...(present(record) ? {} : { life: record.life }), f };
}

// The owner's roadmaps as their `tree` records hold them: where a subtree sits, which subtrees a step owns, and what
// lies under a roadmap.
class Roadmaps {
  constructor(rows) {
    this.rows = new Map(rows.map((row) => [row.id, row]));
  }

  placeOf(id) {
    return valueOf(this.rows.get(id), 'parent') ?? null;
  }

  isAlive(id) {
    return present(this.rows.get(id));
  }

  // The alive subtrees `step` of `tree` owns, the least id first.
  ownedBy(tree, step) {
    return [...this.rows.values()]
      .filter((row) => present(row) && sameJson(valueOf(row, 'parent') ?? null, { tree, step }))
      .map((row) => row.id).sort(compareIds);
  }

  // Every alive subtree under `tree`, each after the roadmap that holds its step.
  under(tree) {
    const found = [];
    const holders = [tree];
    while (holders.length) {
      const holder = holders.shift();
      const children = [...this.rows.values()].filter((row) => present(row) && valueOf(row, 'parent')?.tree === holder && row.id !== tree && !found.includes(row.id));
      for (const id of children.map((row) => row.id).sort(compareIds)) {
        found.push(id);
        holders.push(id);
      }
    }
    return found;
  }

  // The subtrees a step owns and every subtree under them: the branch its presence decides.
  branchOf(tree, step) {
    return this.ownedBy(tree, step).flatMap((id) => [id, ...this.under(id)]);
  }

  depthOf(id) {
    let depth = 0;
    for (let place = this.placeOf(id); place !== null && depth <= MAX_DEPTH + 1; place = this.placeOf(place.tree)) depth += 1;
    return depth;
  }
}

// §4 reach over the subtrees given, parents first: a subtree's is its parent's while it and the step that owns it are
// present, and private otherwise. `reachOf(tree)` reads a roadmap's reach and `row(scopeKey, t, id)` a record, as the
// caller leaves them; answers the reach each subtree takes where it changes.
function reaches(roadmaps, subtrees, { reachOf, row }) {
  const settled = new Map();
  const ordered = [...new Set(subtrees)].sort((a, b) => roadmaps.depthOf(a) - roadmaps.depthOf(b) || compareIds(a, b));
  const changed = [];
  for (const id of ordered) {
    const place = roadmaps.placeOf(id);
    const stands = roadmaps.isAlive(id) && place !== null && present(row(`tree:${place.tree}`, 'node', place.step));
    const reach = stands ? settled.get(place.tree) ?? reachOf(place.tree) : 'private';
    settled.set(id, reach);
    if (reach !== reachOf(id)) changed.push({ tree: id, reach });
  }
  return changed;
}

const metaReach = (reach) => ({ t: 'meta', id: 'meta', f: { reach: [reach, null] } });

// The rows of the declared scopes as this intent leaves them: stored, then joined, then what the rules append.
class Outcome {
  constructor(ctx, changes) {
    this.ctx = ctx;
    this.rowsByKey = new Map(changes.map((change) => [`${change.scopeKey}|${recordKey(change.after.t, change.after.id)}`, change.after]));
    this.byScope = {};
    this.appended = [];
  }

  row(scopeKey, t, id) {
    return this.rowsByKey.get(`${scopeKey}|${recordKey(t, id)}`) ?? this.ctx.storedIn(scopeKey, t, id);
  }

  rows(scopeKey, t) {
    const rows = new Map(this.ctx.scopedRows(scopeKey, t).map((row) => [recordKey(t, row.id), row]));
    for (const [key, row] of this.rowsByKey) if (key.startsWith(`${scopeKey}|`) && row.t === t) rows.set(recordKey(t, row.id), row);
    return [...rows.values()];
  }

  append(scopeKey, delta) {
    (this.byScope[scopeKey] ??= []).push(delta);
    this.appended.push({ scopeKey, delta });
    const row = structuredClone(this.row(scopeKey, delta.t, delta.id) ?? { t: delta.t, id: delta.id });
    if (delta.life) row.life = delta.life;
    if (delta.f) row.f = { ...row.f, ...delta.f };
    this.rowsByKey.set(`${scopeKey}|${recordKey(delta.t, delta.id)}`, row);
  }

  kill(scopeKey, row) {
    if (present(this.row(scopeKey, row.t, row.id))) this.append(scopeKey, { t: row.t, id: row.id, born: row.born, life: ['dead', null] });
  }

  // Coach's records of one scope, read once for the intent.
  coach(scopeKey) {
    this.coachRecords ??= new Map();
    if (!this.coachRecords.has(scopeKey)) this.coachRecords.set(scopeKey, new CoachRecords(this, scopeKey));
    return this.coachRecords.get(scopeKey);
  }
}

// Coach's records of one scope as the intent leaves them (Roadmap Coach §9), read once and grouped by what names them:
// each conversation's messages and proposals, each message's write fates, and the conversations and proposals about each
// roadmap. A cascade then costs what it kills. The records a kill leaves keep what names them, so the groups hold.
class CoachRecords {
  constructor(outcome, scopeKey) {
    this.outcome = outcome;
    this.scopeKey = scopeKey;
    const byField = (type, field) => {
      const groups = new Map();
      for (const row of outcome.rows(scopeKey, type).sort((x, y) => compareIds(x.id, y.id))) {
        const key = valueOf(row, field);
        if (typeof key !== 'string') continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      return groups;
    };
    this.messagesOf = byField('coachMessage', 'threadId');
    this.fatesOf = byField('coachWriteFate', 'messageId');
    this.proposalsOf = byField('coachProposal', 'threadId');
    this.conversationsAbout = byField('coachThread', 'treeId');
    this.proposalsAbout = byField('coachProposal', 'treeId');
  }

  // A conversation's death kills its messages, with their write fates, and its proposals.
  endConversation(thread) {
    for (const message of this.messagesOf.get(thread) ?? []) {
      this.outcome.kill(this.scopeKey, message);
      this.endFates(message.id);
    }
    for (const proposal of this.proposalsOf.get(thread) ?? []) this.outcome.kill(this.scopeKey, proposal);
  }

  // A message's death kills its write fates.
  endFates(message) {
    for (const fate of this.fatesOf.get(message) ?? []) this.outcome.kill(this.scopeKey, fate);
  }

  // The conversations about the roadmaps `ended` that stand, each as its own death ends it, then the proposals about them
  // that stand, whatever conversation holds them. A conversation about all roadmaps names none and stays.
  endAbout(ended) {
    const standing = (groups) => ended.flatMap((tree) => groups.get(tree) ?? [])
      .filter((row) => present(this.outcome.row(this.scopeKey, row.t, row.id))).sort((x, y) => compareIds(x.id, y.id));
    for (const thread of standing(this.conversationsAbout)) {
      this.outcome.kill(this.scopeKey, thread);
      this.endConversation(thread.id);
    }
    for (const proposal of standing(this.proposalsAbout)) this.outcome.kill(this.scopeKey, proposal);
  }
}

export class RoadmapProduct {
  constructor() {
    this.revisionsKept = 1;
  }

  // Discovery reads the owner's roadmaps and declares every scope a command or a consequence reads or writes: the
  // branch under a step whose life the intent touches, the branch under a roadmap whose visibility it writes, the scopes
  // a subtree command plants or uproots, and, for a dying root, the overlays and trees of the steps whose pointer opens
  // it.
  discoverEffectScopes(ctx, cmd) {
    const account = accountOf(ctx);
    const roadmaps = new Roadmaps(ctx.scopedRows(account, 'tree'));
    const keys = new Set();
    const alive = (tree) => ctx.scope(`tree:${tree}`)?.state === 'alive';
    const declare = (tree) => { if (alive(tree)) keys.add(`tree:${tree}`); };
    const branch = (tree, step) => { for (const id of roadmaps.branchOf(tree, step)) declare(id); };
    if (ctx.scopeKey.startsWith('tree:')) {
      const tree = ctx.scopeKey.slice('tree:'.length);
      const operations = cmd?.name === 'roadmap.restoreTree' ? cmd.args.operations : [];
      const visible = ctx.deltas.some((delta) => delta.t === 'meta' && Object.hasOwn(delta.f ?? {}, 'visibility'))
        || operations.some((op) => op.t === 'meta' && op.slot?.name === 'visibility');
      if (visible) {
        keys.add(account);
        for (const id of roadmaps.under(tree)) declare(id);
      }
      const restored = operations.filter((op) => op.t === 'node' && (op.kind !== 'field' || op.slot.kind === 'life'));
      const touched = [...ctx.deltas.filter((delta) => delta.t === 'node' && delta.life !== undefined), ...restored];
      if (touched.length) keys.add(account);
      for (const { id } of touched) branch(tree, id);
      return [...keys];
    }
    if (ctx.scopeKey !== account) return [];
    const input = cmd?.args?.input;
    switch (cmd?.name) {
      case 'roadmap.createSubtree':
        keys.add(`tree:${cmd.args.tree}`).add(`tree:${cmd.args.subtree}`).add(overlayOf(ctx, cmd.args.tree));
        branch(cmd.args.tree, cmd.args.step);
        return [...keys];
      case 'roadmap.redoCreateSubtree':
        declare(input.tree);
        keys.add(`tree:${input.subtree}`);
        branch(input.tree, input.step);
        return [...keys];
      case 'roadmap.undoCreateSubtree':
        declare(input.tree);
        declare(input.subtree);
        return [...keys];
      default:
        break;
    }
    const deaths = cmd?.name === 'roadmap.undoCreateRoadmap' ? [input.tree] : ctx.deltas.filter((delta) => delta.t === 'tree' && delta.life?.[0] === 'dead').map((delta) => delta.id);
    const roots = deaths.filter((id) => roadmaps.isAlive(id) && roadmaps.placeOf(id) === null);
    const lost = new Set(roots.flatMap((id) => [id, ...roadmaps.under(id)]));
    for (const tree of [...roadmaps.rows.keys()].filter((id) => roadmaps.isAlive(id) && !lost.has(id)).sort(compareIds)) {
      const overlay = overlayOf(ctx, tree);
      const opening = ctx.scopedRows(overlay, 'pointer').filter((pointer) => present(pointer) && roots.includes(valueOf(pointer, 'opens')));
      if (!opening.length) continue;
      keys.add(overlay);
      declare(tree);
      for (const pointer of opening) branch(tree, pointer.id);
    }
    return [...keys];
  }

  isReplay(ctx, cmd) {
    if (cmd.name !== 'roadmap.createSubtree') return false;
    return new Roadmaps(ctx.rowsOf('tree')).ownedBy(cmd.args.tree, cmd.args.step).length > 0;
  }

  runCommand(ctx, cmd) {
    switch (cmd.name) {
      case 'roadmap.createSubtree':
        return this.createSubtree(ctx, cmd.args);
      case 'roadmap.recolourKind':
        return this.recolourKind(ctx, cmd.args);
      case 'roadmap.undoCreateRoadmap':
        return this.undoCreateRoadmap(ctx, cmd.args);
      case 'roadmap.undoCreateSubtree':
        return this.undoCreateSubtree(ctx, cmd.args);
      case 'roadmap.redoCreateSubtree':
        return this.redoCreateSubtree(ctx, cmd.args);
      default:
        throw new Refusal('invalid');
    }
  }

  // §4 a subtree under a step: its `tree` record with its place, its meta and genesis kinds, and the step's `branch`.
  // A step that already owns a subtree answers it. A step deleted elsewhere is revived, as any change to a step is.
  createSubtree(ctx, { tree, root, step, subtree }) {
    const node = ctx.storedIn(`tree:${tree}`, 'node', step);
    const owned = new Roadmaps(ctx.rowsOf('tree')).ownedBy(tree, step)[0];
    if (owned !== undefined) {
      return {
        deltas: [],
        into: node && !present(node) ? [{ scopeKey: `tree:${tree}`, deltas: [{ t: 'node', id: step, born: node.born, life: ['alive', null] }] }] : [],
        write: [{ t: 'tree', id: owned, ...(owned === subtree ? {} : { from: subtree }), born: ctx.stored('tree', owned).born }],
      };
    }
    if (!node) throw new Refusal('unknown-record');
    const pointer = ctx.storedIn(overlayOf(ctx, tree), 'pointer', step);
    if (present(pointer) && valueOf(pointer, 'opens') != null) throw new Refusal('step-opens-a-tree');
    if (this.depthUnder(ctx, tree) > MAX_DEPTH) throw new Refusal('depth-limit');
    return this.plant(ctx, { tree, root, step, subtree, node });
  }

  depthUnder(ctx, tree) {
    return (valueOf(ctx.storedIn(`tree:${tree}`, 'meta', 'meta'), 'depth') ?? 0) + 1;
  }

  plant(ctx, { tree, root, step, subtree, node }) {
    const holder = ctx.storedIn(`tree:${tree}`, 'meta', 'meta');
    if (root !== (valueOf(holder, 'root') ?? tree)) throw new Refusal('invalid');
    if (ctx.idState('tree', subtree).state !== 'none') throw new Refusal('id-taken');
    const place = { tree, step };
    const kinds = GENESIS_KINDS.map(({ id, ...values }) => ({
      t: 'kind', id, born: null, life: ['alive', null], f: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, [value, null]])),
    }));
    const meta = { t: 'meta', id: 'meta', f: { root: [root, null], parent: [place, null], depth: [this.depthUnder(ctx, tree), null], reach: [valueOf(holder, 'reach') ?? 'private', null] } };
    return {
      deltas: [{ t: 'tree', id: subtree, born: null, life: ['alive', null], f: { parent: [place, null] } }],
      into: [
        { scopeKey: `tree:${tree}`, deltas: [{ t: 'node', id: step, born: node.born, ...(present(node) ? {} : { life: ['alive', null] }), f: { branch: [subtree, null] } }] },
        { scopeKey: `tree:${subtree}`, deltas: [meta, ...kinds] },
      ],
      write: [{ t: 'tree', id: subtree, born: null, f: { parent: null } }],
    };
  }

  // §4 a kind's hue and the colour of every step that wears it, present or not. A kind deleted elsewhere is revived; no
  // step is.
  recolourKind(ctx, { kind, hue }) {
    const record = ctx.stored('kind', kind);
    if (!record) throw new Refusal('unknown-record');
    const before = valueOf(record, 'hue') ?? 'terracotta';
    if (before === hue) return { deltas: [], write: [] };
    const wearers = ctx.rowsOf('node').filter((node) => (valueOf(node, 'color') ?? 'terracotta') === before).sort((a, b) => compareIds(a.id, b.id));
    return {
      deltas: [
        { t: 'kind', id: kind, born: record.born, ...(present(record) ? {} : { life: ['alive', null] }), f: { hue: [hue, null] } },
        ...wearers.map((node) => written(node, { color: [hue, null] })),
      ],
      write: [],
    };
  }

  // A product inverse's evidence against the declared scopes as stored: a row of a scope not declared or not alive reads
  // absent, so evidence there no longer holds.
  evidenceSkipOf(ctx, evidence) {
    const readable = (key) => key !== null && ctx.declared(key) && ctx.scope(key)?.state === 'alive';
    return evidenceSkip({
      epoch: ctx.epoch,
      row: (scope, t, id) => (readable(ctx.keyOf(scope)) ? ctx.storedIn(ctx.keyOf(scope), t, id) : undefined),
      seq: (scope) => ctx.scope(ctx.keyOf(scope))?.seq ?? null,
    }, evidence);
  }

  // K-3: Undo of creating a roadmap. While its record, its tree scope and its owner's overlay of it are as the creation
  // left them, the roadmap dies as any root dies (§4's consequences).
  undoCreateRoadmap(ctx, { input: { tree }, evidence }) {
    const proves = evidence.unchangedCreatedRecords.some(({ record }) => sameJson(record, { scope: 'self/roadmap', t: 'tree', id: tree }))
      && evidence.unchangedCreatedScopes.some(({ scope }) => scope === `tree/${tree}`);
    if (!proves) throw new Refusal('invalid');
    const skip = this.evidenceSkipOf(ctx, evidence);
    if (skip) return skipped(skip);
    const record = ctx.stored('tree', tree);
    if (valueOf(record, 'parent') != null) throw new Refusal('not-a-root');
    if ((ctx.scope(overlayOf(ctx, tree))?.seq ?? 0) > 0) return skipped('scope-changed');
    return { deltas: [{ t: 'tree', id: tree, born: record.born, life: ['dead', null] }], write: [], detail: inverseDetail('applied') };
  }

  // R-8 Undo of creating a subtree: while the step's `branch` is the act's, and the subtree's record, its tree scope and
  // its owner's overlay are as the creation left them, the subtree dies and the step's `branch` clears, together.
  undoCreateSubtree(ctx, { input: { tree, step, subtree }, evidence }) {
    const proves = evidence.ownedFields.some(({ target }) => sameJson(target, { scope: `tree/${tree}`, t: 'node', id: step, slot: { kind: 'field', name: 'branch' } }))
      && evidence.unchangedCreatedRecords.some(({ record }) => sameJson(record, { scope: 'self/roadmap', t: 'tree', id: subtree }))
      && evidence.unchangedCreatedScopes.some(({ scope }) => scope === `tree/${subtree}`);
    if (!proves) throw new Refusal('invalid');
    const skip = this.evidenceSkipOf(ctx, evidence);
    if (skip) return skipped(skip);
    const record = ctx.stored('tree', subtree);
    if (!sameJson(valueOf(record, 'parent') ?? null, { tree, step })) throw new Refusal('invalid');
    if ((ctx.scope(overlayOf(ctx, subtree))?.seq ?? 0) > 0) return skipped('scope-changed');
    return {
      deltas: [{ t: 'tree', id: subtree, born: record.born, life: ['dead', null] }],
      into: [{ scopeKey: `tree:${tree}`, deltas: [written(ctx.storedIn(`tree:${tree}`, 'node', step), { branch: [null, null] })] }],
      write: [],
      detail: inverseDetail('applied'),
    };
  }

  // R-8 Redo: while the step's `branch` is still the one the Undo wrote, a new subtree under a fresh id, planted as
  // createSubtree plants it; otherwise nothing.
  redoCreateSubtree(ctx, { input: { tree, root, step, subtree }, evidence }) {
    if (!evidence.ownedFields.some(({ target }) => sameJson(target, { scope: `tree/${tree}`, t: 'node', id: step, slot: { kind: 'field', name: 'branch' } }))) throw new Refusal('invalid');
    const skip = this.evidenceSkipOf(ctx, evidence);
    if (skip) return skipped(skip);
    return { ...this.plant(ctx, { tree, root, step, subtree, node: ctx.storedIn(`tree:${tree}`, 'node', step) }), detail: inverseDetail('applied') };
  }

  // §6.1 step 10 on the joined records: each type's rule, then §5's revival, then §4's consequences.
  effects(ctx, changes) {
    const outcome = new Outcome(ctx, changes);
    for (const record of changes) RULES[record.type.type]?.(ctx, record, outcome);
    this.revive(ctx, outcome);
    if (ctx.originScopeKey === accountOf(ctx)) this.endBranches(ctx, changes, outcome);
    this.settleVisibility(ctx, changes, outcome);
    this.settleReach(ctx, changes, outcome);
    return { byScope: outcome.byScope };
  }

  // §5: a change to a step or a kind carries its life as alive; one that is still dead once it has joined, the delete
  // being newer, the server revives.
  revive(ctx, outcome) {
    for (const delta of ctx.deltas) {
      if (!REVIVED_BY_A_CHANGE.includes(delta.t) || delta.life?.[0] !== 'alive') continue;
      const row = outcome.row(ctx.originScopeKey, delta.t, delta.id);
      if (!present(row)) outcome.append(ctx.originScopeKey, { t: delta.t, id: delta.id, born: row.born, life: ['alive', null] });
    }
  }

  // §4: a roadmap's death kills every subtree under it, and a root's deletes each step of the owner's other roadmaps
  // whose pointer opens it. Roadmap Coach §9: each roadmap that dies so takes the conversations about it, as their own
  // deaths would, and the proposals about it.
  endBranches(ctx, changes, outcome) {
    const account = accountOf(ctx);
    const roadmaps = new Roadmaps(outcome.rows(account, 'tree'));
    const deaths = changes.filter((record) => record.scopeKey === account && record.type.type === 'tree' && died(record));
    const ended = [];
    for (const death of deaths) {
      ended.push(death.after.id);
      for (const id of roadmaps.under(death.after.id)) {
        outcome.kill(account, roadmaps.rows.get(id));
        ended.push(id);
      }
    }
    if (ended.length) outcome.coach(account).endAbout(ended);
    const roots = deaths.filter((record) => valueOf(record.original, 'parent') == null).map((record) => record.after.id);
    if (!roots.length) return;
    const standing = outcome.rows(account, 'tree').filter(present).map((row) => row.id).sort(compareIds);
    for (const tree of standing) {
      const overlay = overlayOf(ctx, tree);
      if (!ctx.declared(overlay)) continue;
      const opening = ctx.scopedRows(overlay, 'pointer').filter((pointer) => present(pointer) && roots.includes(valueOf(pointer, 'opens')));
      for (const pointer of opening.sort((a, b) => compareIds(a.id, b.id))) {
        const node = outcome.row(`tree:${tree}`, 'node', pointer.id);
        if (node) outcome.kill(`tree:${tree}`, node);
      }
    }
  }

  // §4: a root's reach is its visibility, so a change of the visibility, by the owner's write or an Undo's restore,
  // writes the root's reach and the reach of every subtree under it, standing ones taking the visibility.
  settleVisibility(ctx, changes, outcome) {
    if (!ctx.originScopeKey.startsWith('tree:')) return;
    const record = changes.find((change) => change.scopeKey === ctx.originScopeKey && change.type.type === 'meta');
    const visibility = valueOf(record?.after, 'visibility') ?? 'private';
    if (!record || visibility === (valueOf(record.original, 'visibility') ?? 'private')) return;
    const tree = ctx.originScopeKey.slice('tree:'.length);
    if ((valueOf(record.after, 'reach') ?? 'private') !== visibility) outcome.append(record.scopeKey, metaReach(visibility));
    const roadmaps = new Roadmaps(outcome.rows(accountOf(ctx), 'tree'));
    const reachOf = (id) => valueOf(outcome.row(`tree:${id}`, 'meta', 'meta'), 'reach') ?? 'private';
    for (const { tree: id, reach } of reaches(roadmaps, roadmaps.under(tree), { reachOf, row: (scopeKey, t, id) => outcome.row(scopeKey, t, id) })) {
      outcome.append(`tree:${id}`, metaReach(reach));
    }
  }

  // §4: a step's death that ends a subtree's standing writes `reach` private on every subtree under it, and its revival
  // writes the reach of the roadmap above back.
  settleReach(ctx, changes, outcome) {
    const steps = [
      ...changes.filter((record) => record.type.type === 'node').map((record) => ({ scopeKey: record.scopeKey, id: record.after.id })),
      ...outcome.appended.filter(({ delta }) => delta.t === 'node').map(({ scopeKey, delta }) => ({ scopeKey, id: delta.id })),
    ];
    const flipped = steps.filter(({ scopeKey, id }) => present(ctx.storedIn(scopeKey, 'node', id)) !== present(outcome.row(scopeKey, 'node', id)));
    if (!flipped.length) return;
    const roadmaps = new Roadmaps(outcome.rows(accountOf(ctx), 'tree'));
    const subtrees = flipped.flatMap(({ scopeKey, id }) => roadmaps.branchOf(scopeKey.slice('tree:'.length), id));
    const reachOf = (id) => valueOf(outcome.row(`tree:${id}`, 'meta', 'meta'), 'reach') ?? 'private';
    for (const { tree, reach } of reaches(roadmaps, subtrees, { reachOf, row: (scopeKey, t, id) => outcome.row(scopeKey, t, id) })) {
      outcome.append(`tree:${tree}`, metaReach(reach));
    }
  }
}

// One rule a type, on a joined record of this intent.
const RULES = {
  // Only a root is deleted by a person: a subtree goes with the step that owns it.
  tree(ctx, record) {
    if (ctx.origin !== 'replica' || !died(record) || valueOf(record.original, 'parent') == null) return;
    if (ctx.deltas.some((delta) => delta.t === 'tree' && delta.id === record.after.id && delta.life?.[0] === 'dead')) throw new Refusal('not-a-root');
  },

  // Only a root has a visibility; the owner's guide replaces one a fork inherited, unless the same intent says it is
  // inherited.
  meta(ctx, record, outcome) {
    const visible = record.scopeKey === ctx.originScopeKey && ctx.deltas.some((delta) => delta.t === 'meta' && Object.hasOwn(delta.f ?? {}, 'visibility'));
    if (visible && valueOf(ctx.storedIn(accountOf(ctx), 'tree', record.scopeKey.slice('tree:'.length)), 'parent') != null) throw new Refusal('not-a-root');
    if (sameJson(record.original?.f?.guide ?? null, record.after.f?.guide ?? null) || valueOf(record.after, 'guideInherited') !== true) return;
    if (ctx.deltas.some((delta) => delta.t === 'meta' && Object.hasOwn(delta.f ?? {}, 'guideInherited'))) return;
    outcome.append(record.scopeKey, { t: 'meta', id: 'meta', f: { guideInherited: [false, null] } });
  },

  ...Object.fromEntries(OWNER_ONLY.map((type) => [type, ownersOnly])),

  // Coach's conversation (Roadmap Coach §9): its death kills its messages, with their write fates, and its proposals.
  coachThread(ctx, record, outcome) {
    if (died(record)) outcome.coach(record.scopeKey).endConversation(record.after.id);
  },

  // A message's death kills its write fates; once its writer has ended the turn, its state, text, calls and receipts are
  // final.
  coachMessage(ctx, record, outcome) {
    if (died(record)) return outcome.coach(record.scopeKey).endFates(record.after.id);
    const ended = present(record.original) && WRITER_TERMINAL.includes(valueOf(record.original, 'state'));
    const writes = ctx.deltas.filter((delta) => delta.t === 'coachMessage' && delta.id === record.after.id).flatMap((delta) => Object.keys(delta.f ?? {}));
    if (ended && writes.some((name) => FINAL_REGISTERS.includes(name))) throw new Refusal('turn-final');
  },
};

// R-3: a pointer and the workspace are admitted only in the overlay of the roadmap's owner.
function ownersOnly(ctx, record) {
  const overlay = ctx.scope(record.scopeKey);
  if (ctx.scope(overlay.governedBy)?.owner !== overlay.owner) throw new Refusal('forbidden');
}
