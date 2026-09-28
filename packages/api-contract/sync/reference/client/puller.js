// §7.5 the puller: pages and frames, one local transaction each, boots into staging, resolution and
// the digest check. The client reads its cursors' mode, key and seq, which §7.5 needs.

import { ZERO_DIGEST, replaceRow } from '../core/digest.js';
import { moveEntry } from '../core/machines.js';
import { compactRow, isAlive, recordKey, stampsOf } from '../core/rows.js';
import { Cursor } from '../core/wire.js';
import { deltasOf } from './dependents.js';
import { epochChange } from './lifecycle.js';
import { drawn, stored } from './views.js';

// §7.9: a tree or overlay scope whose governing record's create is still in the outbox, held, ready or
// sent, by a delta or a prediction, is neither pulled nor subscribed live, and a `not-found` for it is
// ignored: the server holds no such scope yet.
function awaitsGoverningCreate(replica, registry, scope) {
  const kind = registry.scopeKindOf(scope);
  if (kind !== 'tree' && kind !== 'overlay') return false;
  const governing = registry.governingType;
  const tree = scope.split('/').pop();
  const creates = (delta) => delta.t === governing.type && delta.id === tree && delta.life?.[0] === 'alive' && delta.born === delta.life[1];
  return replica.entries().some((entry) => ['held', 'ready', 'sent'].includes(entry.state) && deltasOf(entry).some(creates));
}

// §7.9: the replica holds a tree or overlay scope's governing record alive, in `drawn` or in `stored`
// (§7.6): its create is in the outbox, held to acked, or the record is confirmed. The server holds the
// scope then, or is about to, so a `not-found` for it was written before the create reached the server.
function holdsGoverningRecord(replica, registry, scope) {
  const kind = registry.scopeKindOf(scope);
  if (kind !== 'tree' && kind !== 'overlay') return false;
  const governing = registry.governingType;
  const productScope = `self/${registry.productOfScopeKind(governing.scope)}`;
  const key = recordKey(governing.type, scope.split('/').pop());
  return [drawn(replica, registry, productScope), stored(replica, registry, productScope)].some((view) => view.get(key)?.life?.[0] === 'alive');
}

// §7.5: the end of a scope a client does not apply: any `gone` or `not-found` for a product scope, and a
// `not-found` for a scope that waits for its governing record's create or whose governing record the
// replica holds alive (§7.9). The product-scope ignore is defence in depth: the server answers one only
// to a request served as anonymous, which a bound replica has already handled as a 401 (§9.1), so no
// described path reaches it. It stays.
function ignoresEnd(replica, registry, scope, kind) {
  if (registry.scopeKindOf(scope)?.startsWith('product:')) return true;
  return kind === 'not-found' && (awaitsGoverningCreate(replica, registry, scope) || holdsGoverningRecord(replica, registry, scope));
}

// A pull of `scopes` under their stored cursors, leaving out the scopes that wait for their governing
// record's create; null when none is left, and nothing is sent.
export function pullRequest(replica, registry, scopes) {
  const pulled = scopes.filter((scope) => !awaitsGoverningCreate(replica, registry, scope));
  if (pulled.length === 0) return null;
  return { scopes: pulled.map((scope) => ({ scope, cursor: replica.cursorOf(scope).cursor })) };
}

function resolveAcked(replica, ctx, scope, cleanSeq) {
  for (const entry of replica.entries(scope)) {
    if (entry.state === 'acked' && entry.resultEpoch === replica.meta.serverEpoch && entry.resultSeq <= cleanSeq) {
      moveEntry(replica, ctx.ended, entry, 'resolve');
    }
  }
}

// cleanSeq (§7.5): the seqs a live cursor has received whole; none while booting or without a cursor.
function cleanSeqOf(cursor) {
  if (cursor === null || cursor.m !== 'live') return -Infinity;
  return cursor.k === undefined ? cursor.s : cursor.s - 1;
}

// Resolves the scope's acked entries its stored cursor already covers: an `ok` that arrives after the
// page or frame holding its seq resolves in its own transaction (§7.5).
export function resolveCovered(replica, ctx, scope) {
  resolveAcked(replica, ctx, scope, cleanSeqOf(Cursor.decode(replica.cursorOf(scope).cursor)));
}

function observeRows(replica, rows) {
  const stamps = rows.flatMap(stampsOf);
  replica.observe(stamps);
  replica.raiseAdmittedHigh(stamps);
}

function scopeKind(ctx, scope) {
  const kind = ctx.registry.scopeKindOf(scope);
  return kind?.startsWith('product:') ? 'product' : kind;
}

function checkDigest(replica, ctx, scope, received, seq) {
  const record = replica.cursors[scope];
  if (record.digestStop !== undefined) {
    if (record.digestStop === ctx.appVersion) return;
    delete record.digestStop;
  }
  if (record.digest === received) {
    delete record.mismatchReset;
    return;
  }
  ctx.telemetry.push({ event: 'sync-digest-mismatch', kind: scopeKind(ctx, scope), seq });
  if (record.mismatchReset) {
    record.digestStop = ctx.appVersion;
    delete record.mismatchReset;
    return;
  }
  record.cursor = null;
  record.mismatchReset = true;
}

function forget(replica, ctx, scope, kind) {
  replica.forgetScope(scope);
  replica.known[scope] = kind;
  for (const entry of replica.entries(scope)) if (entry.state === 'acked') moveEntry(replica, ctx.ended, entry, 'resolve');
}

