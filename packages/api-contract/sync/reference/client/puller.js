// §7.5 the puller: pages and frames, one local transaction each, boots into staging, resolution and
// the digest check. The client reads its cursors' mode, key and seq, which §7.5 needs.

import { ZERO_DIGEST, replaceRow } from '../core/digest.js';
import { moveEntry } from '../core/machines.js';
import { compactRow, isAlive, recordKey, stampsOf } from '../core/rows.js';
import { Cursor } from '../core/wire.js';
import { epochChange } from './lifecycle.js';

export function pullRequest(replica, scopes) {
  return { scopes: scopes.map((scope) => ({ scope, cursor: replica.cursorOf(scope).cursor })) };
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
// a dead row deletes, a dead derived row adds a spent id, and a dead governing record makes its tree
// and overlay known gone, which §7.1 step 2 refuses.
function receiveRow(replica, ctx, scope, target, row) {
  const key = recordKey(row.t, row.id);
  const previous = target.rows[key];
  if (previous && row.seq < previous.seq) return;
  if (row.life && !isAlive(row)) {
    const type = ctx.registry.type(row.t);
    if (type?.identity === 'derived') replica.addSpent(scope, row.t, row.id, row.born);
    if (type?.governs === 'tree') {
      replica.known[`tree/${row.id}`] = 'gone';
      replica.known[`self/overlay/${row.id}`] = 'gone';
    }
    delete target.rows[key];
    target.digest = replaceRow(target.digest, previous, undefined);
    return;
  }
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

export function onPullResponse(replica, ctx, request, response, timing) {
  const { body } = response;
  if (body?.serverTime !== undefined) replica.takeOffsetSample(body.serverTime, timing, ctx.limits);
  if (response.status === 401) replica.meta.authPaused = true;
  if (response.status !== 200) return [];
  if (replica.meta.serverEpoch === null) replica.meta.serverEpoch = body.epoch;
  else if (body.epoch !== replica.meta.serverEpoch) epochChange(replica, ctx, body.epoch);
  return body.pages.map((page) => {
    const requested = request.scopes.find((entry) => entry.scope === page.scope).cursor;
    return { scope: page.scope, outcome: applyPage(replica, ctx, requested, page) };
  });
}

// §7.5 step 3: a change frame applies inline iff the cursor is live without a key, the epoch matches,
// the frame is the next seq and carries its rows. Answers 'applied', 'pull', or the kind forgotten.
export function onFrame(replica, ctx, frame) {
  if (frame.op === 'gone' || frame.op === 'not-found') {
    forget(replica, ctx, frame.scope, frame.op);
    return frame.op;
  }
  if (frame.op !== 'change') return 'ignored';
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
