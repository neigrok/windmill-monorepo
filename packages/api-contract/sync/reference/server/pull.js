// §6.7 pull, §6.8 live frames and §9.2 hello.

import { CONSTANTS } from '../core/constants.js';
import { ZERO_DIGEST } from '../core/digest.js';
import { jcs } from '../core/jcs.js';
import { compareFeed, compareRecords, isAlive, isVisible, thinRow } from '../core/rows.js';
import { Cursor } from '../core/wire.js';
import { accessOf, scopeKeyOf } from './access.js';
import { admit } from './admit.js';

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
  const access = accessOf(registry, state, target, account);
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

// Runs each beforePull command of a scope the principal can read, in its own admission as the scope
// owner's server origin, before the scope's snapshot; an absent scope has no records and runs none.
function beforePull(state, registry, product, account, ref, serverNow, limits) {
  const target = scopeKeyOf(registry, ref, account);
  const scope = target === null ? undefined : state.scope(target.key);
  if (scope === undefined || !accessOf(registry, state, target, account).read) return { state, live: [] };
  let current = state;
  const live = [];
  for (const command of registry.beforePullCommands(registry.scopeKindOf(ref))) {
    const outcome = admit({ state: current, registry, product, origin: { kind: 'server', account: scope.owner }, intent: { scope: ref, cmd: { name: command.name, args: {} } }, serverNow, limits });
    current = outcome.state;
    live.push(...liveEventsOf(current, outcome, limits));
  }
  return { state: current, live };
}

// Answers {state, response, live}: the state after the beforePull admissions, and their live events.
export function pull({ state, registry, product, account, request, serverNow, limits = CONSTANTS }) {
  const head = { serverTime: serverNow, epoch: state.epoch };
  if (request.scopes.length > limits.PULL_MAX_SCOPES) return { state, response: { status: 400, body: { ...head, error: 'malformed' } }, live: [] };
  let current = state;
  const live = [];
  const pages = request.scopes.map(({ scope, cursor }) => {
    const ran = beforePull(current, registry, product, account ?? null, scope, serverNow, limits);
    current = ran.state;
    live.push(...ran.live);
    return pullOne(current, registry, account ?? null, scope, cursor, limits);
  });
  return { state: current, response: { status: 200, body: { serverTime: serverNow, epoch: current.epoch, pages } }, live };
}

// §6.8 the frame a committed change sends to every subscriber still holding read access.
export function liveFrameOf(state, key, changedRows, limits = CONSTANTS) {
  const scope = state.scope(key);
  const frame = { op: 'change', scope: refOfKey(key), epoch: state.epoch, seq: scope.seq, digest: scope.digest };
  const rows = [...changedRows].sort(compareRecords);
  if (Buffer.byteLength(jcs(rows), 'utf8') <= limits.LIVE_INLINE_BYTES) frame.rows = rows;
  return frame;
}

// One admission's live events in order: a change frame per scope it wrote (its own scope, then the
// scopes it created), then a death event per scope it killed. A subscriber receives a death event as
// deathFrameFor answers it.
export function liveEventsOf(state, outcome, limits = CONSTANTS) {
  const events = outcome.writes.map(({ key, rows }) => ({ key, frame: liveFrameOf(state, key, rows, limits) }));
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