// A row into a set of rows (confirmed, or a boot's staging) with its digest: replace by seq (§3.4),
// a dead row deletes, a dead derived row adds a spent id. A dead governing record makes its tree and
// overlay known gone, which §7.1 step 2 refuses; an alive one clears a `not-found` record of either,
// so the scope is subscribed and pulled again (§7.9).
function receiveRow(replica, ctx, scope, target, row) {
  const key = recordKey(row.t, row.id);
  const previous = target.rows[key];
  if (previous && row.seq < previous.seq) return;
  const type = ctx.registry.type(row.t);
  const governed = type?.governs === 'tree' ? [`tree/${row.id}`, `self/overlay/${row.id}`] : [];
  if (row.life && !isAlive(row)) {
    if (type?.identity === 'derived') replica.addSpent(scope, row.t, row.id, row.born);
    for (const ref of governed) replica.known[ref] = 'gone';
    delete target.rows[key];
    target.digest = replaceRow(target.digest, previous, undefined);
    return;
  }
  for (const ref of governed) if (replica.known[ref] === 'not-found') delete replica.known[ref];
  target.rows[key] = compactRow(row);
  target.digest = replaceRow(target.digest, previous, target.rows[key]);
}

// One page, requested with `requested` (the cursor text sent, or null). Answers 'stale' when the
// scope's cursor moved since the request, so the scope is pulled again.
export function applyPage(replica, ctx, requested, page) {
  const { scope } = page;
  const record = replica.cursorOf(scope);
  if (requested !== record.cursor) return 'stale';
  if (page.kind === 'reset') {
    replica.cursors[scope] = { ...record, cursor: null };
    delete replica.staging[scope];
    return 'reset';
  }
  if (page.kind === 'gone' || page.kind === 'not-found') {
    if (ignoresEnd(replica, ctx.registry, scope, page.kind)) return 'ignored';
    forget(replica, ctx, scope, page.kind);
    return page.kind;
  }

  delete replica.known[scope];
  replica.cursors[scope] = record;
  const cursor = Cursor.decode(page.cursor);
  const booting = requested === null || Cursor.decode(requested).m === 'boot';
  if (requested === null && replica.confirmedRows(scope).length > 0) replica.staging[scope] = { rows: {}, digest: ZERO_DIGEST };
  const confirmed = { rows: replica.confirmed[scope] ?? {}, digest: record.digest };
  const target = booting && replica.staging[scope] ? replica.staging[scope] : confirmed;
  for (const row of page.rows) receiveRow(replica, ctx, scope, target, row);
  replica.confirmed[scope] = confirmed.rows;
  record.digest = confirmed.digest;
  record.cursor = page.cursor;
  observeRows(replica, page.rows);

  if (booting && cursor.m === 'live') {
    const staged = replica.staging[scope];
    if (staged) {
      replica.confirmed[scope] = staged.rows;
      record.digest = staged.digest;
      delete replica.staging[scope];
    }
    record.booted = true;
    resolveAcked(replica, ctx, scope, cursor.s);
  }
  resolveAcked(replica, ctx, scope, cleanSeqOf(cursor));
  if (cursor.m === 'live' && cursor.k === undefined && cursor.s === page.seq && !replica.staging[scope]) {
    checkDigest(replica, ctx, scope, page.digest, page.seq);
  }
  return 'applied';
}

// A 401, or a 200 served as anyone but the replica's account, pauses sync and applies nothing (§9.1).
export function onPullResponse(replica, ctx, request, response, timing) {
  const { body } = response;
  if (body?.serverTime !== undefined) replica.takeOffsetSample(body.serverTime, timing, ctx.limits);
  if (replica.isUnauthenticated(response)) {
    replica.meta.authPaused = true;
    return [];
  }
  if (response.status !== 200) return [];
  if (replica.meta.serverEpoch === null) replica.meta.serverEpoch = body.epoch;
  else if (body.epoch !== replica.meta.serverEpoch) epochChange(replica, ctx, body.epoch);
  return body.pages.map((page) => {
    const requested = request.scopes.find((entry) => entry.scope === page.scope).cursor;
    return { scope: page.scope, outcome: applyPage(replica, ctx, requested, page) };
  });
}

// §7.5 step 3: a change frame applies inline iff the cursor is live without a key, the epoch matches,
// the frame is the next seq and carries its rows. Answers 'applied', 'pull', the kind forgotten,
// 'ignored' (an unknown op, or an end the client does not apply), or 'paused' (a frame served as anyone
// but the replica's account, handled as a 401, §9.1).
export function onFrame(replica, ctx, frame) {
  if (!['change', 'gone', 'not-found'].includes(frame.op)) return 'ignored';
  if (replica.servedAsOther(frame.as)) {
    replica.meta.authPaused = true;
    return 'paused';
  }
  if (frame.op === 'gone' || frame.op === 'not-found') {
    if (ignoresEnd(replica, ctx.registry, frame.scope, frame.op)) return 'ignored';
    forget(replica, ctx, frame.scope, frame.op);
    return frame.op;
  }
  const record = replica.cursorOf(frame.scope);
  const cursor = Cursor.decode(record.cursor);
  const inline = cursor !== null && cursor.m === 'live' && cursor.k === undefined && frame.epoch === replica.meta.serverEpoch
    && frame.seq === cursor.s + 1 && frame.rows !== undefined;
  if (!inline) return 'pull';
  const page = {
    scope: frame.scope,
    kind: 'rows',
    rows: frame.rows,
    cursor: Cursor.encode({ e: frame.epoch, m: 'live', s: frame.seq }),
    more: false,
    seq: frame.seq,
    digest: frame.digest,
  };
  applyPage(replica, ctx, record.cursor, page);
  return 'applied';
}
