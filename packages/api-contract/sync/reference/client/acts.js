import { CONSTANTS } from '../core/constants.js';
import { mintId } from '../core/derive.js';
import { jcs, sameJson } from '../core/jcs.js';
import { recipeFault, recordValues, valueIn } from '../core/restore.js';
import { recordKey } from '../core/rows.js';
import { widestAloneBytes } from '../core/wire.js';
import { CommitError, commitGesture } from './commit.js';
import { acknowledgedWrites, stepOver } from './journal.js';
import { drawn, stored } from './views.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The one capture command of a scope's kind (§2.4). None or several is a programming error, never a choice
// by name.
function captureCommandOf(registry, scope) {
  const kind = registry.scopeKindOf(scope);
  const found = [...registry.commands.values()].filter((command) => command.engine === 'capture' && command.scope === kind);
  if (found.length !== 1) throw new CommitError(`${kind} has no single capture command`);
  return found[0].name;
}

// ActRequest.undo, checked against its scopes, with each segment's first local preimages read from the act's
// initial snapshot (§7.1 Ordered local acts), each with the sequence of the row it was read over (the confirmed row,
// else the dead row the record's spent id keeps; null where neither holds one), stepped over each of the device's
// own acknowledged writes of the record whose receipt continues it, and the server epoch that sequence counts in; a
// life's preimage also keeps the record as read, which a revival draws. A slot unset there takes the recipe's
// explicit default; with none, the act fails before anything changes. A segment named with no recipes is journaled
// for its receipts alone, as evidence, and an act names at least one recipe. Answers the plan by segment index, or
// null.
function planUndo(replica, registry, request) {
  const { undo } = request;
  if (undo === undefined || undo === null) return null;
  if (!isObject(undo) || Object.keys(undo).sort().join() !== 'segments,version' || undo.version !== 1 || !Array.isArray(undo.segments))
    throw new CommitError('an act undo is {version: 1, segments}');
  const plan = new Map();
  const writes = acknowledgedWrites(replica);
  for (const segment of undo.segments) {
    if (!isObject(segment) || Object.keys(segment).sort().join() !== 'index,recipes' || !Number.isSafeInteger(segment.index)
      || segment.index < 0 || segment.index >= request.scopes.length || plan.has(segment.index)
      || !Array.isArray(segment.recipes)) throw new CommitError('an undo segment names one act segment and its recipes');
    const scope = request.scopes[segment.index];
    const view = drawn(replica, registry, scope);
    const preimages = [];
    for (const recipe of segment.recipes) {
      const fault = recipeFault(registry, scope, recipe);
      if (fault) throw new CommitError(`an undo recipe is malformed: ${fault}`);
      if (recipe.kind === 'createdRecord' && view.has(recordKey(recipe.record.t, recipe.record.id))) throw new CommitError('a created record exists before its act');
      if (recipe.kind !== 'fields') continue;
      for (const { target, defaultValue } of recipe.targets) {
        const read = view.get(recordKey(target.t, target.id));
        const value = valueIn(read, target.slot);
        if (value === undefined && defaultValue === undefined) throw new CommitError('an unset undo target needs its default');
        const readOver = replica.confirmedRow(target.scope, target.t, target.id) ?? replica.spentIds[target.scope]?.[recordKey(target.t, target.id)];
        const preimage = { target: structuredClone(target), value: structuredClone(value ?? defaultValue),
          rowSeq: readOver?.seq ?? null, epoch: replica.meta.serverEpoch,
          ...(target.slot.kind === 'life' && read ? { record: recordValues(read) } : {}) };
        for (const entry of writes.get(jcs([target.scope, target.t, target.id])) ?? []) stepOver(preimage, entry);
        preimages.push(preimage);
      }
    }
    plan.set(segment.index, { scope, recipes: structuredClone(segment.recipes), preimages });
  }
  if (undo.segments.every((segment) => segment.recipes.length === 0)) throw new CommitError('an act opts into Undo with at least one recipe');
  return plan;
}

