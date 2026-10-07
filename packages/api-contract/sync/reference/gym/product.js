// Gym's commands and joined-record checks, including R118's server-authored metadata.

import { sameJson } from '../core/jcs.js';
import { ownValue, setOwn } from '../core/maps.js';
import { isAlive } from '../core/rows.js';
import { Refusal } from '../server/admit.js';

export const STALE_MS = 4 * 3_600_000;
export const MAX_ALIASES = 5;
const DAY_MS = 86_400_000;
const MAX_SET_NUMBER = 2_147_483_647;

function valueOf(record, field) {
  return record?.f?.[field]?.[0];
}

function isSet(value) {
  return value !== undefined && value !== null;
}

// A proposal's state: unset reads as `pending`, the registry's default.
function stateOf(proposal) {
  return valueOf(proposal, 'state') ?? 'pending';
}

// The product state's book of one kind for the intent's scope: receipts and projections.
function book(ctx, name) {
  ctx.productState[name] ??= {};
  ctx.productState[name][ctx.scopeKey] ??= {};
  return ctx.productState[name][ctx.scopeKey];
}

function isOpen(session) {
  return session !== undefined && isAlive(session) && !isSet(valueOf(session, 'finishedAt'));
}

// A session's last activity: its last alive set's completedAt, else its startedAt.
function lastActivity(ctx, session) {
  const done = ctx.rowsOf('set')
    .filter((set) => isAlive(set) && valueOf(set, 'sessionId') === session.id)
    .map((set) => valueOf(set, 'completedAt'));
  return done.length ? Math.max(...done) : valueOf(session, 'startedAt');
}

function isStale(ctx, session) {
  return ctx.serverNow - lastActivity(ctx, session) >= STALE_MS;
}

// A.2 `gym.closeStale`: the open session whose last activity is 4 h or more before serverNow closes at it.
function staleClose(ctx) {
  const open = ctx.rowsOf('session').find(isOpen);
  if (!open || !isStale(ctx, open)) return [];
  return [{ t: 'session', id: open.id, born: open.born, f: { finishedAt: [lastActivity(ctx, open), null], closedBy: ['stale', null] } }];
}

