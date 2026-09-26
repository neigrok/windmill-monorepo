// The probe product's server rules (its Appendix A): commands, `check`, and one kept text revision.
// corpus/README.md states the same rules.

import { joinLife } from '../core/merge.js';
import { Refusal } from '../server/admit.js';

function isOpen(run) {
  return run.life[0] === 'alive' && (run.f?.endedAt === undefined || run.f.endedAt[0] === null);
}

export class ProbeProduct {
  constructor() {
    this.revisionsKept = 1;
  }

  receiptsOf(ctx) {
    ctx.productState.receipts ??= {};
    ctx.productState.receipts[ctx.scopeKey] ??= {};
    return ctx.productState.receipts[ctx.scopeKey];
  }

  isReplay(ctx, cmd) {
    if (cmd.name !== 'probe.start') return false;
    return Object.hasOwn(this.receiptsOf(ctx), cmd.args.id);
  }

  runCommand(ctx, cmd) {
    switch (cmd.name) {
      case 'probe.start':
        return this.start(ctx, cmd.args);
      case 'probe.end':
        return this.end(ctx, cmd.args);
      case 'probe.sweep':
        return this.sweep(ctx);
      default:
        throw new Refusal('invalid');
    }
  }

  start(ctx, args) {
    const receipts = this.receiptsOf(ctx);
    if (Object.hasOwn(receipts, args.id)) {
      const resolved = receipts[args.id];
      const run = ctx.stored('run', resolved);
      if (!run || run.life[0] !== 'alive') return { deltas: [], write: [] };
      const entry = { t: 'run', id: resolved, born: run.born };
      if (resolved !== args.id) entry.from = args.id;
      return { deltas: [], write: [entry] };
    }
    const open = ctx.rowsOf('run').find(isOpen);
    if (open) {
      if (args.join !== true) throw new Refusal('invalid');
      receipts[args.id] = open.id;
      return { deltas: [], write: [{ t: 'run', id: open.id, from: args.id, born: open.born }] };
    }
    receipts[args.id] = args.id;
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

  sweep(ctx) {
    const deltas = ctx.rowsOf('run').filter(isOpen)
      .map((run) => ({ t: 'run', id: run.id, born: run.born, f: { endedAt: [ctx.serverNow, null] } }));
    return { deltas, write: [] };
  }

  // Product rules over the intent's applied changes: runs are created only by probe.start, and a run
  // whose joined life is dead kills its alive laps in the same seq. A null (server) stamp is newest.
  check(ctx, changes) {
    const appended = [];
    for (const change of changes) {
      if (change.delta.t !== 'run') continue;
      if (change.op === 'create' && change.source !== 'command') throw new Refusal('invalid');
      if (change.op !== 'delete') continue;
      const { life } = change.delta;
      const joined = life[1] === null ? life : joinLife(ctx.stored('run', change.delta.id)?.life, life);
      if (joined[0] !== 'dead') continue;
      for (const lap of ctx.rowsOf('lap')) {
        if (lap.life[0] !== 'alive' || lap.f?.runId?.[0] !== change.delta.id) continue;
        if (changes.some((other) => other.delta.t === 'lap' && other.delta.id === lap.id)) continue;
        appended.push({ t: 'lap', id: lap.id, born: lap.born, life: ['dead', null] });
      }
    }
    return appended;
  }
}