// An opted segment's gesture runs its own scopedEffects command, or else the capture command, which joins it
// only when the segment writes a delta.
function optedGesture(registry, scope, opts) {
  if (opts.cmd === undefined) return { ...opts, capture: captureCommandOf(registry, scope) };
  if (!registry.command(opts.cmd.name)?.scopedEffects) throw new CommitError('an opted command returns scoped effects');
  return opts;
}

// The act's journal record, from the segments that left an entry: one source entry each, in commit order, with
// the value the act left in each target, which a Redo writes back. Each ordinary entry still queued that a journaled
// preimage read over takes its scope kind's capture command, so its ACK carries the receipt a restore's walk steps
// over; an entry already sent keeps its intent, and so does one the command would carry past a push alone.
function recordAct(replica, ctx, actId, plan, receipts) {
  const { registry } = ctx;
  if (plan === null) return;
  const sourceEntries = [];
  for (const [index, { scope, recipes, preimages }] of [...plan].sort(([a], [b]) => a - b)) {
    const { localIds } = receipts[index];
    if (localIds.length === 0) continue;
    if (localIds.length > 1) throw new CommitError('an opted segment commits one intent');
    const view = drawn(replica, registry, scope);
    const written = preimages.flatMap(({ target }) => {
      const value = valueIn(view.get(recordKey(target.t, target.id)), target.slot);
      return value === undefined ? [] : [{ target: structuredClone(target), value: structuredClone(value) }];
    });
    sourceEntries.push({ localId: localIds[0], originScope: scope, recipes, preimages, written, attempts: [] });
  }
  if (sourceEntries.length === 0) return;
  replica.journal.push({ version: 1, actId, retained: true, sourceEntries });
  for (const { target } of sourceEntries.flatMap((source) => source.preimages)) {
    for (const entry of replica.entries(target.scope)) {
      const queued = entry.gestureId !== actId && ['held', 'ready'].includes(entry.state) && entry.intent.cmd === undefined;
      if (!queued || !(entry.intent.d ?? []).some((delta) => delta.t === target.t && sameJson(delta.id, target.id))) continue;
      const captured = { ...entry.intent, cmd: { name: captureCommandOf(registry, target.scope), args: {} } };
      if (widestAloneBytes(replica.meta, captured) > (ctx.limits ?? CONSTANTS).PUSH_MAX_BYTES) continue;
      entry.intent = captured;
      entry.predictions = [{ scope: entry.scope, d: [] }];
    }
  }
}


// A copy of the replica an act writes before it publishes: its queue, notices, device rows, journal and clocks
// its own, its confirmed rows shared.
function tentative(replica) {
  return Object.assign(Object.create(Object.getPrototypeOf(replica)), replica, {
    meta: structuredClone(replica.meta), outbox: structuredClone(replica.outbox),
    notices: structuredClone(replica.notices), device: structuredClone(replica.device), journal: structuredClone(replica.journal),
  });
}

// A segment's scope hydrated before it is read or written, with a tree's or overlay's governing product scope.
function ensureSegmentScope(ctx, scope) {
  ctx.ensureScope?.(scope);
  if (['tree', 'overlay'].includes(ctx.registry.scopeKindOf(scope)) && ctx.registry.governingType)
    ctx.ensureScope?.(`self/${ctx.registry.productOfScopeKind(ctx.registry.governingType.scope)}`);
}

function newActScope(replica, registry, scope) {
  const kind = registry.scopeKindOf(scope);
  if (kind !== 'tree' && kind !== 'overlay') return false;
  if (['confirmed', 'spentIds', 'staging', 'cursors', 'known'].some((key) => Object.hasOwn(replica[key], scope)) || replica.entries(scope).length) return false;
  const governing = registry.governingType;
  if (!governing) return false;
  const tree = scope.split('/').at(-1);
  const product = `self/${registry.productOfScopeKind(governing.scope)}`;
  return !drawn(replica, registry, product).has(recordKey(governing.type, tree));
}

