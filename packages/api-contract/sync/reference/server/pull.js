// §6.7 pull, §6.8 live frames and §9.2 hello.

import { CONSTANTS } from '../core/constants.js';
import { ZERO_DIGEST } from '../core/digest.js';
import { jcs } from '../core/jcs.js';
import { compareFeed, compareRecords, isAlive, isVisible, thinRow } from '../core/rows.js';
import { Cursor } from '../core/wire.js';
import { accessOf, scopeKeyOf } from './access.js';

export function refOfKey(key) {
  if (key.startsWith('tree:')) return `tree/${key.slice('tree:'.length)}`;
  return `self/${key.slice(key.indexOf('/') + 1)}`;
}

// The rows a feed scan sees: typed rows as stored, dead ones thin, and spent ids as thin dead rows.
function feedRows(state, key) {
  const rows = state.rowsOf(key).map((row) => (isAlive(row) ? row : thinRow(row)));
  for (const spent of state.spentOf(key)) {
    const row = { t: spent.t, id: spent.id, life: ['dead', spent.lifeStamp], seq: spent.seq };
    if (spent.born !== undefined) row.born = spent.born;
    rows.push(thinRow(row));
  }
  return rows.sort(compareFeed);
}

function after(row, cursor) {
  if (row.seq !== cursor.s) return row.seq > cursor.s;
  if (cursor.k === undefined) return false;
  return compareRecords(row, { t: cursor.k[0], id: cursor.k[1] }) > 0;
}

function takePage(candidates, limits) {
  const page = [];
  let bytes = 0;
  for (const row of candidates) {
    const size = Buffer.byteLength(jcs(row), 'utf8');
    if (page.length > 0 && bytes + size > limits.PULL_PAGE_BYTES) break;
    page.push(row);
    bytes += size;
  }
  return page;
}

function pageOf(state, registry, key, cursor, limits) {
  const scope = state.scope(key);
  const epoch = state.epoch;
  const feed = feedRows(state, key);
  const kept = (row) => row.life === undefined || isAlive(row) || registry.type(row.t)?.identity === 'derived';
  if (cursor === null || cursor.m === 'boot') {
    const asOf = cursor === null ? scope.seq : cursor.a;
    const scan = feed.filter((row) => row.seq <= asOf && kept(row));
    const remaining = cursor === null ? scan : scan.filter((row) => after(row, cursor));
    const rows = takePage(remaining, limits);
    const exhausted = rows.length === remaining.length;
    const last = rows[rows.length - 1];
    const next = exhausted ? { e: epoch, m: 'live', s: asOf } : { e: epoch, m: 'boot', s: last.seq, k: [last.t, last.id], a: asOf };
    return { rows, cursor: next, total: scan.length };
  }
  const remaining = feed.filter((row) => after(row, cursor));
  const rows = takePage(remaining, limits);
  if (rows.length === 0) return { rows, cursor: { e: epoch, m: 'live', s: cursor.s } };
  const last = rows[rows.length - 1];
  const endsInsideSeq = rows.length < remaining.length && remaining[rows.length].seq === last.seq;
  return { rows, cursor: endsInsideSeq ? { e: epoch, m: 'live', s: last.seq, k: [last.t, last.id] } : { e: epoch, m: 'live', s: last.seq } };
}

function pullOne(state, registry, account, ref, cursorText, limits) {
  const target = scopeKeyOf(registry, ref, account);
  if (target === null) return { scope: ref, kind: 'not-found' };
  const access = accessOf(state, target, account);
  if (!access.read) return { scope: ref, kind: access.gone ? 'gone' : 'not-found' };
  const scope = state.scope(target.key);
  let cursor = null;
  if (cursorText !== null) {
    cursor = Cursor.decode(cursorText);
    if (cursor === null || cursor.e !== state.epoch || cursor.s > (scope?.seq ?? 0)) return { scope: ref, kind: 'reset' };
  }
  if (scope === undefined) {
    return { scope: ref, kind: 'rows', rows: [], cursor: Cursor.encode({ e: state.epoch, m: 'live', s: 0 }), more: false, seq: 0, digest: ZERO_DIGEST };
  }
  const page = pageOf(state, registry, target.key, cursor, limits);
  const atHead = page.cursor.m === 'live' && page.cursor.k === undefined && page.cursor.s === scope.seq;
  const out = { scope: ref, kind: 'rows', rows: page.rows, cursor: Cursor.encode(page.cursor), more: !atHead, seq: scope.seq, digest: scope.digest };
  if (page.total !== undefined) out.total = page.total;
  if (target.kind === 'tree') out.header = { owner: { name: state.accounts[scope.owner]?.name ?? '' } };
  return out;
}

export function pull({ state, registry, account, request, serverNow, limits = CONSTANTS }) {
  const pages = request.scopes.map(({ scope, cursor }) => pullOne(state, registry, account ?? null, scope, cursor, limits));
  return { status: 200, body: { serverTime: serverNow, epoch: state.epoch, pages } };
}

// §6.8 the frame a committed change sends to every subscriber still holding read access.
export function liveFrameOf(state, key, changedRows, limits = CONSTANTS) {
  const scope = state.scope(key);
  const frame = { op: 'change', scope: refOfKey(key), epoch: state.epoch, seq: scope.seq, digest: scope.digest };
  const rows = [...changedRows].sort(compareRecords);
  if (Buffer.byteLength(jcs(rows), 'utf8') <= limits.LIVE_INLINE_BYTES) frame.rows = rows;
  return frame;
}

// One admission's live events in order: the change frame of its scope, then a death event per scope
// it killed. A subscriber receives a death event as deathFrameFor answers it.
export function liveEventsOf(state, outcome, limits = CONSTANTS) {
  const events = [];
  if (outcome.changed.length) events.push({ key: outcome.scopeKey, frame: liveFrameOf(state, outcome.scopeKey, outcome.changed, limits) });
  for (const key of outcome.killed) events.push({ key, dead: true });
  return events;
}

// §6.8 a dead scope sends `gone` to its owner and `not-found` to every other subscriber.
export function deathFrameFor(state, key, account) {
  return { op: state.scope(key).owner === account ? 'gone' : 'not-found', scope: refOfKey(key) };
}

// §9.2: holdsRecords[p] iff the account's product scope holds a visible row of a primary type.
export function hello({ state, registry, account, serverTime }) {
  const body = { serverTime, epoch: state.epoch, schema: registry.version, minSchema: registry.minVersion };
  if (account === null || account === undefined) return { status: 200, body };
  body.holdsRecords = {};
  for (const product of Object.keys(registry.products).sort()) {
    const primary = new Set(registry.primaryTypes(product).map((type) => type.type));
    body.holdsRecords[product] = state.rowsOf(`acct:${account}/${product}`).some((row) => primary.has(row.t) && isVisible(registry.type(row.t), row));
  }
  return { status: 200, body };
}

