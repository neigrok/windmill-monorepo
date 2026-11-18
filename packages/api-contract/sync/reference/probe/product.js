// The probe product's server rules (its Appendix A): commands, `check`, and one kept text revision.
// corpus/README.md states the same rules.

import { sameJson } from '../core/jcs.js';
import { isAlive } from '../core/rows.js';
import { ownValue, setOwn } from '../core/maps.js';
import { evidenceSkip } from '../core/restore.js';
import { Refusal } from '../server/admit.js';

export const TICK_AFTER_MS = 600_000;

function isOpen(run) {
  return run.life[0] === 'alive' && (run.f?.endedAt === undefined || run.f.endedAt[0] === null);
}

function isBranchReplay(ctx, { parent, child, title }) {
  const receipt = ownValue(receipts(ctx, 'branches'), child);
  return receipt !== undefined && sameJson(receipt, { parent, title });
}

// The alive record of type `t` that `holds` picks, the least id first: the subtree a step owns, or the
// tag a label names.
function aliveWhere(ctx, t, holds) {
  return ctx.rowsOf(t).filter((row) => isAlive(row) && holds(row)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

const ownedBy = (step) => (row) => row.f?.parent !== undefined && sameJson(row.f.parent[0], step);
const labelled = (label) => (row) => row.f?.label?.[0] === label;

// A resolution to a record that already exists: `from` the called id when it differs.
function resolvedTo(t, row, called) {
  return { deltas: [], write: [{ t, id: row.id, ...(row.id === called ? {} : { from: called }), born: row.born }] };
}

function receipts(ctx, book) {
  ctx.productState[book] ??= {};
  ctx.productState[book][ctx.scopeKey] ??= {};
  return ctx.productState[book][ctx.scopeKey];
}

export class ProbeProduct {
  constructor() {
    this.revisionsKept = 1;
    this.localCheckTypes = ['run'];
  }

  discoverEffectScopes(ctx, cmd) {
    if (cmd?.name === 'probe.branch') return [`tree:${cmd.args.parent}`, `tree:${cmd.args.child}`];
    if (cmd?.name === 'probe.unbranch') return [`tree:${cmd.args.input.parent}`, `tree:${cmd.args.input.child}`];
    if (cmd?.name !== 'probe.copy' || ownValue(ctx.productState.copies?.[ctx.scopeKey], cmd.args.dst) === cmd.args.src) return [];
    if (ctx.idState('board', cmd.args.dst).state !== 'none') return [];
    return [`tree:${cmd.args.dst}`];
  }

  isReplay(ctx, cmd) {
    if (cmd.name === 'probe.start') return Object.hasOwn(receipts(ctx, 'receipts'), cmd.args.id);
    if (cmd.name === 'probe.copy') return ownValue(receipts(ctx, 'copies'), cmd.args.dst) === cmd.args.src;
    if (cmd.name === 'probe.branch') return isBranchReplay(ctx, cmd.args);
    if (cmd.name === 'probe.sprout') return aliveWhere(ctx, 'board', ownedBy({ board: cmd.args.board, tag: cmd.args.tag })) !== undefined;
    if (cmd.name === 'probe.adopt') return aliveWhere(ctx, 'tag', labelled(cmd.args.label)) !== undefined;
    return false;
  }

  runCommand(ctx, cmd) {
    switch (cmd.name) {
      case 'probe.start':
        return this.start(ctx, cmd.args);
      case 'probe.end':
        return this.end(ctx, cmd.args);
      case 'probe.copy':
        return this.copy(ctx, cmd.args);
      case 'probe.branch':
        return this.branch(ctx, cmd.args);
      case 'probe.sprout':
        return this.sprout(ctx, cmd.args);
      case 'probe.adopt':
        return this.adopt(ctx, cmd.args);
      case 'probe.unbranch':
        return this.unbranch(ctx, cmd.args);
      case 'probe.tick':
        return this.tick(ctx);
      default:
        throw new Refusal('invalid');
    }
  }

  // Creates board `child` and titles both trees. Its receipt `child → {parent, title}` resolves a replay,
  // from any replica, to the board it created.
  branch(ctx, { parent, child, title }) {
    if (isBranchReplay(ctx, { parent, child, title })) {
      const created = ctx.stored('board', child);
      return { deltas: [], write: created && isAlive(created) ? [{ t: 'board', id: child, born: created.born }] : [], detail: { created: false } };
    }
    if (parent === child) throw new Refusal('invalid');
    const existing = ctx.stored('board', child);
    if (existing) throw new Refusal('id-taken');
    setOwn(receipts(ctx, 'branches'), child, { parent, title });
    const board = { t: 'board', id: child, life: ['alive', null], born: null };
    const meta = { t: 'meta', id: 'meta', f: { title: [title, null] } };
    return { deltas: [board], into: [parent, child].map((id) => ({ scopeKey: `tree:${id}`, deltas: [meta] })),
      write: [{ t: 'board', id: child, born: null }], detail: { created: true } };
  }

  // K-3: the inverse of probe.branch, all or nothing. While the created board and its tree are unchanged
  // since the branch, and the parent's title is still the one the branch wrote where it wrote one, the board
  // dies, killing its tree, and the parent takes back its earlier title. The evidence must prove the board
  // and its tree; an owned parent title is restored only when the evidence names it.
  unbranch(ctx, { input: { parent, child, title }, evidence }) {
    const proves = evidence.unchangedCreatedRecords.some(({ record }) => record.scope === 'self/probe' && record.t === 'board' && record.id === child)
      && evidence.unchangedCreatedScopes.some(({ scope }) => scope === `tree/${child}`);
    if (!proves || parent === child) throw new Refusal('invalid');
    const outcome = (s, code) => ({ inverse: { outcomes: [{ index: 0, s, ...(code ? { code } : {}) }] } });
    const skip = evidenceSkip({ epoch: ctx.epoch, row: (scope, t, id) => ctx.storedIn(ctx.keyOf(scope), t, id),
      seq: (scope) => ctx.scope(ctx.keyOf(scope))?.seq ?? null }, evidence);
    if (skip) return { deltas: [], write: [], detail: outcome('skipped', skip) };
    const restoresTitle = evidence.ownedFields.some(({ target }) => target.scope === `tree/${parent}` && target.t === 'meta' && target.slot.name === 'title');
    return {
      deltas: [{ t: 'board', id: child, born: ctx.stored('board', child).born, life: ['dead', null] }],
      into: restoresTitle ? [{ scopeKey: `tree:${parent}`, deltas: [{ t: 'meta', id: 'meta', f: { title: [title, null] } }] }] : [],
      write: [], detail: outcome('applied'),
    };
  }

  // Creates board `child` owned by the step `{board, tag}`, its `parent`. A step that already owns an
  // alive board answers that board, so a retry, or another device's sprout of the same step, resolves
  // to the subtree the step owns. Neither the board nor the tag need exist (E-8).
  sprout(ctx, { board, tag, child }) {
    const owned = aliveWhere(ctx, 'board', ownedBy({ board, tag }));
    if (owned) return resolvedTo('board', owned, child);
    if (ctx.idState('board', child).state !== 'none') throw new Refusal('id-taken');
    return {
      deltas: [{ t: 'board', id: child, life: ['alive', null], born: null, f: { parent: [{ board, tag }, null] } }],
      write: [{ t: 'board', id: child, born: null, f: { parent: null } }],
    };
  }

  // Answers the tree's alive tag labelled `label`, else creates tag `tag` with that label: a command
  // whose write map renames a scope-local id.
  adopt(ctx, { tag, label }) {
    const named = aliveWhere(ctx, 'tag', labelled(label));
    if (named) return resolvedTo('tag', named, tag);
    if (ctx.idState('tag', tag).state !== 'none') throw new Refusal('id-taken');
    return {
      deltas: [{ t: 'tag', id: tag, life: ['alive', null], born: null, f: { label: [label, null] } }],
      write: [{ t: 'tag', id: tag, born: null, f: { label: null } }],
    };
  }

  start(ctx, args) {
    const started = receipts(ctx, 'receipts');
    if (Object.hasOwn(started, args.id)) {
      const resolved = started[args.id];
      const run = ctx.stored('run', resolved);
      if (!run || run.life[0] !== 'alive') return { deltas: [], write: [] };
      const entry = { t: 'run', id: resolved, born: run.born };
      if (resolved !== args.id) entry.from = args.id;
      return { deltas: [], write: [entry] };
    }
    const open = ctx.rowsOf('run').find(isOpen);
    if (open) {
      if (args.join !== true) throw new Refusal('invalid');
      setOwn(started, args.id, open.id);
      return { deltas: [], write: [{ t: 'run', id: open.id, from: args.id, born: open.born }] };
    }
    setOwn(started, args.id, args.id);
    const f = { startedAt: [args.startedAt, null] };
    const written = { startedAt: null };
    if (args.label !== undefined) {
      f.label = [args.label, null];
      written.label = null;
    }
    return {
      deltas: [{ t: 'run', id: args.id, life: ['alive', null], born: null, f }],
      write: [{ t: 'run', id: args.id, born: null, f: written }],
    };
  }

  end(ctx, args) {
    const state = ctx.idState('run', args.runId);
    if (state.state === 'none' || state.state === 'foreign') throw new Refusal('unknown-record');
    if (state.state === 'dead') throw new Refusal('record-dead');
    const run = ctx.stored('run', args.runId);
    if (args.endedAt < run.f.startedAt[0]) throw new Refusal('invalid');
    if (!isOpen(run)) return { deltas: [], write: [] };
    return {
      deltas: [{ t: 'run', id: args.runId, born: run.born, f: { endedAt: [args.endedAt, null] } }],
      write: [{ t: 'run', id: args.runId, f: { endedAt: null } }],
    };
  }

  // Creates board `dst` and writes into its new tree (§6.1 step 14) the source tree's title, tags and
  // links as stored; a tag arrives as a create born at its life stamp, so a revived tag keeps its
  // life. An unreadable source answers not-found alike whether absent, dead or private.
  copy(ctx, { src, dst }) {
    const copies = receipts(ctx, 'copies');
    if (ownValue(copies, dst) === src) {
      const board = ctx.stored('board', dst);
      return { deltas: [], write: board && isAlive(board) ? [{ t: 'board', id: dst, born: board.born }] : [] };
    }
    if (!ctx.readableTree(src)) throw new Refusal('not-found');
    if (ctx.idState('board', dst).state !== 'none') throw new Refusal('id-taken');
    setOwn(copies, dst, src);
    const into = [];
    for (const row of ctx.treeRows(src)) {
      if (row.t === 'meta' && row.f?.title) into.push({ t: 'meta', id: row.id, f: { title: row.f.title } });
      if ((row.t === 'tag' || row.t === 'link') && isAlive(row)) {
        const delta = { t: row.t, id: row.id, life: row.life };
        if (row.born !== undefined) delta.born = row.life[1];
        if (row.f) delta.f = row.f;
        into.push(delta);
      }
    }
    return {
      deltas: [{ t: 'board', id: dst, life: ['alive', null], born: null }],
      into: [{ scopeKey: `tree:${dst}`, deltas: into }],
      write: [{ t: 'board', id: dst, born: null }],
    };
  }

  // Runs before every pull of the product scope (beforePull): open runs started TICK_AFTER_MS ago end.
  tick(ctx) {
    const deltas = ctx.rowsOf('run')
      .filter((run) => isOpen(run) && run.f.startedAt[0] <= ctx.serverNow - TICK_AFTER_MS)
      .map((run) => ({ t: 'run', id: run.id, born: run.born, f: { endedAt: [ctx.serverNow, null] } }));
    return { deltas, write: [] };
  }

  // Product rules on the joined records: runs are created only by probe.start, so a create by any
  // other delta is invalid even beside the command; and a run this intent kills kills its alive laps
  // in the same seq, a lap the intent itself deletes included.
  check(ctx, records) {
    const appended = [];
    for (const record of records) {
      if (record.type.type !== 'run') continue;
      if (record.createdBy.some((source) => source !== 'command')) throw new Refusal('invalid');
      if (!record.original || !isAlive(record.original) || isAlive(record.after)) continue;
      for (const lap of ctx.rowsOf('lap')) {
        if (lap.life[0] !== 'alive' || lap.f?.runId?.[0] !== record.after.id) continue;
        appended.push({ t: 'lap', id: lap.id, born: lap.born, life: ['dead', null] });
      }
    }
    return appended;
  }
}
