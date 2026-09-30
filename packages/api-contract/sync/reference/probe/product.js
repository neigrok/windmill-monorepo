// The probe product's server rules (its Appendix A): commands, `check`, and one kept text revision.
// corpus/README.md states the same rules.

import { isAlive } from '../core/rows.js';
import { Refusal } from '../server/admit.js';

export const TICK_AFTER_MS = 600_000;

function isOpen(run) {
  return run.life[0] === 'alive' && (run.f?.endedAt === undefined || run.f.endedAt[0] === null);
}

function receipts(ctx, book) {
  ctx.productState[book] ??= {};
  ctx.productState[book][ctx.scopeKey] ??= {};
  return ctx.productState[book][ctx.scopeKey];
}

export class ProbeProduct {
  constructor() {
    this.revisionsKept = 1;
  }

  isReplay(ctx, cmd) {
    if (cmd.name === 'probe.start') return Object.hasOwn(receipts(ctx, 'receipts'), cmd.args.id);
    if (cmd.name === 'probe.copy') return receipts(ctx, 'copies')[cmd.args.dst] === cmd.args.src;
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
      case 'probe.tick':
        return this.tick(ctx);
      default:
        throw new Refusal('invalid');
    }
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
      started[args.id] = open.id;
      return { deltas: [], write: [{ t: 'run', id: open.id, from: args.id, born: open.born }] };
    }
    started[args.id] = args.id;
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
    if (copies[dst] === src) {
      const board = ctx.stored('board', dst);
      return { deltas: [], write: board && isAlive(board) ? [{ t: 'board', id: dst, born: board.born }] : [] };
    }
    if (!ctx.readableTree(src)) throw new Refusal('not-found');
    if (ctx.idState('board', dst).state !== 'none') throw new Refusal('id-taken');
    copies[dst] = src;
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