// The session plan a start freezes: the routine's name and its entries as they stand.
function planOf(routine) {
  return { routine: valueOf(routine, 'name'), entries: valueOf(routine, 'entries') };
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// A session's span, an empty one taking up its first instant, as gym's crossedBy reads it.
function spanOf(startedAt, finishedAt) {
  return [startedAt, Math.max(finishedAt ?? startedAt, startedAt + 1)];
}

function proposalChanges(base, proposed) {
  const matched = new Set();
  const side = ({ exerciseId, ...targets }) => targets;
  const changes = proposed.map((entry) => {
    const at = base.findIndex((line, i) => !matched.has(i) && line.exerciseId === entry.exerciseId);
    const after = side(entry);
    if (at === -1) return { kind: 'added', exerciseId: entry.exerciseId, after };
    matched.add(at);
    const before = side(base[at]);
    return { kind: sameJson(before, after) ? 'kept' : 'retargeted', exerciseId: entry.exerciseId, before, after };
  });
  base.forEach((entry, i) => {
    if (!matched.has(i)) changes.push({ kind: 'removed', exerciseId: entry.exerciseId, before: side(entry) });
  });
  return changes;
}

export class GymProduct {
  constructor() {
    this.revisionsKept = 1;
  }

  // §2.3 `elsewhere`: a seed exercise is held outside every scope, so its id is `foreign` to every account.
  elsewhere(productState, t, id) {
    return t === 'exercise' && Object.hasOwn(productState.seeds ?? {}, id);
  }

  isReplay(ctx, cmd) {
    switch (cmd.name) {
      case 'gym.start':
        return Object.hasOwn(book(ctx, 'starts'), cmd.args.id);
      case 'gym.importSession':
        return Object.hasOwn(book(ctx, 'imports'), cmd.args.id);
      case 'gym.correctSession':
        return Object.hasOwn(book(ctx, 'corrections'), cmd.args.requestId);
      default:
        return false;
    }
  }

  runCommand(ctx, cmd) {
    switch (cmd.name) {
      case 'gym.start':
        return this.start(ctx, cmd.args);
      case 'gym.importSession':
        return this.importSession(ctx, cmd.args);
      case 'gym.correctSession':
        return this.correctSession(ctx, cmd.args);
      case 'gym.finish':
        return this.finish(ctx, cmd.args);
      case 'gym.applyProposal':
        return this.applyProposal(ctx, cmd.args);
      case 'gym.dismissProposal':
        return this.dismissProposal(ctx, cmd.args);
      case 'gym.closeStale':
        return { deltas: staleClose(ctx), write: [] };
      default:
        throw new Refusal('invalid');
    }
  }

  // A receipt for `id`, or the caller's own session under `id`, answers first; then the open session,
  // joined or refused; then the create, whose identity §4.3 decides.
  start(ctx, args) {
    const deltas = staleClose(ctx);
    const closed = new Set(deltas.map((delta) => delta.id));
    const starts = book(ctx, 'starts');
    const resolved = ownValue(starts, args.id) ?? (ctx.stored('session', args.id) ? args.id : undefined);
    if (resolved !== undefined) {
      const session = ctx.stored('session', resolved);
      if (!session || !isAlive(session)) return { deltas, write: [] };
      const entry = { t: 'session', id: resolved, born: session.born };
      if (resolved !== args.id) entry.from = args.id;
      return { deltas, write: [entry] };
    }
    const open = ctx.rowsOf('session').find((session) => isOpen(session) && !closed.has(session.id));
    if (open) {
      if (args.joinOpenSession !== true) throw new Refusal('session-open');
      setOwn(starts, args.id, open.id);
      return { deltas, write: [{ t: 'session', id: open.id, from: args.id, born: open.born }] };
    }
    const f = { startedAt: [args.startedAt, null] };
    if (args.routineId !== undefined) {
      const routine = ctx.stored('routine', args.routineId);
      const readable = routine !== undefined && isAlive(routine);
      f.routineId = [readable ? args.routineId : null, null];
      f.plan = [readable ? planOf(routine) : null, null];
      if (readable) f.historyRoutineId = [args.routineId, null];
    }
    setOwn(starts, args.id, args.id);
    const written = Object.fromEntries(Object.keys(f).map((name) => [name, null]));
    return {
      deltas: [...deltas, { t: 'session', id: args.id, life: ['alive', null], born: null, f }],
      write: [{ t: 'session', id: args.id, born: null, f: written }],
    };
  }

  // The write map of a replayed session command: the session and its sets, those still alive.
  replayWrite(ctx, sessionId, setIds) {
    const write = [];
    const session = ctx.stored('session', sessionId);
    if (session && isAlive(session)) write.push({ t: 'session', id: sessionId, born: session.born });
    for (const id of setIds) {
      const set = ctx.stored('set', id);
      if (set && isAlive(set)) write.push({ t: 'set', id, born: set.born });
    }
    return write;
  }

  // The finished session a crossing names: the earliest other finished session whose span crosses.
  crossing(ctx, sessionId, startedAt, finishedAt) {
    const [start, end] = spanOf(startedAt, finishedAt);
    const crossed = ctx.rowsOf('session')
      .filter((session) => isAlive(session) && session.id !== sessionId && isSet(valueOf(session, 'finishedAt')))
      .filter((session) => {
        const [otherStart, otherEnd] = spanOf(valueOf(session, 'startedAt'), valueOf(session, 'finishedAt'));
        return otherStart < end && start < otherEnd;
      })
      .sort((a, b) => valueOf(a, 'startedAt') - valueOf(b, 'startedAt') || (a.id < b.id ? -1 : 1));
    return crossed[0];
  }

  checkSetIds(sets) {
    const ids = sets.map((set) => set.id);
    if (new Set(ids).size !== ids.length) throw new Refusal('invalid');
  }

  importSession(ctx, args) {
    const deltas = staleClose(ctx);
    const imports = book(ctx, 'imports');
    if (Object.hasOwn(imports, args.id)) {
      if (!sameJson(imports[args.id], args)) throw new Refusal('payload-conflict');
      return { deltas, write: this.replayWrite(ctx, args.id, args.sets.map((set) => set.id)) };
    }
    const state = ctx.idState('session', args.id);
    if (state.state === 'alive' || state.state === 'dead') throw new Refusal('payload-conflict');
    if (state.state === 'foreign') throw new Refusal('id-taken');
    this.checkSetIds(args.sets);
    if (args.finishedAt < args.startedAt || args.finishedAt > ctx.serverNow) throw new Refusal('bad-instant');
    if (args.sets.some((set) => set.completedAt < args.startedAt || set.completedAt > args.finishedAt)) throw new Refusal('bad-instant');
    const crossed = this.crossing(ctx, args.id, args.startedAt, args.finishedAt);
    if (crossed) throw new Refusal('session-overlap', { sessionId: crossed.id });
    const f = { startedAt: [args.startedAt, null], finishedAt: [args.finishedAt, null], closedBy: ['finish', null] };
    if (args.routineId !== undefined) {
      const routine = ctx.stored('routine', args.routineId);
      const readable = routine !== undefined && isAlive(routine);
      f.routineId = [readable ? args.routineId : null, null];
      f.plan = [readable ? planOf(routine) : null, null];
      if (readable) f.historyRoutineId = [args.routineId, null];
    }
    setOwn(imports, args.id, structuredClone(args));
    const setDeltas = args.sets.map((set) => ({ t: 'set', id: set.id, life: ['alive', null], born: null, f: this.setFields(args.id, set, 'working') }));
    return {
      deltas: [...deltas, { t: 'session', id: args.id, life: ['alive', null], born: null, f }, ...setDeltas],
      write: [
        { t: 'session', id: args.id, born: null, f: Object.fromEntries(Object.keys(f).map((name) => [name, null])) },
        ...setDeltas.map((delta) => ({ t: 'set', id: delta.id, born: null, f: Object.fromEntries(Object.keys(delta.f).map((name) => [name, null])) })),
      ],
    };
  }

  setFields(sessionId, set, kind) {
    const f = {
      sessionId: [sessionId, null],
      exerciseId: [set.exerciseId, null],
      weightKg: [set.weightKg, null],
      reps: [set.reps, null],
      kind: [set.kind ?? kind, null],
      note: [set.note ?? '', null],
      completedAt: [set.completedAt, null],
    };
    if (set.rpe !== undefined) f.rpe = [set.rpe, null];
    return f;
  }

  // Corrects a finished workout; preserveOtherSets keeps the sets it leaves out.
  correctSession(ctx, args) {
    const state = ctx.idState('session', args.sessionId);
    if (state.state === 'none' || state.state === 'foreign') throw new Refusal('unknown-record');
    if (state.state === 'dead') throw new Refusal('record-dead');
    const corrections = book(ctx, 'corrections');
    if (Object.hasOwn(corrections, args.requestId)) {
      const receipt = corrections[args.requestId];
      if (receipt.sessionId !== args.sessionId || !sameJson(receipt.args, args)) throw new Refusal('payload-conflict');
      return { deltas: [], write: this.replayWrite(ctx, args.sessionId, args.sets.map((set) => set.id)) };
    }
    const session = ctx.stored('session', args.sessionId);
    if (!isSet(valueOf(session, 'finishedAt'))) throw new Refusal('session-open');
    if (args.sets.length === 0) throw new Refusal('invalid');
    this.checkSetIds(args.sets);
    const numbers = args.sets.map((set) => `${set.exerciseId}#${set.setNumber}`);
    if (new Set(numbers).size !== numbers.length) throw new Refusal('invalid');
    if (args.finishedAt < args.startedAt || args.finishedAt > ctx.serverNow) throw new Refusal('bad-instant');
    if (args.sets.some((set) => set.completedAt < args.startedAt || set.completedAt > args.finishedAt)) throw new Refusal('bad-instant');
    const crossed = this.crossing(ctx, args.sessionId, args.startedAt, args.finishedAt);
    if (crossed) throw new Refusal('session-overlap', { sessionId: crossed.id });
    const standing = new Map(ctx.rowsOf('set')
      .filter((set) => isAlive(set) && valueOf(set, 'sessionId') === args.sessionId)
      .map((set) => [set.id, set]));
    const named = new Set(args.sets.map((set) => set.id));
    if (args.preserveOtherSets === true) {
      for (const [id, set] of standing) {
        if (named.has(id)) continue;
        if (valueOf(set, 'completedAt') < args.startedAt || valueOf(set, 'completedAt') > args.finishedAt) throw new Refusal('bad-instant');
        const number = `${valueOf(set, 'exerciseId')}#${set.v.setNumber}`;
        if (numbers.includes(number)) throw new Refusal('invalid');
        numbers.push(number);
      }
    }
    const deltas = [];
    const write = [];
    const sessionFields = {
      startedAt: [args.startedAt, null],
      finishedAt: [args.finishedAt, null],
      closedBy: ['finish', null],
      displayName: [args.routineName, null],
    };
    deltas.push({ t: 'session', id: args.sessionId, born: session.born, f: sessionFields });
    write.push({ t: 'session', id: args.sessionId, f: Object.fromEntries(Object.keys(sessionFields).map((name) => [name, null])) });
    for (const set of args.sets) {
      const prior = standing.get(set.id);
      if (prior) {
        if (valueOf(prior, 'exerciseId') !== set.exerciseId) throw new Refusal('invalid');
        const f = { weightKg: [set.weightKg, null], reps: [set.reps, null], completedAt: [set.completedAt, null] };
        if (set.rpe !== undefined) f.rpe = [set.rpe, null];
        if (set.note !== undefined) f.note = [set.note, null];
        deltas.push({ t: 'set', id: set.id, born: prior.born, f, v: { setNumber: set.setNumber } });
        write.push({ t: 'set', id: set.id, f: Object.fromEntries(Object.keys(f).map((name) => [name, null])) });
      } else {
        const f = this.setFields(args.sessionId, set, 'working');
        deltas.push({ t: 'set', id: set.id, life: ['alive', null], born: null, f, v: { setNumber: set.setNumber } });
        write.push({ t: 'set', id: set.id, born: null, f: Object.fromEntries(Object.keys(f).map((name) => [name, null])) });
      }
    }
    if (args.preserveOtherSets !== true) for (const [id, set] of standing) {
      if (!named.has(id)) deltas.push({ t: 'set', id, born: set.born, life: ['dead', null] });
    }
    setOwn(corrections, args.requestId, { sessionId: args.sessionId, args: structuredClone(args) });
    return { deltas, write };
  }

  finish(ctx, { sessionId, finishedAt }) {
    const state = ctx.idState('session', sessionId);
    if (state.state === 'none' || state.state === 'foreign') throw new Refusal('unknown-record');
    if (state.state === 'dead') throw new Refusal('record-dead');
    const session = ctx.stored('session', sessionId);
    if (finishedAt === 0 || finishedAt < valueOf(session, 'startedAt')) throw new Refusal('bad-instant');
    const stored = valueOf(session, 'finishedAt');
    if (isSet(stored) && valueOf(session, 'closedBy') !== 'stale') return { deltas: [], write: [] };
    const at = !isSet(stored) ? finishedAt : finishedAt > stored + STALE_MS ? stored : Math.max(stored, finishedAt);
    return {
      deltas: [{ t: 'session', id: sessionId, born: session.born, f: { finishedAt: [at, null], closedBy: ['finish', null] } }],
      write: [{ t: 'session', id: sessionId, f: { finishedAt: null, closedBy: null } }],
    };
  }

  // Why a superseded proposal was superseded, in today's order: a newer proposal replaced it; else its
  // routine's revision moved past its base; else it was superseded before either was recorded.
  supersededReason(ctx, proposal) {
    if (isSet(valueOf(proposal, 'supersededBy'))) return 'replaced';
    const routineId = valueOf(proposal, 'routineId');
    if (valueOf(ctx.stored('routine', routineId), 'revision') !== valueOf(proposal, 'baseRevision')) return 'routine-changed';
    return 'superseded';
  }

  settleable(ctx, proposalId) {
    const state = ctx.idState('proposal', proposalId);
    if (state.state === 'none' || state.state === 'foreign') throw new Refusal('unknown-record');
    if (state.state === 'dead') throw new Refusal('record-dead');
    return ctx.stored('proposal', proposalId);
  }

  applyProposal(ctx, { proposalId }) {
    const proposal = this.settleable(ctx, proposalId);
    const state = stateOf(proposal);
    if (state === 'applied') return { deltas: [], write: [] };
    if (state === 'dismissed') throw new Refusal('proposal-settled', { state });
    if (state === 'superseded') throw new Refusal('proposal-superseded', { reason: this.supersededReason(ctx, proposal) });
    const routineId = valueOf(proposal, 'routineId');
    if (valueOf(ctx.stored('routine', routineId), 'revision') !== valueOf(proposal, 'baseRevision')) throw new Refusal('proposal-superseded', { reason: 'routine-changed' });
    const routine = ctx.stored('routine', routineId);
    const settle = { t: 'proposal', id: proposalId, born: proposal.born, f: { state: ['applied', null], settledAt: [ctx.serverNow, null] } };
    if (valueOf(proposal, 'intent') === 'remove') {
      return { deltas: [settle, { t: 'routine', id: routineId, born: routine.born, life: ['dead', null] }], write: [] };
    }
    const entries = valueOf(proposal, 'changes')
      .filter((change) => change.kind !== 'removed')
      .map((change) => ({ exerciseId: change.exerciseId, ...change.after }));
    return {
      deltas: [settle, { t: 'routine', id: routineId, born: routine.born, f: { name: [valueOf(proposal, 'proposedName'), null], entries: [entries, null] } }],
      write: [
        { t: 'proposal', id: proposalId, f: { state: null, settledAt: null } },
        { t: 'routine', id: routineId, f: { name: null, entries: null } },
      ],
    };
  }

  dismissProposal(ctx, { proposalId }) {
    const proposal = this.settleable(ctx, proposalId);
    const state = stateOf(proposal);
    if (state === 'dismissed') return { deltas: [], write: [] };
    if (state === 'applied') throw new Refusal('proposal-settled', { state });
    if (state === 'superseded') throw new Refusal('proposal-superseded', { reason: this.supersededReason(ctx, proposal) });
    return {
      deltas: [{ t: 'proposal', id: proposalId, born: proposal.born, f: { state: ['dismissed', null], settledAt: [ctx.serverNow, null] } }],
      write: [{ t: 'proposal', id: proposalId, f: { state: null, settledAt: null } }],
    };
  }

  // Product rules on the joined records, record by record in intent order; the deltas they append are
  // the rules' server writes and the consequences of a death (§2.2).
  check(ctx, records) {
    const metadata = { routine: ['revision', 'createdEntries'], proposal: ['baseRevision', 'baseName', 'changeCount'], note: ['updatedAt'] };
    for (const delta of ctx.deltas) {
      if (delta.t === 'routineCreation' || (metadata[delta.t] ?? []).some((field) => Object.hasOwn(delta.f ?? {}, field))) throw new Refusal('invalid');
    }
    const key = (t, id) => `${t}|${JSON.stringify(id)}`;
    const joined = new Map(records.map((record) => [key(record.type.type, record.after.id), structuredClone(record.after)]));
    const current = (t, id) => joined.get(`${t}|${JSON.stringify(id)}`) ?? ctx.stored(t, id);
    const rowsOf = (t) => {
      const rows = new Map(ctx.rowsOf(t).map((row) => [key(t, row.id), current(t, row.id)]));
      for (const [id, row] of joined) if (row.t === t) rows.set(id, row);
      return [...rows.values()];
    };
    const appended = [];
    const futureProposals = new Set(records.filter((record) => record.after.t === 'proposal' && created(record)).map((record) => record.after.id));
    const numbered = [];
    const append = (delta) => {
      appended.push(delta);
      const row = structuredClone(current(delta.t, delta.id) ?? { t: delta.t, id: delta.id });
      if (delta.life) row.life = delta.life;
      row.f = { ...row.f, ...delta.f };
      joined.set(key(delta.t, delta.id), row);
    };
    for (const record of records.filter((record) => record.after.t === 'routine' && isAlive(record.after))) {
      const isNew = created(record);
      if (!isNew && !changed(record, 'name') && !changed(record, 'entries')) continue;
      const revision = isNew ? 1 : valueOf(record.original, 'revision') + 1;
      if (!Number.isInteger(revision) || revision > 2_147_483_647) throw new Refusal('invalid');
      const f = { revision: [revision, null] };
      if (isNew) f.createdEntries = [valueOf(record.after, 'entries')?.length, null];
      append({ t: 'routine', id: record.after.id, born: record.after.born, f });
    }
    for (const record of records) {
      if (record.after.t === 'proposal') futureProposals.delete(record.after.id);
      const rule = RULES[record.type.type];
      if (rule) rule(ctx, record, { current, rowsOf, append, futureProposals, numbered, product: this });
    }
    return appended;
  }
}

function created(record) {
  return isAlive(record.after) && (record.original === undefined || !isAlive(record.original));
}

function died(record) {
  return !isAlive(record.after) && record.original !== undefined && isAlive(record.original);
}

function changed(record, field) {
  return isAlive(record.after) && record.original !== undefined && isAlive(record.original)
    && !sameJson(valueOf(record.original, field), valueOf(record.after, field));
}

function exerciseKnown(ctx, id, current = ctx.stored) {
  if (Object.hasOwn(ctx.productState.seeds ?? {}, id)) return true;
  const own = current('exercise', id);
  return own !== undefined && isAlive(own);
}

// A rename's aliases (A.2): the name it replaces goes first, the new name leaves the list, and the oldest
// beyond MAX_ALIASES go.
function renamed(aliases, before, after) {
  return [before, ...(aliases ?? []).filter((name) => name !== before && name !== after)].slice(0, MAX_ALIASES);
}

// A.2 display names: a new register holding only whitespace is invalid; untouched historical names stand.
function blankNamed(record, field) {
  const name = valueOf(record.after, field);
  return isAlive(record.after) && typeof name === 'string' && /^\s*$/.test(name)
    && (created(record) || !sameJson(record.original?.f?.[field], record.after.f?.[field]));
}

const RULES = {
  set(ctx, record, { current, append, numbered }) {
    const { after } = record;
    if (isAlive(after) && after.v?.setNumber !== undefined
      && (!Number.isInteger(after.v.setNumber) || after.v.setNumber < 1 || after.v.setNumber > MAX_SET_NUMBER)) throw new Refusal('invalid');
    if (!created(record)) {
      const moved = ctx.deltas.some((delta) => delta.t === 'set' && delta.id === after.id && delta.f?.completedAt !== undefined);
      if (moved && record.original !== undefined) throw new Refusal('invalid');
      return;
    }
    const sessionId = valueOf(after, 'sessionId');
    const session = current('session', sessionId);
    if (!record.createdBy.includes('command') && session && isAlive(session)) {
      const finishedAt = valueOf(session, 'finishedAt');
      if (isSet(finishedAt)) {
        const completedAt = valueOf(after, 'completedAt');
        if (valueOf(session, 'closedBy') !== 'stale' || completedAt > finishedAt + STALE_MS) throw new Refusal('session-finished');
        if (completedAt > finishedAt) append({ t: 'session', id: sessionId, born: session.born, f: { finishedAt: [completedAt, null] } });
      }
    }
    if (!exerciseKnown(ctx, valueOf(after, 'exerciseId'), current)) throw new Refusal('unknown-exercise');
    if (record.isNew) {
      const peers = [...ctx.rowsOf('set'), ...numbered].filter((row) => isAlive(row) && row.id !== after.id
        && valueOf(row, 'sessionId') === sessionId && valueOf(row, 'exerciseId') === valueOf(after, 'exerciseId'));
      const number = after.v?.setNumber ?? 1 + Math.max(0, ...peers.map((row) => row.v?.setNumber ?? 0));
      if (!Number.isInteger(number) || number < 1 || number > MAX_SET_NUMBER) throw new Refusal('invalid');
      numbered.push({ ...after, v: { ...after.v, setNumber: number } });
    }
  },

  session(ctx, record, { rowsOf, append }) {
    if (created(record)) {
      if (record.createdBy.some((source) => source !== 'command')) throw new Refusal('invalid');
      return;
    }
    if (!died(record)) return;
    const original = record.original;
    if (!isSet(valueOf(original, 'finishedAt')) && !isStale({ ...ctx, rowsOf }, original)) throw new Refusal('session-open');
    for (const set of rowsOf('set')) {
      if (isAlive(set) && valueOf(set, 'sessionId') === original.id) append({ t: 'set', id: set.id, born: set.born, life: ['dead', null] });
    }
  },

  routine(ctx, record, { current, rowsOf, append }) {
    const { after } = record;
    if (died(record)) {
      for (const proposal of rowsOf('proposal')) {
        if (isAlive(proposal) && valueOf(proposal, 'routineId') === after.id) append({ t: 'proposal', id: proposal.id, born: proposal.born, life: ['dead', null] });
      }
      for (const session of rowsOf('session')) {
        if (isAlive(session) && valueOf(session, 'routineId') === after.id) append({ t: 'session', id: session.id, born: session.born, f: { routineId: [null, null] } });
      }
      return;
    }
    if (!isAlive(after)) return;
    if (blankNamed(record, 'name')) throw new Refusal('invalid');
    const isNew = created(record);
    const moved = !isNew && (changed(record, 'name') || changed(record, 'entries'));
    if (isNew || changed(record, 'entries')) {
      const entries = valueOf(after, 'entries');
      if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => entry.sets !== undefined && entry.sets.length === 0)) throw new Refusal('invalid');
      if (entries.some((entry) => !exerciseKnown(ctx, entry.exerciseId, current))) throw new Refusal('unknown-exercise');
    }
    if (isNew && valueOf(after, 'createdDoor') === 'ask') {
      if (current('routineCreation', after.id)) throw new Refusal('invalid');
      const snapshot = { id: after.id, name: valueOf(after, 'name'), position: valueOf(after, 'position') ?? 0,
        entries: valueOf(after, 'entries').map((entry, i) => ({ ...entry, position: i + 1 })), revision: 1 };
      append({ t: 'routineCreation', id: after.id, f: { snapshot: [snapshot, null] } });
    }
    if (!moved) return;
    for (const proposal of rowsOf('proposal')) {
      if (!isAlive(proposal) || valueOf(proposal, 'routineId') !== after.id || stateOf(proposal) !== 'pending') continue;
      append({ t: 'proposal', id: proposal.id, born: proposal.born, f: { state: ['superseded', null], settledAt: [ctx.serverNow, null] } });
    }
  },

  exercise(ctx, record, { append }) {
    const { after } = record;
    if (died(record)) throw new Refusal('invalid');
    if (created(record) && !isSet(valueOf(after, 'stepKg'))) throw new Refusal('invalid');
    if (blankNamed(record, 'name')) throw new Refusal('invalid');
    if (changed(record, 'name')) {
      const aliases = renamed(valueOf(after, 'aliases'), valueOf(record.original, 'name'), valueOf(after, 'name'));
      append({ t: 'exercise', id: after.id, born: after.born, f: { aliases: [aliases, null] } });
    }
  },

  exerciseName(ctx, record, { append }) {
    const { after } = record;
    const seed = ownValue(ctx.productState.seeds, after.id);
    if (!seed) throw new Refusal('invalid');
    if (blankNamed(record, 'name')) throw new Refusal('invalid');
    const before = valueOf(record.original, 'name') ?? seed.name;
    const now = valueOf(after, 'name') ?? seed.name;
    if (before === now) return;
    append({ t: 'exerciseName', id: after.id, f: { aliases: [renamed(valueOf(after, 'aliases'), before, now), null] } });
  },

  weighin(ctx, record) {
    if (isAlive(record.after) && record.after.id > utcDay(ctx.serverNow + DAY_MS)) throw new Refusal('bad-instant');
  },

  note(ctx, record, { append }) {
    if (blankNamed(record, 'title')) throw new Refusal('invalid');
    if (created(record) || changed(record, 'title') || changed(record, 'body')) {
      append({ t: 'note', id: record.after.id, born: record.after.born, f: { updatedAt: [ctx.serverNow, null] } });
    }
  },

  proposal(ctx, record, { current, rowsOf, append, futureProposals }) {
    const { after } = record;
    if (!created(record)) return;
    if (ctx.origin === 'replica') {
      const empty = (field) => (valueOf(after, field) ?? '') === '';
      if (valueOf(after, 'door') !== 'ask' || !empty('connection') || !empty('agent')) throw new Refusal('invalid');
    }
    const routineId = valueOf(after, 'routineId');
    const routine = current('routine', routineId);
    if (routine === undefined || !isAlive(routine)) throw new Refusal('unknown-record');
    if (ctx.origin === 'replica') {
      for (const field of ['entries', 'name']) {
        if (!ctx.guards.some((guard) => guard.t === 'routine' && guard.id === routineId && guard.field === field
          && guard.stamp === (routine.f?.[field]?.[1] ?? null))) throw new Refusal('invalid');
      }
    }
    const changes = valueOf(after, 'changes');
    const proposed = changes.filter((change) => change.kind !== 'removed').map((change) => ({ exerciseId: change.exerciseId, ...change.after }));
    const removing = valueOf(after, 'intent') === 'remove';
    if ((removing ? proposed.length !== 0 : proposed.length === 0 || proposed.length > 50
      || /^\s*$/.test(valueOf(after, 'proposedName') ?? '') || proposed.some((entry) => entry.sets !== undefined && entry.sets.length === 0))
      || !sameJson(changes, proposalChanges(valueOf(routine, 'entries'), proposed))) throw new Refusal('invalid');
    if (proposed.some((entry) => !exerciseKnown(ctx, entry.exerciseId, current))) throw new Refusal('unknown-exercise');
    const base = valueOf(routine, 'entries');
    const name = valueOf(routine, 'name');
    let count = changes.filter((change) => change.kind !== 'kept').length + (name === valueOf(after, 'proposedName') ? 0 : 1);
    const matched = new Set();
    let highest = -1;
    for (const change of changes) {
      if (change.kind === 'added' || change.kind === 'removed') continue;
      const i = base.findIndex((entry, at) => !matched.has(at) && entry.exerciseId === change.exerciseId);
      matched.add(i);
      if (i < highest) { count += 1; break; }
      highest = i;
    }
    append({ t: 'proposal', id: after.id, born: after.born, f: {
      baseRevision: [valueOf(routine, 'revision'), null], baseName: [name, null], changeCount: [count, null],
    } });
    for (const other of rowsOf('proposal')) {
      if (other.id === after.id || futureProposals.has(other.id) || !isAlive(other) || stateOf(other) !== 'pending' || valueOf(other, 'routineId') !== routineId) continue;
      if (valueOf(other, 'door') !== valueOf(after, 'door') || (valueOf(other, 'connection') ?? '') !== (valueOf(after, 'connection') ?? '')) continue;
      append({ t: 'proposal', id: other.id, born: other.born, f: { state: ['superseded', null], supersededBy: [after.id, null], settledAt: [ctx.serverNow, null] } });
    }
  },
};