// The storage edge may resume after hydrating a demanded scope in the same transaction. Preparation
// finishes once; ordered segments start only after their scopes are hydrated. A composed act decides in parts
// while it prepares: `stage` commits a part's segment to a tentative copy of the replica and answers its local
// refusal, if any, and `beginPart` opens the next part's load, which reads, and draws identities, through every
// segment staged so far. The tentative copy is thrown away; the request's segments commit afresh, under the
// act's one hold.
const STAGED = 'staged';

export class ActCommit {
  advance(replica, ctx, prepare, segment) {
    if (replica.meta.state !== 'anon' && replica.meta.state !== 'bound') throw new CommitError('the replica cannot commit an act', 'not-writable');
    this.now ??= ctx.deviceNow + replica.meta.serverOffsetMs;
    this.deviceNow ??= ctx.deviceNow;
    this.actor ??= ctx.actor;
    const views = (source, scope) => ({ drawn: drawn(source, ctx.registry, scope), stored: stored(source, ctx.registry, scope),
      spent: source.spentRows(scope), now: this.now, replica: source.id, actor: this.actor, isAnonymous: source.meta.state === 'anon',
      ...ctx.metadata?.(source, scope) });
    if (!this.prepared) {
      let open = true, loading = true, failure, staged = null, stagedOffset = 0;
      const borrowed = new Set();
      const reserved = new Map();
      const newMints = new Set();
      const check = () => { if (!open) throw new CommitError('an act context serves only its prepare callback'); };
      const finishLoad = () => { check(); if (failure) throw failure; loading = false; };
      const context = {
        finishLoad,
        now: this.now, replica: replica.id, actor: this.actor, isAnonymous: replica.meta.state === 'anon',
        inScope: (scope, body) => {
          check();
          if (!loading) { failure ??= new CommitError('an act reader serves only load'); throw failure; }
          try {
            if (!ctx.registry.scopeKindOf(scope)) throw new CommitError('an act reader names a scope of its registry');
            ctx.ensureScope?.(scope);
          } catch (error) { failure ??= error; throw error; }
          borrowed.add(scope);
          let loan = true;
          try { return body({ ...views(staged ?? replica, scope), assertOpen: () => { check(); if (!loan) { failure ??= new CommitError('an act reader loan has ended'); throw failure; } } }); }
          finally { loan = false; }
        },
        stage: (scope, prepareSegment) => {
          finishLoad();
          if (!ctx.registry.scopeKindOf(scope)) throw new CommitError('an act stages a scope of its registry');
          ensureSegmentScope(ctx, scope);
          staged ??= tentative(replica);
          let loan = true;
          let gesture;
          try { gesture = prepareSegment({ ...views(staged, scope), assertOpen: () => { check(); if (!loan) throw new CommitError('an act segment reader has ended'); } }); }
          finally { loan = false; }
          const result = commitGesture(staged, { ...ctx, actor: this.actor, deviceNow: this.deviceNow, ended: [] }, this.now, scope, gesture.changes,
            { ...(gesture.opts ?? {}), gestureId: STAGED }, { offset: stagedOffset, firstOrder: replica.nextCommitOrder() });
          if (result.refused) return { refused: result.refused, ...(result.detail ? { detail: result.detail } : {}) };
          stagedOffset += result.localIds.length;
          return null;
        },
        beginPart: () => {
          finishLoad();
          loading = true;
        },
        mintID: (type, scope) => {
          finishLoad();
          try {
            const definition = ctx.registry.type(type);
            if (!definition?.mint || definition.scope !== ctx.registry.scopeKindOf(scope)) throw new CommitError('an act identity names its type scope');
            if (!borrowed.has(scope)) {
              if (!newActScope(replica, ctx.registry, scope)) throw new CommitError('load must borrow an existing scope before minting there');
              newMints.add(scope);
            }
            const taken = reserved.get(scope) ?? new Set();
            reserved.set(scope, taken);
            const current = drawn(staged ?? replica, ctx.registry, scope);
            let id;
            do { id = mintId(definition, ctx.draw); }
            while (taken.has(id) || current.has(recordKey(type, id)) || replica.spentIds[scope]?.[recordKey(type, id)]);
            taken.add(id);
            return id;
          } catch (error) { failure ??= error; throw error; }
        },
        opaqueID: () => { finishLoad(); return ctx.opaqueID ? ctx.opaqueID() : ctx.nextGestureId(); },
      };
      try { const prepared = prepare(context); finishLoad(); this.prepared = prepared; this.newMints = newMints; } finally { open = false; }
    }
    const { request, value } = this.prepared;
    if (!request || request.scopes.length === 0) return { outcome: null, value };
    for (const scope of request.scopes) ensureSegmentScope(ctx, scope);
    if (!this.working) {
      if (request.gestureId !== undefined && request.gestureId !== null && ctx.device.carriesGesture(request.gestureId)) throw new CommitError('the act gesture id is taken');
      this.undoPlan = planUndo(replica, ctx.registry, request);
      this.gestureId = request.gestureId ?? ctx.nextGestureId();
      this.working = tentative(replica);
      this.firstOrder = replica.nextCommitOrder();
      this.index = 0; this.offset = 0; this.receipts = []; this.retired = new Set(); this.superseded = new Set(); this.ended = [];
      this.wrote = false;
    }
    const working = this.working;
    for (; this.index < request.scopes.length; this.index++) {
      const scope = request.scopes[this.index];
      if (this.newMints.has(scope)) {
        const governing = ctx.registry.governingType;
        const product = `self/${ctx.registry.productOfScopeKind(governing.scope)}`;
        if (drawn(working, ctx.registry, product).get(recordKey(governing.type, scope.split('/').at(-1)))?.life?.[0] !== 'alive')
          throw new CommitError('an act must create the governing record before using identities in its new scope');
      }
      let loan = true;
      if (!this.segment) {
        try { this.segment = segment(value, this.index, { ...views(working, scope), assertOpen: () => { if (!loan) throw new CommitError('an act segment reader has ended'); } }); }
        finally { loan = false; }
      }
      const gesture = this.segment;
      const opts = this.undoPlan?.has(this.index) ? optedGesture(ctx.registry, scope, gesture.opts ?? {}) : gesture.opts ?? {};
      if (opts.gestureId !== undefined && opts.gestureId !== this.gestureId || opts.hold && !request.hold) throw new CommitError('a segment uses its act identity and hold');
      const before = structuredClone(working.meta);
      const result = commitGesture(working, { ...ctx, actor: this.actor, deviceNow: this.deviceNow, ended: this.ended }, this.now,
        scope, gesture.changes, { ...opts, gestureId: this.gestureId, hold: request.hold }, { offset: this.offset, firstOrder: this.firstOrder });
      if (result.refused) return { outcome: { refused: result.refused, segment: this.index, ...(result.detail ? { detail: result.detail } : {}) }, value };
      const changed = result.localIds.length || result.retired.length || result.superseded?.length || Object.keys(opts.local ?? {}).length;
      if (!changed) working.meta = before;
      else this.wrote = true;
      this.receipts.push({ scope, stamp: changed ? result.stamp : null, localIds: result.localIds, ids: result.ids });
      this.offset += result.localIds.length;
      result.retired.forEach((id) => this.retired.add(id));
      result.superseded?.forEach((id) => this.superseded.add(id));
      delete this.segment;
    }
    if (!this.wrote) return { outcome: null, value };
    recordAct(working, ctx, this.gestureId, this.undoPlan, this.receipts);
    for (const key of ['meta', 'outbox', 'notices', 'device', 'journal']) replica[key] = working[key];
    ctx.ended.push(...this.ended);
    return { outcome: { gestureId: this.gestureId, segments: this.receipts, retired: [...this.retired], superseded: [...this.superseded],
      releaseAt: request.hold && this.offset > 0 ? this.deviceNow + (ctx.limits ?? CONSTANTS).HOLD_MS : null }, value };
  }
}

export function commitAct(replica, ctx, segments, options = {}) {
  return new ActCommit().advance(replica, ctx, () => ({
    request: segments === null ? null : { scopes: segments.map((item) => item.scope), hold: segments.some((item) => item.opts?.hold), ...options },
    value: segments,
  }), (values, index) => values[index]).outcome;
}
