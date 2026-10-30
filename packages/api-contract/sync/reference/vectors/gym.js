// gym/admit.json: §6.1 admission of one intent against a gym server state, under gym.registry.json and
// gym's binding (A.2).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONSTANTS } from '../core/constants.js';
import { ZERO_DIGEST, replaceRow } from '../core/digest.js';
import { Registry } from '../core/registry.js';
import { compactRow, isAlive } from '../core/rows.js';
import { GymProduct } from '../gym/product.js';
import { admit } from '../server/admit.js';
import { ServerState } from '../server/state.js';
import { ACTOR, vector } from './fixtures.js';

export const gymRegistry = new Registry(JSON.parse(readFileSync(new URL('../../gym.registry.json', import.meta.url), 'utf8')));
export const gymProduct = new GymProduct();

const H = 3_600_000;
const T = 1_760_000_000_000;
const NOW = T + 10 * H;
const GYM_A = 'acct:A/gym';
const GYM_B = 'acct:B/gym';
const A = { kind: 'replica', account: 'A', replica: 'rp_0000000000000000000000000000000a', n: 1 };
const SERVER_A = { kind: 'server', account: 'A' };
const s = (ms, counter = 0) => `${ms}:${counter}:${ACTOR}`;
const SEEDS = { 'back-squat': { name: 'Back Squat' }, 'bench-press': { name: 'Bench Press' }, dip: { name: 'Dip' } };
const SQUAT = [{ exerciseId: 'back-squat', restSeconds: 180, sets: [{ reps: 5, weightKg: 80 }] }];

// A stored row: every register at one stamp; `born` and `life` unless the type has none.
function rec(t, id, { stamp, seq, f = {}, v, born = true, life = true, rc = T, ru = T }) {
  const out = { t, id, seq, rc, ru };
  if (life) out.life = ['alive', stamp];
  if (born) out.born = stamp;
  const fields = Object.fromEntries(Object.entries(f).map(([name, value]) => [name, [value, stamp]]));
  if (Object.keys(fields).length) out.f = fields;
  if (v) out.v = v;
  return compactRow(out);
}

// A gym server state: A's and B's product scopes, each digest and note counter from its rows.
function gymState({ rows = {}, spent = {}, product = {} } = {}) {
  const json = { epoch: 'ep-1', clock: { ms: 0, counter: 0 }, accounts: { A: { name: 'Ann' }, B: { name: 'Bob' } }, scopes: {}, rows: {}, spent: {} };
  for (const key of [GYM_A, GYM_B]) {
    const own = (rows[key] ?? []).map(compactRow);
    const notes = own.filter((row) => row.t === 'note' && isAlive(row)).length;
    const seq = Math.max(0, ...own.map((row) => row.seq), ...(spent[key] ?? []).map((entry) => entry.seq));
    json.scopes[key] = { kind: 'product', owner: key === GYM_A ? 'A' : 'B', state: 'alive', seq, counters: notes ? { note: notes } : {}, digest: own.reduce((digest, row) => replaceRow(digest, undefined, row), ZERO_DIGEST) };
    json.rows[key] = own;
    if (spent[key]) json.spent[key] = spent[key];
  }
  json.product = { seeds: SEEDS, ...product };
  return new ServerState(json).toJSON();
}

function admitted(name, { state, origin = A, intent, serverNow = NOW }) {
  const outcome = admit({ state: new ServerState(state), registry: gymRegistry, product: gymProduct, origin, intent, serverNow, limits: CONSTANTS });
  return vector(name, { state, origin, intent, serverNow }, { result: outcome.result, state: outcome.state.toJSON() });
}

const gym = (d, extra = {}) => ({ scope: 'self/gym', ...(d ? { d } : {}), ...extra });
const cmd = (name, args, extra) => gym(undefined, { cmd: { name, args }, ...extra });
const regs = (stamp, values) => Object.fromEntries(Object.entries(values).map(([name, value]) => [name, [value, stamp]]));
const create = (t, id, stamp, values = {}) => ({ t, id, born: stamp, life: ['alive', stamp], ...(Object.keys(values).length ? { f: regs(stamp, values) } : {}) });
const update = (t, id, born, stamp, values) => ({ t, id, born, f: regs(stamp, values) });

// A's catalog, a routine at revision 1 with a pending MCP proposal, and a finished workout; B's own movement.
const EXERCISE = rec('exercise', 'sledpush01', { stamp: s(T), seq: 1, f: { name: 'Sled Push', pattern: 'carry', equipment: 'machine', stepKg: 5 } });
const ROUTINE = rec('routine', 'routine0001', { stamp: s(T + 1), seq: 2, f: { name: 'Lower A', position: 0, entries: SQUAT, revision: 1, createdEntries: 1 } });
const FINISHED = rec('session', 'session0001', {
  stamp: `${T + 2}:0:srv`, seq: 3,
  f: { routineId: 'routine0001', historyRoutineId: 'routine0001', plan: { routine: 'Lower A', entries: SQUAT }, startedAt: T, finishedAt: T + H, closedBy: 'finish' },
});
const SET = rec('set', 'set00000001', { stamp: s(T + 3), seq: 4, f: { sessionId: 'session0001', exerciseId: 'back-squat', weightKg: 80, reps: 5, note: '', completedAt: T + 600_000 }, v: { setNumber: 1 } });
const CHANGES = [{ kind: 'retargeted', exerciseId: 'back-squat', before: { sets: [{ reps: 5, weightKg: 80 }], restSeconds: 180 }, after: { sets: [{ reps: 5, weightKg: 85 }], restSeconds: 180 } }];
const ROUTINE_GUARDS = ['entries', 'name'].map((field) => ({ t: 'routine', id: 'routine0001', field, stamp: s(T + 1) }));
const proposalRow = (id, seq, extra = {}, stamp = `${T + 4}:0:srv`) => rec('proposal', id, {
  stamp, seq,
  f: { routineId: 'routine0001', intent: 'revise', proposedName: 'Lower A', summary: 'Heavier squat', changes: CHANGES, door: 'mcp', connection: 'conn-1', agent: 'Claude', state: 'pending', baseRevision: 1, baseName: 'Lower A', changeCount: 1, ...extra },
});
const PENDING = proposalRow('proposal001', 5);
const B_EXERCISE = rec('exercise', 'beltsquat1', { stamp: `${T}:0:r_bbbbbbbbbbbb`, seq: 1, f: { name: 'Belt Squat', pattern: 'squat', equipment: 'machine', stepKg: 5 } });

function base({ a = [], spent = {}, product = {} } = {}) {
  return gymState({
    rows: { [GYM_A]: [EXERCISE, ROUTINE, FINISHED, SET, PENDING, ...a], [GYM_B]: [B_EXERCISE] },
    spent,
    product: {
      starts: { [GYM_A]: { session0001: 'session0001' } },
      ...product,
    },
  });
}

// M1: weigh-ins take server-origin writes, and a day past tomorrow (UTC) is a forecast.
function weighins() {
  const day = '2025-10-09';
  const stored = rec('weighin', day, { stamp: s(T + 5 * H), seq: 6, born: false, f: { kg: 82.4, recordedAt: T + 5 * H } });
  const put = (id, stamp, kg, recordedAt) => ({ t: 'weighin', id, life: ['alive', stamp], f: regs(stamp, { kg, recordedAt }) });
  return [
    admitted('a server-origin weigh-in put is admitted', { state: base(), origin: SERVER_A, intent: gym([put(day, null, 82.4, T + 9 * H)]) }),
    admitted('a server-origin put out-stamps the stored weigh-in and replaces it whole', { state: base({ a: [stored] }), origin: SERVER_A, intent: gym([put(day, null, 81.9, T + 9 * H)]) }),
    admitted('a replica put older than the stored weigh-in loses whole', { state: base({ a: [stored] }), intent: gym([put(day, s(T + 4 * H), 90, T + 4 * H)]) }),
    admitted('a weigh-in dated the day after serverNow\'s UTC date is admitted', { state: base(), intent: gym([put('2025-10-10', s(T + 9 * H), 82, T + 9 * H)]) }),
    admitted('a weigh-in dated later than the day after serverNow\'s UTC date is refused bad-instant', { state: base(), intent: gym([put('2025-10-11', s(T + 9 * H), 82, T + 9 * H)]) }),
    admitted('a server-origin weigh-in delete out-stamps the stored put', { state: base({ a: [stored] }), origin: SERVER_A, intent: gym([{ t: 'weighin', id: day, life: ['dead', null] }]) }),
  ];
}

// M2: every rename appends the name it replaced, customs and seeds alike; step_kg.
function catalog() {
  const aliased = (aliases) => rec('exercise', 'sledpush01', { stamp: s(T), seq: 1, f: { name: 'Sled Push', pattern: 'carry', equipment: 'machine', stepKg: 5, aliases } });
  const withAliases = (aliases) => gymState({
    rows: { [GYM_A]: [aliased(aliases)], [GYM_B]: [] },
  });
  const seedLine = rec('exerciseName', 'back-squat', { stamp: s(T + 1), seq: 2, born: false, life: false, f: { name: 'Squat', aliases: ['Back Squat'] } });
  const withSeedLine = gymState({ rows: { [GYM_A]: [EXERCISE, seedLine], [GYM_B]: [] } });
  const rename = (name, stamp = s(T + 9 * H)) => gym([update('exercise', 'sledpush01', s(T), stamp, { name })]);
  const seedRename = (name) => gym([{ t: 'exerciseName', id: 'back-squat', f: regs(s(T + 9 * H), { name }) }]);
  const oneDumbbell = create('exercise', 'dbpress001', s(T + 9 * H), { name: 'Floor Press', pattern: 'press', equipment: 'dumbbell', stepKg: 2 });
  const oneDumbbellCount = { t: 'exerciseName', id: 'dbpress001', f: regs(s(T + 9 * H), { loadCount: 1 }) };
  return [
    admitted('renaming a custom movement appends the name it replaced to its aliases', { state: base(), intent: rename('Prowler') }),
    admitted('renaming back to an alias takes it out of the aliases and appends the name it replaced', { state: withAliases(['Prowler']), intent: rename('Prowler') }),
    admitted('a sixth alias drops the oldest: aliases hold five, newest first', { state: withAliases(['E', 'D', 'C', 'B', 'A']), intent: rename('F') }),
    admitted('a rename to the name it holds appends nothing', { state: withAliases(['Prowler']), intent: rename('Sled Push') }),
    admitted('a server-origin rename appends alike', { state: base(), origin: SERVER_A, intent: gym([update('exercise', 'sledpush01', s(T), null, { name: 'Prowler' })]) }),
    admitted('renaming a seed writes its exerciseName, whose aliases take the seed\'s own name', { state: base(), intent: seedRename('Squat') }),
    admitted('renaming a seed back to its own name keeps the line, and the name it replaced joins the aliases', { state: withSeedLine, intent: seedRename('Back Squat') }),
    admitted('a name on an exerciseName keyed by a custom movement is invalid: a custom movement\'s name lives on its exercise', { state: base(), intent: gym([{ t: 'exerciseName', id: 'sledpush01', f: regs(s(T + 9 * H), { name: 'Sled' }) }]) }),
    admitted('equipment metadata overrides a seed without renaming or replacing it', { state: base(), intent: gym([{ t: 'exerciseName', id: 'back-squat', f: regs(s(T + 9 * H), { equipment: 'dumbbell', loadCount: 2 }) }]) }),
    admitted('equipment metadata overrides a custom movement without replacing it', { state: base(), intent: gym([{ t: 'exerciseName', id: 'sledpush01', f: regs(s(T + 9 * H), { equipment: 'dumbbell', loadCount: 1 }) }]) }),
    admitted('an equipment override on a renamed custom movement leaves the movement\'s aliases on its exercise', { state: withAliases(['Sled']), intent: gym([{ t: 'exerciseName', id: 'sledpush01', f: regs(s(T + 9 * H), { equipment: 'dumbbell' }) }]) }),
    admitted('a custom movement and its one-dumbbell count are admitted in one intent, the exercise first', { state: base(), intent: gym([oneDumbbell, oneDumbbellCount]) }),
    admitted('a custom movement and its one-dumbbell count are admitted in one intent, the count first', { state: base(), intent: gym([oneDumbbellCount, oneDumbbell]) }),
    admitted('an exerciseName keyed by an id that is neither a seed nor a live custom movement is invalid', { state: base(), intent: gym([oneDumbbellCount]) }),
    admitted('invalid dumbbell count is refused', { state: base(), intent: gym([{ t: 'exerciseName', id: 'back-squat', f: regs(s(T + 9 * H), { loadCount: 3 }) }]) }),
    admitted('unknown equipment is refused', { state: base(), intent: gym([{ t: 'exerciseName', id: 'back-squat', f: regs(s(T + 9 * H), { equipment: 'unknown' }) }]) }),
    ...['name', 'equipment', 'loadCount'].map((field) => admitted(`a null ${field} on an exerciseName is invalid: its registers are absent or set, never null`, { state: base(), intent: gym([{ t: 'exerciseName', id: 'back-squat', f: regs(s(T + 9 * H), { [field]: null }) }]) })),
    admitted('a custom movement created without stepKg is invalid: every creator writes it', { state: base(), intent: gym([create('exercise', 'kbswing001', s(T + 9 * H), { name: 'Swing', pattern: 'hinge', equipment: 'kettlebell' })]) }),
    admitted('a custom movement is created with its stepKg', { state: base(), intent: gym([create('exercise', 'kbswing001', s(T + 9 * H), { name: 'Swing', pattern: 'hinge', equipment: 'kettlebell', stepKg: 4 })]) }),
    admitted('a movement is never deleted: a delete is invalid', { state: base(), intent: gym([{ t: 'exercise', id: 'sledpush01', born: s(T), life: ['dead', s(T + 9 * H)] }]) }),
    admitted('a create under a seed\'s id is refused id-taken: seeds are foreign to every account', { state: base(), intent: gym([create('exercise', 'dip', s(T + 9 * H), { name: 'Dip', pattern: 'press', equipment: 'bodyweight' })]) }),
  ];
}

// M3: a finished workout refuses new sets and takes fixes and deletes.
function sets() {
  const legacy = rec('session', 'session0001', { stamp: `${T + 2}:0:srv`, seq: 3, f: { startedAt: T, finishedAt: T + H } });
  const stale = rec('session', 'session0001', { stamp: `${T + 2}:0:srv`, seq: 3, f: { startedAt: T, finishedAt: T + 600_000, closedBy: 'stale' } });
  const open = rec('session', 'session0002', { stamp: `${T + 6 * H}:0:srv`, seq: 6, f: { startedAt: T + 6 * H } });
  const state = (session) => gymState({
    rows: { [GYM_A]: [EXERCISE, session, SET], [GYM_B]: [B_EXERCISE] },
  });
  const newSet = (sessionId, completedAt, exerciseId = 'back-squat') => gym([create('set', 'set00000002', s(T + 9 * H), { sessionId, exerciseId, weightKg: 85, reps: 5, note: '', completedAt })]);
  return [
    admitted('a new set in a workout its lifter finished is refused session-finished', { state: base(), intent: newSet('session0001', T + 2 * H) }),
    admitted('a new set in a workout finished before closedBy was recorded is refused session-finished', { state: state(legacy), intent: newSet('session0001', T + 2 * H) }),
    admitted('a new set within 4 h of a stale close lands and moves finishedAt to it', { state: state(stale), intent: newSet('session0001', T + 3 * H) }),
    admitted('a new set more than 4 h after a stale close is refused session-finished', { state: state(stale), intent: newSet('session0001', T + 5 * H) }),
    admitted('a new set in an open workout lands whatever its instant', { state: state(open), intent: newSet('session0002', T + 9 * H) }),
    admitted('a set in a finished workout takes a fix', { state: base(), intent: gym([update('set', 'set00000001', s(T + 3), s(T + 9 * H), { weightKg: 82.5, reps: 4 })]) }),
    admitted('a set in a finished workout is deleted', { state: base(), intent: gym([{ t: 'set', id: 'set00000001', born: s(T + 3), life: ['dead', s(T + 9 * H)] }]) }),
    admitted('a fix that writes completedAt is invalid: only a correction moves a set\'s instant', { state: base(), intent: gym([update('set', 'set00000001', s(T + 3), s(T + 9 * H), { completedAt: T + 700_000 })]) }),
    admitted('a set naming another account\'s movement is refused unknown-exercise', { state: state(open), intent: newSet('session0002', T + 9 * H, 'beltsquat1') }),
    admitted('a set naming its account\'s own movement lands', { state: state(open), intent: newSet('session0002', T + 9 * H, 'sledpush01') }),
  ];
}

// M4: routines keep `position`, carry entries as one register, and a document change supersedes.
function routines() {
  const ask = proposalRow('proposal002', 6, { door: 'ask', connection: '', agent: '' });
  const withAsk = base({ a: [ask] });
  const open = rec('session', 'session0002', { stamp: `${T + 6 * H}:0:srv`, seq: 6, f: { routineId: 'routine0001', historyRoutineId: 'routine0001', plan: { routine: 'Lower A', entries: SQUAT }, startedAt: T + 6 * H } });
  const edit = (values) => gym([update('routine', 'routine0001', s(T + 1), s(T + 9 * H), values)]);
  return [
    admitted('a routine created with no entry is invalid', { state: base(), intent: gym([create('routine', 'routine0002', s(T + 9 * H), { name: 'Upper', entries: [] })]) }),
    admitted('an entry whose sets list is empty is invalid: an open line has no sets key', { state: base(), intent: gym([create('routine', 'routine0002', s(T + 9 * H), { name: 'Upper', entries: [{ exerciseId: 'bench-press', sets: [] }] })]) }),
    admitted('an entry naming another account\'s movement is refused unknown-exercise', { state: base(), intent: gym([create('routine', 'routine0002', s(T + 9 * H), { name: 'Upper', entries: [{ exerciseId: 'beltsquat1' }] })]) }),
    admitted('a routine created with entries takes revision 1', { state: base(), intent: gym([create('routine', 'routine0002', s(T + 9 * H), { name: 'Upper', position: 1, entries: [{ exerciseId: 'bench-press' }] })]) }),
    admitted('changing entries supersedes every pending proposal of the routine, with no supersededBy, and moves its revision', { state: withAsk, intent: edit({ entries: [{ exerciseId: 'back-squat', sets: [{ reps: 3 }] }] }) }),
    admitted('a rename supersedes alike', { state: base(), intent: edit({ name: 'Legs' }) }),
    admitted('a position-only change supersedes nothing and moves no revision', { state: base(), intent: edit({ position: 4 }) }),
    admitted('a routine delete kills its proposals and writes routineId null on its sessions, historyRoutineId kept', { state: base({ a: [open] }), intent: gym([{ t: 'routine', id: 'routine0001', born: s(T + 1), life: ['dead', s(T + 9 * H)] }]) }),
    admitted('a server-origin create names its door in createdDoor', { state: base(), origin: SERVER_A, intent: gym([{ t: 'routine', id: 'routine0002', born: null, life: ['alive', null], f: regs(null, { name: 'Upper', position: 1, entries: [{ exerciseId: 'dip' }], createdDoor: 'mcp' }) }]) }),
  ];
}

// M5: proposals supersede by id, carry their agent, and settle once.
function proposals() {
  const mint = (id, extra = {}, origin = SERVER_A) => {
    const stamp = origin.kind === 'server' ? null : s(T + 9 * H);
    const values = { routineId: 'routine0001', intent: 'revise', proposedName: 'Lower A', summary: 'Lighter', changes: CHANGES, door: 'mcp', connection: 'conn-1', agent: 'Claude', ...extra };
    return gym([{ t: 'proposal', id, born: stamp, life: ['alive', stamp], f: regs(stamp, values) }]);
  };
  const settledBy = (state, extra = {}) => proposalRow('proposal001', 5, { state, settledAt: T + 5 * H, ...extra });
  const settled = (row, revision = 1) => gymState({
    rows: { [GYM_A]: [EXERCISE, { ...ROUTINE, f: { ...ROUTINE.f, revision: [revision, ROUTINE.f.revision[1]] } }, FINISHED, SET, row], [GYM_B]: [] },
  });
  const removal = proposalRow('proposal001', 5, { intent: 'remove', changes: [{ kind: 'removed', exerciseId: 'back-squat', before: { sets: [{ reps: 5, weightKg: 80 }], restSeconds: 180 } }] });
  const open = rec('session', 'session0002', { stamp: `${T + 6 * H}:0:srv`, seq: 6, f: { routineId: 'routine0001', historyRoutineId: 'routine0001', plan: { routine: 'Lower A', entries: SQUAT }, startedAt: T + 6 * H } });
  const other = proposalRow('proposal002', 6, { door: 'ask', connection: '', agent: '' });
  const apply = (id = 'proposal001') => cmd('gym.applyProposal', { proposalId: id });
  const dismiss = (id = 'proposal001') => cmd('gym.dismissProposal', { proposalId: id });
  const removed = admitted('apply of a removal kills the routine and its proposals, and writes routineId null on its sessions', { state: settled(removal), intent: apply() });
  const replayed = admitted('a restored removal receipt survives proposal death and a new replica with old guards', {
    state: { ...removed.expect.state, epoch: 'ep-2' }, origin: { ...A, replica: 'rp_0000000000000000000000000000000c' },
    intent: { ...apply(), guard: ROUTINE_GUARDS },
  });
  assert.equal(replayed.expect.result.s, 'ok', 'an accepted removal must not become a durable refusal on replay');
  assert.deepEqual(replayed.expect.state, replayed.input.state);
  const foreignReplay = admitted('a removal receipt belongs to its account only', {
    state: removed.expect.state, origin: { ...A, account: 'B' }, intent: apply(),
  });
  assert.equal(foreignReplay.expect.result.code, 'unknown-record');
  return [
    admitted('a new proposal supersedes the pending one of its routine, door and connection, naming itself in supersededBy', { state: base(), origin: SERVER_A, intent: mint('proposal003') }),
    admitted('a proposal of another connection leaves the pending one standing', { state: base(), origin: SERVER_A, intent: mint('proposal003', { connection: 'conn-2', agent: 'Other' }) }),
    admitted('a proposal naming an absent routine is refused unknown-record', { state: base(), origin: SERVER_A, intent: mint('proposal003', { routineId: 'routine0404' }) }),
    admitted('a proposal naming another account\'s routine is refused unknown-record', { state: gymState({ rows: { [GYM_A]: [], [GYM_B]: [rec('routine', 'routine0404', { stamp: `${T}:0:r_bbbbbbbbbbbb`, seq: 1, f: { name: 'Bee', position: 0, entries: [{ exerciseId: 'dip' }] } })] } }), origin: SERVER_A, intent: mint('proposal003', { routineId: 'routine0404' }) }),
    admitted('a replica\'s proposal naming a deleted routine is refused unknown-record', { state: base({ spent: { [GYM_A]: [{ t: 'routine', id: 'routine0009', born: s(T), lifeStamp: s(T + H), seq: 6 }] } }), origin: A, intent: mint('proposal003', { routineId: 'routine0009', door: 'ask', connection: '', agent: '' }, A) }),
    admitted('a replica\'s proposal create with door mcp is invalid', { state: base(), origin: A, intent: mint('proposal003', {}, A) }),
    admitted('a replica\'s proposal create naming an agent is invalid', { state: base(), origin: A, intent: mint('proposal003', { door: 'ask', connection: '', agent: 'Claude' }, A) }),
    admitted('a replica\'s proposal create from the phone Coach door is admitted, its state unset and read as pending', { state: base(), origin: A, intent: { ...mint('proposal003', { door: 'ask', connection: '', agent: '' }, A), guard: ROUTINE_GUARDS } }),
    admitted('apply writes the proposal\'s document and supersedes the routine\'s other pending proposals', { state: base({ a: [other] }), intent: apply() }),
    admitted('apply of an applied proposal records its receipt without changing records', { state: settled(settledBy('applied')), intent: apply() }),
    admitted('apply of a dismissed proposal is refused proposal-settled with its state', { state: settled(settledBy('dismissed')), intent: apply() }),
    admitted('apply of a proposal a newer one replaced is refused proposal-superseded: replaced', { state: settled(settledBy('superseded', { supersededBy: 'proposal009' })), intent: apply() }),
    admitted('apply of a proposal its routine outran is refused proposal-superseded: routine-changed', { state: settled(settledBy('superseded'), 2), intent: apply() }),
    admitted('apply of a proposal superseded before either reason was recorded is refused proposal-superseded: superseded', { state: settled(settledBy('superseded')), intent: apply() }),
    admitted('apply of a pending proposal whose base the routine outran is refused proposal-superseded: routine-changed, leaving pending unchanged', { state: settled(PENDING, 2), intent: apply() }),
    removed, replayed, foreignReplay,
    admitted('apply of a proposal that died with its routine is refused record-dead', { state: base({ spent: { [GYM_A]: [{ t: 'proposal', id: 'proposal007', born: `${T}:0:srv`, lifeStamp: `${T + H}:0:srv`, seq: 6 }] } }), intent: apply('proposal007') }),
    admitted('dismiss settles a pending proposal with its settledAt', { state: base(), intent: dismiss() }),
    admitted('dismiss of a dismissed proposal is ok and writes nothing', { state: settled(settledBy('dismissed')), intent: dismiss() }),
    admitted('dismiss of an applied proposal is refused proposal-settled with its state', { state: settled(settledBy('applied')), intent: dismiss() }),
    admitted('dismiss of a superseded proposal is refused proposal-superseded with its reason', { state: settled(settledBy('superseded', { supersededBy: 'proposal009' })), intent: dismiss() }),
    admitted('dismiss runs no revision check on a pending proposal', { state: settled(PENDING, 2), intent: dismiss() }),
  ];
}

// M6: sessions, their starts and receipts, deletes, finishes, imports and corrections.
function sessions() {
  const open = (startedAt) => rec('session', 'session0002', { stamp: `${startedAt}:0:srv`, seq: 6, f: { startedAt } });
  const withOpen = (startedAt, extra = [], product = {}) => base({ a: [open(startedAt), ...extra], product: { starts: { [GYM_A]: { session0001: 'session0001', session0002: 'session0002' } }, ...product } });
  const start = (id, extra = {}) => cmd('gym.start', { id, startedAt: T + 9 * H, joinOpenSession: true, ...extra });
  const legacy = rec('session', 'session0001', { stamp: `${T + 2}:0:srv`, seq: 3, f: { startedAt: T, finishedAt: T + H } });
  const stale = rec('session', 'session0001', { stamp: `${T + 2}:0:srv`, seq: 3, f: { startedAt: T, finishedAt: T + 600_000, closedBy: 'stale' } });
  const only = (session) => gymState({ rows: { [GYM_A]: [EXERCISE, session, SET], [GYM_B]: [] } });
  const finish = (finishedAt) => cmd('gym.finish', { sessionId: 'session0001', finishedAt });
  const importArgs = (extra = {}) => ({ id: 'session0003', startedAt: T + 2 * H, finishedAt: T + 3 * H, sets: [{ id: 'set00000003', exerciseId: 'dip', weightKg: 0, reps: 10, completedAt: T + 2 * H + 60_000 }], ...extra });
  const imported = gymState({
    rows: { [GYM_A]: [EXERCISE, ROUTINE, FINISHED, SET], [GYM_B]: [] },
    product: { imports: { [GYM_A]: { session0003: importArgs() } } },
  });
  const correction = (extra = {}) => ({
    sessionId: 'session0001', requestId: 'fix-000001', startedAt: T - 60_000, finishedAt: T + H, routineName: 'Legs',
    sets: [
      { id: 'set00000001', exerciseId: 'back-squat', setNumber: 1, weightKg: 82.5, reps: 5, completedAt: T + 900_000 },
      { id: 'set00000009', exerciseId: 'back-squat', setNumber: 2, weightKg: 82.5, reps: 4, completedAt: T + 1_200_000 },
    ],
    ...extra,
  });
  const twoSets = gymState({
    rows: { [GYM_A]: [EXERCISE, ROUTINE, FINISHED, SET, rec('set', 'set00000002', { stamp: s(T + 4), seq: 6, f: { sessionId: 'session0001', exerciseId: 'back-squat', weightKg: 60, reps: 8, note: 'easy', rpe: 6, completedAt: T + 300_000 }, v: { setNumber: 2 } })], [GYM_B]: [] },
  });
  const overlapping = structuredClone(twoSets);
  const overlap = structuredClone(FINISHED);
  overlap.id = 'other00001'; overlap.f.startedAt[0] = T - 61_000; overlap.f.finishedAt[0] = T - 59_000;
  overlapping.rows[GYM_A].push(overlap);
  overlapping.scopes[GYM_A].digest = replaceRow(overlapping.scopes[GYM_A].digest, undefined, overlap);
  return [
    admitted('a start naming a routine freezes its plan and records historyRoutineId', { state: base(), intent: start('session0002', { routineId: 'routine0001' }) }),
    admitted('a start naming a routine that is gone starts with routineId and plan null', { state: base({ spent: { [GYM_A]: [{ t: 'routine', id: 'routine0009', born: s(T), lifeStamp: s(T + H), seq: 6 }] } }), intent: start('session0002', { routineId: 'routine0009' }) }),
    admitted('a start joins the open session, recording its receipt', { state: withOpen(T + 8 * H), intent: start('session0003') }),
    admitted('a start replayed after the session it joined finished answers that session', { state: base({ product: { starts: { [GYM_A]: { session0001: 'session0001', session0003: 'session0001' } } } }), intent: start('session0003') }),
    admitted('a start that will not join, with a session open, is refused session-open', { state: withOpen(T + 8 * H), intent: start('session0003', { joinOpenSession: false }) }),
    admitted('a start whose own session was deleted answers ok and writes nothing, another session open', { state: withOpen(T + 8 * H, [], { starts: { [GYM_A]: { session0001: 'session0001', session0002: 'session0002', session0005: 'session0005' } } }), intent: start('session0005') }),
    admitted('a start closes a stale open session at its last activity before it creates', { state: withOpen(T + 5 * H), intent: start('session0003') }),
    admitted('a start under the caller\'s own session with no receipt (a legacy session) answers that session', { state: base({ product: { starts: {} } }), intent: start('session0001') }),
    admitted('a start under the caller\'s own deleted session with no receipt answers ok and writes nothing', { state: base({ spent: { [GYM_A]: [{ t: 'session', id: 'session0008', born: `${T}:0:srv`, lifeStamp: `${T + H}:0:srv`, seq: 6 }] }, product: { starts: {} } }), intent: start('session0008') }),
    admitted('a session created by a bare delta is invalid: only commands create sessions', { state: base(), intent: gym([create('session', 'session0003', s(T + 9 * H))]) }),
    admitted('a start under another account\'s session id is refused id-taken', { state: gymState({ rows: { [GYM_A]: [], [GYM_B]: [rec('session', 'session0007', { stamp: `${T}:0:srv`, seq: 1, f: { startedAt: T } })] } }), intent: start('session0007') }),
    admitted('a delete of an open session is refused session-open', { state: withOpen(T + 8 * H), intent: gym([{ t: 'session', id: 'session0002', born: `${T + 8 * H}:0:srv`, life: ['dead', s(T + 9 * H)] }]) }),
    admitted('a delete of an open session 4 h past its last activity is admitted and kills its sets', { state: withOpen(T + 5 * H, [rec('set', 'set00000002', { stamp: s(T + 5 * H), seq: 7, f: { sessionId: 'session0002', exerciseId: 'dip', weightKg: 0, reps: 8, note: '', completedAt: T + 5 * H } , v: { setNumber: 1 } })]), intent: gym([{ t: 'session', id: 'session0002', born: `${T + 5 * H}:0:srv`, life: ['dead', s(T + 9 * H)] }]) }),
    admitted('a delete of a finished session kills its sets', { state: base(), intent: gym([{ t: 'session', id: 'session0001', born: `${T + 2}:0:srv`, life: ['dead', s(T + 9 * H)] }]) }),
    admitted('a finish of a session finished before closedBy was recorded is ok and writes nothing', { state: only(legacy), intent: finish(T + 2 * H) }),
    admitted('a finish within 4 h of a stale close\'s last activity moves finishedAt to it', { state: only(stale), intent: finish(T + 2 * H) }),
    admitted('a finish more than 4 h after a stale close\'s last activity keeps finishedAt', { state: only(stale), intent: finish(T + 5 * H) }),
    admitted('a finish before the session\'s start is refused bad-instant', { state: only(stale), intent: finish(T - 1) }),
    admitted('an import creates a finished session and numbers its sets in argument order', { state: base(), intent: cmd('gym.importSession', importArgs()) }),
    admitted('an import crossing a finished session is refused session-overlap, naming it', { state: base(), intent: cmd('gym.importSession', importArgs({ startedAt: T + 1800_000, finishedAt: T + 2 * H, sets: [] })) }),
    admitted('an import starting at the instant a finished session ended does not cross it', { state: base(), intent: cmd('gym.importSession', importArgs({ startedAt: T + H, finishedAt: T + 2 * H, sets: [] })) }),
    admitted('an import ending at the instant a finished session started does not cross it', { state: base(), intent: cmd('gym.importSession', importArgs({ startedAt: T - H, finishedAt: T, sets: [] })) }),
    admitted('an empty import at a finished session\'s first instant crosses it: an empty span takes up its first instant', { state: base(), intent: cmd('gym.importSession', importArgs({ startedAt: T, finishedAt: T, sets: [] })) }),
    admitted('an import replayed with equal arguments is ok', { state: imported, intent: cmd('gym.importSession', importArgs()) }),
    admitted('an import replayed with other arguments is refused payload-conflict', { state: imported, intent: cmd('gym.importSession', importArgs({ finishedAt: T + 4 * H })) }),
    admitted('an import under a session its account holds from a start is refused payload-conflict', { state: base(), intent: cmd('gym.importSession', importArgs({ id: 'session0001' })) }),
    admitted('a correction replaces the workout: interval, name, kept sets rewritten, new sets created, the rest dead', { state: twoSets, intent: cmd('gym.correctSession', correction()) }),
    admitted('a correction keeps a kept set\'s rpe and note unless named', { state: twoSets, intent: cmd('gym.correctSession', correction({ sets: [{ id: 'set00000002', exerciseId: 'back-squat', setNumber: 1, weightKg: 62.5, reps: 8, completedAt: T + 300_000 }] })) }),
    admitted('an additive correction keeps unnamed sets and creates the missing set with its rpe and note', { state: twoSets, intent: cmd('gym.correctSession', correction({ preserveOtherSets: true, sets: [{ id: 'set00000009', exerciseId: 'back-squat', setNumber: 3, weightKg: 45, reps: 8, rpe: 7, note: 'Saved', completedAt: T + 900_000 }] })) }),
    admitted('an additive correction rewrites a named standing set in place and keeps its rpe and note', { state: twoSets, intent: cmd('gym.correctSession', correction({ preserveOtherSets: true, sets: [{ id: 'set00000002', exerciseId: 'back-squat', setNumber: 2, weightKg: 62.5, reps: 8, completedAt: T + 300_000 }] })) }),
    admitted('an additive correction refuses a number used by an unnamed set', { state: twoSets, intent: cmd('gym.correctSession', correction({ preserveOtherSets: true, sets: [{ id: 'set00000009', exerciseId: 'back-squat', setNumber: 1, weightKg: 45, reps: 8, completedAt: T + 900_000 }] })) }),
    admitted('an additive correction refuses an interval excluding an unnamed set', { state: twoSets, intent: cmd('gym.correctSession', correction({ preserveOtherSets: true, startedAt: T + 500_000, sets: [{ id: 'set00000009', exerciseId: 'back-squat', setNumber: 3, weightKg: 45, reps: 8, completedAt: T + 900_000 }] })) }),
    admitted('an additive correction checks the named set interval before retained number collisions', { state: twoSets, intent: cmd('gym.correctSession', correction({ preserveOtherSets: true, sets: [{ id: 'set00000009', exerciseId: 'back-squat', setNumber: 1, weightKg: 45, reps: 8, rpe: 7, note: 'Saved', completedAt: T + H + 1 }] })) }),
    admitted('an additive correction checks overlap before retained number collisions', { state: overlapping, intent: cmd('gym.correctSession', correction({ preserveOtherSets: true, sets: [{ id: 'set00000009', exerciseId: 'back-squat', setNumber: 1, weightKg: 45, reps: 8, rpe: 7, note: 'Saved', completedAt: T + 900_000 }] })) }),
    admitted('a correction of an open session is refused session-open', { state: withOpen(T + 8 * H), intent: cmd('gym.correctSession', correction({ sessionId: 'session0002', startedAt: T + 8 * H, finishedAt: T + 9 * H, sets: [{ id: 'set00000009', exerciseId: 'dip', setNumber: 1, weightKg: 0, reps: 5, completedAt: T + 8 * H }] })) }),
    admitted('a correction that moves a set to another movement is invalid', { state: twoSets, intent: cmd('gym.correctSession', correction({ sets: [{ id: 'set00000001', exerciseId: 'dip', setNumber: 1, weightKg: 0, reps: 5, completedAt: T + 900_000 }] })) }),
    admitted('a correction replayed with equal arguments is ok', { state: gymState({ rows: { [GYM_A]: [EXERCISE, ROUTINE, FINISHED, SET], [GYM_B]: [] }, product: { corrections: { [GYM_A]: { 'fix-000001': { sessionId: 'session0001', args: correction() } } } } }), intent: cmd('gym.correctSession', correction()) }),
    admitted('a correction replayed with other arguments is refused payload-conflict', { state: gymState({ rows: { [GYM_A]: [EXERCISE, ROUTINE, FINISHED, SET], [GYM_B]: [] }, product: { corrections: { [GYM_A]: { 'fix-000001': { sessionId: 'session0001', args: correction() } } } } }), intent: cmd('gym.correctSession', correction({ routineName: 'Other' })) }),
    admitted('closeStale closes the open session 4 h past its last activity', { state: withOpen(T + 5 * H), origin: SERVER_A, intent: cmd('gym.closeStale', {}) }),
  ];
}

function adversarial() {
  const phone = (extra = {}) => create('proposal', 'proposal003', s(T + 9 * H), {
    routineId: 'routine0001', intent: 'revise', proposedName: 'Lower A', summary: 'Heavier',
    changes: CHANGES, door: 'ask', connection: '', agent: '', ...extra,
  });
  const guarded = (extra = {}, guard = ROUTINE_GUARDS) => gym([phone(extra)], { guard });
  const deleteRoutine = { t: 'routine', id: 'routine0001', born: s(T + 1), life: ['dead', s(T + 9 * H)] };
  const stale = rec('session', 'session0001', { stamp: `${T + 2}:0:srv`, seq: 3,
    f: { startedAt: T, finishedAt: T + 600_000, closedBy: 'stale' } });
  const zero = rec('session', 'session0001', { stamp: '0:0:srv', seq: 1, f: { startedAt: 0 } });
  const only = (session, sets = []) => gymState({ rows: { [GYM_A]: [session, ...sets] } });
  const finish = (finishedAt) => cmd('gym.finish', { sessionId: 'session0001', finishedAt });
  const set = { id: 'set00000003', exerciseId: 'dip', weightKg: 0, reps: 10, completedAt: T + 2 * H + 60_000 };
  const importArgs = (extra = {}) => ({ id: 'session0003', startedAt: T + 2 * H, finishedAt: T + 3 * H, sets: [set], ...extra });
  const fixedSet = { id: 'set00000001', exerciseId: 'back-squat', setNumber: 1, weightKg: 80, reps: 5, completedAt: T + 60_000 };
  const correctArgs = (extra = {}) => ({ sessionId: 'session0001', requestId: 'fix-000001', startedAt: T,
    finishedAt: T + H, routineName: 'Lower A', sets: [fixedSet], ...extra });
  const correction = (sets) => cmd('gym.correctSession', correctArgs({ sets }));
  const open = rec('session', 'session0001', { stamp: `${T + 2}:0:srv`, seq: 3, f: { startedAt: T + 8 * H } });
  const prior = (number) => rec('set', 'set00000001', { stamp: s(T + 8 * H), seq: 4,
    f: { sessionId: 'session0001', exerciseId: 'dip', weightKg: 0, reps: 5, note: '', completedAt: T + 8 * H }, v: { setNumber: number } });
  const nextSet = (id = 'set00000009') => create('set', id, s(T + 9 * H), {
    sessionId: 'session0001', exerciseId: 'dip', weightKg: 0, reps: 5, note: '', completedAt: T + 9 * H,
  });
  const repeated = rec('routine', 'routine0001', { stamp: s(T + 1), seq: 2, f: {
    name: 'Lower A', revision: 1, createdEntries: 3, entries: [...SQUAT, { exerciseId: 'back-squat', sets: [{ reps: 3, weightKg: 90 }] }, { exerciseId: 'dip' }],
  } });
  const repeatedChanges = [
    { kind: 'retargeted', exerciseId: 'back-squat', before: CHANGES[0].before, after: { sets: [{ reps: 3, weightKg: 90 }] } },
    { kind: 'retargeted', exerciseId: 'back-squat', before: { sets: [{ reps: 3, weightKg: 90 }] }, after: CHANGES[0].before },
    { kind: 'removed', exerciseId: 'dip', before: {} },
  ];
  return [
    admitted('a phone proposal without either routine guard is invalid', { state: base(), intent: gym([phone()]) }),
    admitted('a phone proposal without the name guard is invalid', { state: base(), intent: guarded({}, ROUTINE_GUARDS.slice(0, 1)) }),
    admitted('a phone proposal without the entries guard is invalid', { state: base(), intent: guarded({}, ROUTINE_GUARDS.slice(1)) }),
    admitted('a phone proposal based on a moved entries stamp is stale', { state: base(), intent: guarded({}, ROUTINE_GUARDS.map((g) => g.field === 'entries' ? { ...g, stamp: s(T) } : g)) }),
    admitted('a phone proposal based on a moved name stamp is stale', { state: base(), intent: guarded({}, ROUTINE_GUARDS.map((g) => g.field === 'name' ? { ...g, stamp: s(T) } : g)) }),
    admitted('a guarded phone proposal with forged kept content is invalid', { state: base(), intent: guarded({ changes: [{ ...CHANGES[0], kind: 'kept' }] }) }),
    admitted('a guarded phone proposal with a forged before side is invalid', { state: base(), intent: guarded({ changes: [{ ...CHANGES[0], before: { sets: [{ reps: 1 }] } }] }) }),
    admitted('a guarded phone proposal omitting a removed base line is invalid', { state: base(), intent: guarded({ changes: [{ kind: 'added', exerciseId: 'dip', after: {} }] }) }),
    admitted('a server proposal with forged kept content is invalid', { state: base(), origin: SERVER_A,
      intent: gym([create('proposal', 'proposal003', null, { ...Object.fromEntries(Object.entries(phone().f).map(([k, v]) => [k, v[0]])), changes: [{ ...CHANGES[0], kind: 'kept' }] })]) }),
    admitted('a proposal guarded before a same-intent routine rename is invalid', { state: base(), intent: gym([
      update('routine', 'routine0001', s(T + 1), s(T + 9 * H), { name: 'Legs' }), phone(),
    ], { guard: ROUTINE_GUARDS }) }),
    admitted('a routine delete clears the same-intent start session routineId, retaining its frozen plan and history', { state: base(),
      intent: gym([deleteRoutine], { cmd: { name: 'gym.start', args: { id: 'session0002', routineId: 'routine0001', startedAt: T + 9 * H, joinOpenSession: true } } }) }),
    admitted('two same-key proposal creates supersede in intent order: only the second stays pending', { state: base(),
      intent: gym([phone(), { ...phone(), id: 'proposal004' }], { guard: ROUTINE_GUARDS }) }),
    admitted('three same-key proposal creates name their immediate successors', { state: base(),
      intent: gym([phone(), { ...phone(), id: 'proposal004' }, { ...phone(), id: 'proposal005' }], { guard: ROUTINE_GUARDS }) }),
    admitted('a routine and set may reference an exercise created in the same intent', { state: only(open), intent: gym([
      create('routine', 'routine0002', s(T + 9 * H), { name: 'Carry', entries: [{ exerciseId: 'sledpush01' }] }),
      create('exercise', 'sledpush01', s(T + 9 * H), { name: 'Sled Push', pattern: 'carry', equipment: 'machine', stepKg: 5 }),
      { ...nextSet(), f: { ...nextSet().f, exerciseId: ['sledpush01', s(T + 9 * H)] } },
    ]) }),
    admitted('a correction setNumber 2147483647 lands', { state: base(), intent: correction([{ ...fixedSet, setNumber: 2_147_483_647 }]) }),
    admitted('a correction setNumber 2147483648 is invalid', { state: base(), intent: correction([{ ...fixedSet, setNumber: 2_147_483_648 }]) }),
    admitted('automatic setNumber 2147483647 lands', { state: only(open, [prior(2_147_483_646)]), intent: gym([nextSet()]) }),
    admitted('automatic setNumber beyond 2147483647 is invalid', { state: only(open, [prior(2_147_483_647)]), intent: gym([nextSet()]) }),
    admitted('two same-intent sets crossing the serial maximum are invalid together', { state: only(open, [prior(2_147_483_646)]), intent: gym([nextSet(), nextSet('set00000010')]) }),
    admitted('a finish exactly 4 h after a stale close moves finishedAt to the boundary', { state: only(stale), intent: finish(T + 600_000 + 4 * H) }),
    admitted('closeStale closes exactly 4 h after the last activity', { state: only(rec('session', 'session0001', { stamp: `${T + 6 * H}:0:srv`, seq: 1, f: { startedAt: T + 6 * H } })), origin: SERVER_A, intent: cmd('gym.closeStale', {}) }),
    admitted('an import with duplicate set ids is invalid', { state: base(), intent: cmd('gym.importSession', importArgs({ sets: [set, { ...set, reps: 9 }] })) }),
    admitted('a correction with duplicate set ids is invalid', { state: base(), intent: correction([fixedSet, { ...fixedSet, setNumber: 2 }]) }),
    admitted('a correction with duplicate numbers for one movement is invalid', { state: base(), intent: correction([fixedSet, { ...fixedSet, id: 'set00000009' }]) }),
    admitted('an import ending 1 ms in the future is bad-instant', { state: base(), intent: cmd('gym.importSession', importArgs({ finishedAt: NOW + 1 })) }),
    admitted('a correction ending 1 ms in the future is bad-instant', { state: base(), intent: cmd('gym.correctSession', correctArgs({ finishedAt: NOW + 1 })) }),
    admitted('an import set 1 ms before its interval is bad-instant', { state: base(), intent: cmd('gym.importSession', importArgs({ sets: [{ ...set, completedAt: T + 2 * H - 1 }] })) }),
    admitted('an import set 1 ms after its interval is bad-instant', { state: base(), intent: cmd('gym.importSession', importArgs({ sets: [{ ...set, completedAt: T + 3 * H + 1 }] })) }),
    admitted('a correction set 1 ms before its interval is bad-instant', { state: base(), intent: correction([{ ...fixedSet, completedAt: T - 1 }]) }),
    admitted('a correction set 1 ms after its interval is bad-instant', { state: base(), intent: correction([{ ...fixedSet, completedAt: T + H + 1 }]) }),
    admitted('a finish at zero for a session starting at zero is bad-instant', { state: only(zero), intent: finish(0) }),
    admitted('a guarded removal proposal lists every base line as removed', { state: base(), intent: guarded({ intent: 'remove', changes: [{ kind: 'removed', exerciseId: 'back-squat', before: CHANGES[0].before }] }) }),
    admitted('a guarded revision proposal cannot leave an empty routine', { state: base(), intent: guarded({ changes: [{ kind: 'removed', exerciseId: 'back-squat', before: CHANGES[0].before }] }) }),
    admitted('a proposal matches repeated exercises first unmatched first, with removals last', { state: gymState({ rows: { [GYM_A]: [repeated] } }), intent: guarded({ changes: repeatedChanges }) }),
    admitted('a proposal cannot match repeated exercises by equal targets instead of occurrence', { state: gymState({ rows: { [GYM_A]: [repeated] } }), intent: guarded({ changes: repeatedChanges.map((line, i) => i < 2 ? { ...line, kind: 'kept', before: line.after } : line) }) }),
    admitted('a new correction setNumber 2147483647 lands', { state: base(), intent: correction([{ ...fixedSet, id: 'set00000009', setNumber: 2_147_483_647 }]) }),
    admitted('automatic numbering retains stored maximum even when that peer dies in the same intent', { state: only(open, [prior(2_147_483_647)]),
      intent: gym([{ t: 'set', id: 'set00000001', born: s(T + 8 * H), life: ['dead', s(T + 9 * H)] }, nextSet()]) }),
    admitted('a proposal created before a same-intent routine rename captures the joined base revision and name', { state: base(), origin: SERVER_A,
      intent: gym([create('proposal', 'proposal003', null, Object.fromEntries(Object.entries(phone().f).map(([k, v]) => [k, v[0]]))),
        update('routine', 'routine0001', s(T + 1), null, { name: 'Legs' })]) }),
  ];
}

// M10: the open workout's plan (A.2): a guarded client write, held to the plan revision rules, that moves
// planRevision once per net change and supersedes the workout's pending proposals.
const PLAN = { routine: 'Lower A', entries: [...SQUAT, { exerciseId: 'dip', sets: [{ reps: 8 }] }] };
const OPENED = `${T + 8 * H}:0:srv`;
const openWorkout = (extra = {}) => rec('session', 'session0002', {
  stamp: OPENED, seq: 6,
  f: { routineId: 'routine0001', historyRoutineId: 'routine0001', routineRevision: 1, plan: PLAN, startedAt: T + 8 * H, ...extra },
});
const SQUATTED = rec('set', 'set00000005', { stamp: s(T + 8 * H + 60_000), seq: 7, f: { sessionId: 'session0002', exerciseId: 'back-squat', weightKg: 80, reps: 5, note: '', completedAt: T + 8 * H + 60_000 }, v: { setNumber: 1 } });
const PLAN_GUARD = { t: 'session', id: 'session0002', field: 'plan', stamp: OPENED };
const WORKOUT_CHANGES = [
  { kind: 'kept', exerciseId: 'back-squat', before: { restSeconds: 180, sets: [{ reps: 5, weightKg: 80 }] }, after: { restSeconds: 180, sets: [{ reps: 5, weightKg: 80 }] } },
  { kind: 'retargeted', exerciseId: 'dip', before: { sets: [{ reps: 8 }] }, after: { sets: [{ reps: 8, weightKg: -10 }] } },
];
const workoutProposalRow = (id, seq, extra = {}) => rec('workoutProposal', id, {
  stamp: `${T + 9 * H}:0:srv`, seq,
  f: { sessionId: 'session0002', summary: 'Assisted dips', changes: WORKOUT_CHANGES, door: 'mcp', connection: 'conn-1', agent: 'Claude', state: 'pending', baseRevision: 1, changeCount: 1, ...extra },
});

function workoutPlans() {
  const inFlight = (a = [], session = openWorkout()) => base({ a: [session, SQUATTED, ...a] });
  const entries = (...more) => [...SQUAT, ...more];
  const write = (plan, guard = [PLAN_GUARD], extra = []) => gym([update('session', 'session0002', OPENED, s(T + 9 * H), { plan }), ...extra], { guard });
  const revised = (entryList) => write({ ...PLAN, entries: entryList });
  const lighterDips = entries({ exerciseId: 'dip', sets: [{ reps: 8, weightKg: -10 }] });
  const twoDips = { routine: 'Lower A', entries: [...PLAN.entries, { exerciseId: 'dip' }] };
  const freestyle = rec('session', 'session0002', { stamp: OPENED, seq: 6, f: { startedAt: T + 8 * H } });
  const quiet = rec('session', 'session0002', { stamp: `${T + 5 * H}:0:srv`, seq: 6, f: { routineId: 'routine0001', historyRoutineId: 'routine0001', plan: PLAN, startedAt: T + 5 * H } });
  const finishedPlan = { t: 'session', id: 'session0001', field: 'plan', stamp: `${T + 2}:0:srv` };
  const dipSet = create('set', 'set00000006', s(T + 9 * H), { sessionId: 'session0002', exerciseId: 'dip', weightKg: 0, reps: 8, note: '', completedAt: T + 9 * H });
  return [
    admitted('a guarded plan write retargeting a movement with nothing logged lands, moves planRevision to 2 and supersedes the workout\'s pending proposals', {
      state: inFlight([workoutProposalRow('wproposal01', 8), workoutProposalRow('wproposal02', 9, { door: 'ask', connection: '', agent: '' })]), intent: revised(lighterDips) }),
    admitted('a plan write adding a movement gives it an open line', { state: inFlight(), intent: revised([...PLAN.entries, { exerciseId: 'bench-press' }]) }),
    admitted('a plan write removing a movement with nothing logged lands', { state: inFlight(), intent: revised(SQUAT) }),
    admitted('a plan write moving a logged movement\'s entry, unchanged, lands', { state: inFlight(), intent: revised([PLAN.entries[1], PLAN.entries[0]]) }),
    admitted('a plan write without its guard is invalid', { state: inFlight(), intent: write({ ...PLAN, entries: lighterDips }, []) }),
    admitted('a plan write guarded at a moved stamp is stale', { state: inFlight(), intent: write({ ...PLAN, entries: lighterDips }, [{ ...PLAN_GUARD, stamp: s(T) }]) }),
    admitted('a plan write retargeting a logged movement is refused plan-logged, naming it', { state: inFlight(),
      intent: revised([{ ...SQUAT[0], sets: [{ reps: 5, weightKg: 85 }] }, PLAN.entries[1]]) }),
    admitted('a plan write adding a planned set to a logged movement is refused plan-logged', { state: inFlight(),
      intent: revised([{ ...SQUAT[0], sets: [{ reps: 5, weightKg: 80 }, { reps: 5, weightKg: 80 }] }, PLAN.entries[1]]) }),
    admitted('a plan write changing a logged movement\'s rest is refused plan-logged', { state: inFlight(),
      intent: revised([{ ...SQUAT[0], restSeconds: 120 }, PLAN.entries[1]]) }),
    admitted('a plan write removing a logged movement is refused plan-logged', { state: inFlight(), intent: revised([PLAN.entries[1]]) }),
    admitted('a plan write and a set on the movement it retargets, in one intent, is refused plan-logged', { state: inFlight(),
      intent: write({ ...PLAN, entries: lighterDips }, [PLAN_GUARD], [dipSet]) }),
    admitted('a plan write on a finished workout is refused session-finished', { state: base(),
      intent: gym([update('session', 'session0001', `${T + 2}:0:srv`, s(T + 9 * H), { plan: { routine: 'Lower A', entries: [{ exerciseId: 'dip' }] } })], { guard: [finishedPlan] }) }),
    admitted('a plan write on an open workout 4 h past its last activity is refused session-finished', { state: base({ a: [quiet] }),
      intent: gym([update('session', 'session0002', `${T + 5 * H}:0:srv`, s(T + 9 * H), { plan: { ...PLAN, entries: lighterDips } })], { guard: [{ ...PLAN_GUARD, stamp: `${T + 5 * H}:0:srv` }] }) }),
    admitted('a plan write renaming the plan is invalid', { state: inFlight(), intent: write({ ...PLAN, routine: 'Legs' }) }),
    admitted('a plan write on a workout started with no plan is invalid', { state: base({ a: [freestyle] }),
      intent: write({ routine: 'Lower A', entries: [{ exerciseId: 'dip' }] }, [{ ...PLAN_GUARD, stamp: null }]) }),
    admitted('a plan write clearing the plan is invalid', { state: inFlight(), intent: write(null) }),
    admitted('a plan write naming another account\'s movement is refused unknown-exercise', { state: inFlight(), intent: revised([...PLAN.entries, { exerciseId: 'beltsquat1' }]) }),
    admitted('a plan write adding a second entry of a movement is invalid', { state: inFlight(), intent: revised([...PLAN.entries, { exerciseId: 'dip' }]) }),
    admitted('a plan write keeps a second entry the routine froze', { state: inFlight([], openWorkout({ plan: twoDips })),
      intent: write({ ...twoDips, entries: [...PLAN.entries, { exerciseId: 'dip', sets: [{ reps: 5 }] }] }) }),
    admitted('a plan write with an empty set scheme is invalid', { state: inFlight(), intent: revised(entries({ exerciseId: 'dip', sets: [] })) }),
    admitted('a plan write off the plan\'s domain is invalid', { state: inFlight(), intent: revised(entries({ exerciseId: 'dip', sets: [{ reps: 0 }] })) }),
    admitted('a plan write restamping the plan it holds moves no planRevision', { state: inFlight(), intent: write(PLAN) }),
    admitted('a second net plan change moves planRevision from 2 to 3', { state: inFlight([], openWorkout({ planRevision: 2 })), intent: revised(lighterDips) }),
    admitted('a workout\'s delete kills its sets and workout proposals', { state: base({ a: [workoutProposalRow('wproposal01', 6, { sessionId: 'session0001' })] }),
      intent: gym([{ t: 'session', id: 'session0001', born: `${T + 2}:0:srv`, life: ['dead', s(T + 9 * H)] }]) }),
  ];
}

// M11: workout proposals (A.2): an agent's whole plan, diffed against the plan as it stands, applied or
// dismissed by the lifter, and out of date once replaced, outrun, moved on or finished.
function workoutProposals() {
  const inFlight = (a = [], session = openWorkout()) => base({ a: [session, SQUATTED, ...a] });
  const values = (extra = {}) => ({ sessionId: 'session0002', summary: 'Assisted dips', changes: WORKOUT_CHANGES, door: 'mcp', connection: 'conn-1', agent: 'Claude', ...extra });
  const mint = (id, extra = {}) => gym([create('workoutProposal', id, null, values(extra))]);
  const phone = (id, extra = {}, guard = [PLAN_GUARD]) => gym([create('workoutProposal', id, s(T + 9 * H), values({ door: 'ask', connection: '', agent: '', ...extra }))], { guard });
  const apply = (id = 'wproposal01') => cmd('gym.applyWorkoutProposal', { proposalId: id });
  const dismiss = (id = 'wproposal01') => cmd('gym.dismissWorkoutProposal', { proposalId: id });
  const pending = workoutProposalRow('wproposal01', 8);
  const settled = (state, extra = {}) => workoutProposalRow('wproposal01', 8, { state, settledAt: T + 9 * H, ...extra });
  const freestyle = rec('session', 'session0002', { stamp: OPENED, seq: 6, f: { startedAt: T + 8 * H } });
  const swap = [WORKOUT_CHANGES[0], { kind: 'added', exerciseId: 'bench-press', after: { sets: [{ reps: 8, weightKg: 60 }] } }, { kind: 'removed', exerciseId: 'dip', before: { sets: [{ reps: 8 }] } }];
  const dipSet = rec('set', 'set00000006', { stamp: s(T + 9 * H), seq: 9, f: { sessionId: 'session0002', exerciseId: 'dip', weightKg: 0, reps: 8, note: '', completedAt: T + 9 * H }, v: { setNumber: 1 } });
  const applied = admitted('apply writes the workout proposal\'s plan, moves planRevision and supersedes the workout\'s other pending proposals', {
    state: inFlight([pending, workoutProposalRow('wproposal02', 9, { door: 'ask', connection: '', agent: '' })]), intent: apply() });
  return [
    admitted('a workout proposal freezes the plan revision and change count, and supersedes the pending one of its workout, door and connection', {
      state: inFlight([pending]), origin: SERVER_A, intent: mint('wproposal02') }),
    admitted('a workout proposal of another connection leaves the pending one standing', { state: inFlight([pending]), origin: SERVER_A, intent: mint('wproposal02', { connection: 'conn-2', agent: 'Other' }) }),
    admitted('a workout proposal freezes the revision the plan stands at', { state: inFlight([], openWorkout({ planRevision: 4 })), origin: SERVER_A, intent: mint('wproposal02') }),
    admitted('a workout proposal swapping a movement with nothing logged counts the line added and the line removed', { state: inFlight(), origin: SERVER_A, intent: mint('wproposal02', { changes: swap }) }),
    admitted('a replica\'s workout proposal from the phone Coach door, guarded on the plan, is admitted', { state: inFlight(), intent: phone('wproposal02') }),
    admitted('a replica\'s workout proposal without its plan guard is invalid', { state: inFlight(), intent: phone('wproposal02', {}, []) }),
    admitted('a replica\'s workout proposal with door mcp is invalid', { state: inFlight(), intent: phone('wproposal02', { door: 'mcp' }) }),
    admitted('a workout proposal naming an absent workout is refused unknown-record', { state: inFlight(), origin: SERVER_A, intent: mint('wproposal02', { sessionId: 'session0404' }) }),
    admitted('a workout proposal for a finished workout is refused session-finished', { state: inFlight(), origin: SERVER_A, intent: mint('wproposal02', { sessionId: 'session0001',
      changes: [{ kind: 'retargeted', exerciseId: 'back-squat', before: { restSeconds: 180, sets: [{ reps: 5, weightKg: 80 }] }, after: { sets: [{ reps: 5, weightKg: 80 }] } }] }) }),
    admitted('a workout proposal for a workout started with no plan is invalid', { state: base({ a: [freestyle] }), origin: SERVER_A,
      intent: mint('wproposal02', { changes: [{ kind: 'added', exerciseId: 'dip', after: {} }] }) }),
    admitted('a workout proposal with a forged diff is invalid', { state: inFlight(), origin: SERVER_A, intent: mint('wproposal02', { changes: [WORKOUT_CHANGES[0], { ...WORKOUT_CHANGES[1], kind: 'kept' }] }) }),
    admitted('a workout proposal changing a logged movement is refused plan-logged', { state: inFlight(), origin: SERVER_A, intent: mint('wproposal02', {
      changes: [{ ...WORKOUT_CHANGES[0], kind: 'retargeted', after: { restSeconds: 180, sets: [{ reps: 3, weightKg: 90 }] } }, WORKOUT_CHANGES[1]] }) }),
    admitted('a workout proposal naming another account\'s movement is refused unknown-exercise', { state: inFlight(), origin: SERVER_A,
      intent: mint('wproposal02', { changes: [...WORKOUT_CHANGES, { kind: 'added', exerciseId: 'beltsquat1', after: {} }] }) }),
    applied,
    admitted('apply replayed after its receipt is ok and writes nothing', { state: applied.expect.state, intent: apply() }),
    admitted('apply of an applied workout proposal records its receipt without changing records', { state: inFlight([settled('applied')]), intent: apply() }),
    admitted('apply of a dismissed workout proposal is refused proposal-settled with its state', { state: inFlight([settled('dismissed')]), intent: apply() }),
    admitted('apply of a workout proposal a newer one replaced is refused proposal-superseded: replaced', { state: inFlight([settled('superseded', { supersededBy: 'wproposal09' })]), intent: apply() }),
    admitted('apply of a workout proposal a plan change superseded is refused proposal-superseded: workout-changed', {
      state: inFlight([settled('superseded')], openWorkout({ planRevision: 2 })), intent: apply() }),
    admitted('apply of a pending workout proposal whose base the plan outran is refused proposal-superseded: workout-changed, leaving it pending', {
      state: inFlight([pending], openWorkout({ planRevision: 2 })), intent: apply() }),
    admitted('apply of a pending workout proposal whose changed movement was logged since is refused proposal-superseded: workout-moved', {
      state: inFlight([pending, dipSet]), intent: apply() }),
    admitted('apply of a pending workout proposal of a finished workout is refused proposal-superseded: workout-finished', {
      state: base({ a: [workoutProposalRow('wproposal01', 6, { sessionId: 'session0001' })] }), intent: apply() }),
    admitted('apply of an absent workout proposal is refused unknown-record', { state: inFlight(), intent: apply('wproposal07') }),
    admitted('dismiss settles a pending workout proposal with its settledAt', { state: inFlight([pending]), intent: dismiss() }),
    admitted('dismiss runs no workout check on a pending workout proposal', { state: base({ a: [workoutProposalRow('wproposal01', 6, { sessionId: 'session0001' })] }), intent: dismiss() }),
    admitted('dismiss of an applied workout proposal is refused proposal-settled with its state', { state: inFlight([settled('applied')]), intent: dismiss() }),
    admitted('dismiss of a superseded workout proposal is refused proposal-superseded with its reason', { state: inFlight([settled('superseded', { supersededBy: 'wproposal09' })]), intent: dismiss() }),
    admitted('a routine proposal applied mid-workout changes the routine and leaves the running plan as it stands', { state: inFlight(), intent: cmd('gym.applyProposal', { proposalId: 'proposal001' }) }),
  ];
}

// M8: a display name holds more than whitespace once a writer names it; a stored one that does not stands
// until it is next changed.
function names() {
  const blank = '  　 ';
  const rename = (name, origin = A) => gym([update('exercise', 'sledpush01', s(T), origin === SERVER_A ? null : s(T + 9 * H), { name })]);
  const blankRoutine = rec('routine', 'routine0001', { stamp: s(T + 1), seq: 2, f: { name: '  ', position: 0, entries: SQUAT, revision: 1, createdEntries: 1 } });
  const titled = gymState({ rows: { [GYM_A]: [rec('note', 'note0000001', { stamp: s(T), seq: 1, f: { title: 'Grip', body: '', ord: 'a0', updatedAt: T } })], [GYM_B]: [] } });
  const proposal = (proposedName) => gym([{ t: 'proposal', id: 'proposal003', born: null, life: ['alive', null], f: regs(null, {
    routineId: 'routine0001', intent: 'revise', proposedName, summary: 'Lighter', changes: CHANGES, door: 'mcp', connection: 'conn-1', agent: 'Claude',
  }) }]);
  return [
    admitted('a custom movement renamed to whitespace is invalid', { state: base(), intent: rename('   ') }),
    admitted('a server-origin rename to whitespace is invalid alike', { state: base(), origin: SERVER_A, intent: rename(blank, SERVER_A) }),
    admitted('a custom movement created with a whitespace name is invalid', { state: base(), intent: gym([create('exercise', 'kbswing001', s(T + 9 * H), { name: '\t', pattern: 'hinge', equipment: 'kettlebell', stepKg: 4 })]) }),
    admitted('a seed renamed to whitespace is invalid', { state: base(), intent: gym([{ t: 'exerciseName', id: 'back-squat', f: regs(s(T + 9 * H), { name: blank }) }]) }),
    admitted('a name padded with whitespace is admitted as written: clients trim, admission refuses only a blank one', { state: base(), intent: rename(' Prowler ') }),
    admitted('a zero-width space is not whitespace: a name of one is admitted', { state: base(), intent: rename('​') }),
    admitted('a routine created with a whitespace name is invalid', { state: base(), intent: gym([create('routine', 'routine0002', s(T + 9 * H), { name: ' ', entries: [{ exerciseId: 'dip' }] })]) }),
    admitted('a routine renamed to whitespace is invalid', { state: base(), intent: gym([update('routine', 'routine0001', s(T + 1), s(T + 9 * H), { name: '\n' })]) }),
    admitted('a stored whitespace routine name stands through a position-only change', {
      state: gymState({ rows: { [GYM_A]: [EXERCISE, blankRoutine], [GYM_B]: [] } }),
      intent: gym([update('routine', 'routine0001', s(T + 1), s(T + 9 * H), { position: 4 })]) }),
    admitted('a note created with a whitespace title is invalid', { state: base(), intent: gym([create('note', 'note0000002', s(T + 9 * H), { title: blank, body: '', ord: 'a0' })]) }),
    admitted('a note retitled to whitespace is invalid', { state: titled, intent: gym([update('note', 'note0000001', s(T), s(T + 9 * H), { title: '  ' })]) }),
    admitted('a revision proposal whose proposedName is whitespace is invalid', { state: base(), origin: SERVER_A, intent: proposal('  ') }),
  ];
}

function historicalNames() {
  return [['empty', ''], ['ASCII blank', ' \t '], ['Unicode blank', '\u00a0\u2003\u202f\u3000\ufeff']].flatMap(([label, name]) => {
    const routine = rec('routine', 'routine0001', { stamp: s(T + 1), seq: 1,
      f: { name, position: 0, entries: SQUAT, revision: 1, createdEntries: 1 } });
    const state = gymState({ rows: { [GYM_A]: [routine] } });
    const propose = (intent, proposedName, origin) => gym([create('proposal', 'proposal003', origin === SERVER_A ? null : s(T + 9 * H), {
      routineId: routine.id, intent, proposedName, summary: '',
      changes: intent === 'remove' ? CHANGES.map(({ exerciseId, before }) => ({ kind: 'removed', exerciseId, before })) : CHANGES,
      door: origin === SERVER_A ? 'mcp' : 'ask', connection: '', agent: '',
    })], origin === A ? { guard: ROUTINE_GUARDS } : {});
    return [
      admitted(`historical ${label} routine accepts an entries-only edit`, { state,
        intent: gym([update('routine', routine.id, routine.born, s(T + 9 * H), { entries: [{ exerciseId: 'dip' }] })]) }),
      admitted(`historical ${label} routine accepts a valid rename`, { state,
        intent: gym([update('routine', routine.id, routine.born, s(T + 9 * H), { name: 'Readable name' })]) }),
      admitted(`historical ${label} routine remains readable when starting a workout`, { state,
        intent: cmd('gym.start', { id: 'session0002', routineId: routine.id, startedAt: NOW, joinOpenSession: true }) }),
      admitted(`historical ${label} routine refuses a new blank revision proposal`, { state, origin: SERVER_A,
        intent: propose('revise', name, SERVER_A) }),
      ...[A, SERVER_A].flatMap((origin) => {
        const input = { state, origin, serverNow: NOW,
          intent: gym([update('routine', routine.id, routine.born, origin === SERVER_A ? null : s(T + 9 * H), { name })]) };
        return [
          admitted(`historical ${label} routine accepts a ${origin.kind} rename proposal`, { state, origin,
            intent: propose('revise', 'Readable name', origin) }),
          admitted(`historical ${label} routine accepts a ${origin.kind} removal proposal`, { state, origin,
            intent: propose('remove', name, origin) }),
          vector(`historical ${label} routine refuses a ${origin.kind} write setting the same blank name`, input,
            { result: { s: 'refused', code: 'invalid' }, state }),
        ];
      }),
    ];
  });
}

// M7: notes order by `ord`; the cap counts alive notes.
function notes() {
  const note = (id, seq, ord) => rec('note', id, { stamp: s(T + seq), seq, f: { title: `Note ${seq}`, body: '', ord, updatedAt: T } });
  const ten = gymState({ rows: { [GYM_A]: Array.from({ length: 10 }, (_, i) => note(`note000000${i}`, i + 1, `a${i}`)), [GYM_B]: [] } });
  return [
    admitted('an eleventh note is refused cap', { state: ten, intent: gym([create('note', 'note000000x', s(T + 9 * H), { title: 'More', body: '', ord: 'a9V' })]) }),
    admitted('an edit at ten notes lands', { state: ten, intent: gym([update('note', 'note0000000', s(T + 1), s(T + 9 * H), { body: 'Edited' })]) }),
    admitted('a reorder writes the moved note\'s ord', { state: ten, intent: gym([update('note', 'note0000009', s(T + 10), s(T + 9 * H), { ord: 'Zz' })]) }),
  ];
}

function metadata() {
  const make = (id, door) => gym([create('routine', id, null, {
    name: 'Upper', entries: [{ exerciseId: 'dip' }, { exerciseId: 'bench-press' }], ...(door ? { createdDoor: door } : {}),
  })]);
  const created = admit({ state: new ServerState(base()), registry: gymRegistry, product: gymProduct,
    origin: SERVER_A, intent: make('routine0002', 'ask'), serverNow: NOW }).state;
  const routine = created.row(GYM_A, 'routine', 'routine0002');
  const edit = gym([update('routine', routine.id, routine.born, null, { name: 'Edited', entries: [{ exerciseId: 'dip' }] })]);
  const edited = admit({ state: created, registry: gymRegistry, product: gymProduct, origin: SERVER_A, intent: edit, serverNow: NOW + 1000 }).state;
  const remove = gym([{ t: 'routine', id: routine.id, born: routine.born, life: ['dead', null] }]);
  const note = rec('note', 'note0000001', { stamp: s(T), seq: 6, f: { title: 'Grip', body: '', ord: 'a0', updatedAt: T } });
  const noteState = gymState({ rows: { [GYM_A]: [note] } });
  const noteEdit = (f, stamp = null) => gym([update('note', note.id, note.born, stamp, f)]);
  const reordered = admit({ state: new ServerState(noteState), registry: gymRegistry, product: gymProduct, origin: SERVER_A,
    intent: noteEdit({ ord: 'Zz' }), serverNow: NOW }).state;
  const changed = admit({ state: reordered, registry: gymRegistry, product: gymProduct, origin: SERVER_A,
    intent: noteEdit({ body: 'New body' }), serverNow: NOW + 1000 }).state;
  const two = rec('routine', 'routine0001', { stamp: s(T + 1), seq: 1, f: { name: 'Lower A', revision: 7, createdEntries: 3,
    entries: [{ exerciseId: 'back-squat' }, { exerciseId: 'dip' }] } });
  const propose = (proposedName, changes, intent = 'revise') => gym([create('proposal', 'proposal003', null, {
    routineId: two.id, intent, proposedName, changes, summary: '', door: 'ask', connection: '', agent: '',
  })]);
  const kept = (id) => ({ kind: 'kept', exerciseId: id, before: {}, after: {} });
  const proposalState = gymState({ rows: { [GYM_A]: [two] } });
  const renameAndReorder = propose('Renamed', [kept('dip'), kept('back-squat')]);
  const frozen = admit({ state: new ServerState(proposalState), registry: gymRegistry, product: gymProduct, origin: SERVER_A,
    intent: renameAndReorder, serverNow: NOW }).state;
  return [
    admitted('R118 an ask creation freezes a separate snapshot and original entry count', { state: base(), origin: SERVER_A, intent: make('routine0002', 'ask') }),
    admitted('R118 a manual creation carries its count but invents no Coach snapshot', { state: base(), origin: SERVER_A, intent: make('routine0002') }),
    admitted('R118 an MCP creation invents no Coach snapshot', { state: base(), origin: SERVER_A, intent: make('routine0002', 'mcp') }),
    admitted('R118 a name and entries edit increments revision once and preserves creation metadata', { state: created.toJSON(), origin: SERVER_A, intent: edit, serverNow: NOW + 1000 }),
    admitted('R118 replaying equal routine values preserves revision and original count', { state: edited.toJSON(), origin: SERVER_A, intent: edit, serverNow: NOW + 2000 }),
    admitted('R118 a routine death preserves its independent creation snapshot', { state: edited.toJSON(), origin: SERVER_A, intent: remove, serverNow: NOW + 2000 }),
    admitted('R118 a losing routine write changes no revision', { state: base(), intent: gym([update('routine', 'routine0001', ROUTINE.born, s(T), { name: 'Lost' })]) }),
    admitted('R118 note creation sets content admission time', { state: base(), origin: SERVER_A, intent: gym([create('note', 'note0000001', null, { title: 'Grip', body: '', ord: 'a0' })]) }),
    admitted('R118 note reorder advances ru while preserving content time', { state: noteState, origin: SERVER_A, intent: noteEdit({ ord: 'Zz' }) }),
    admitted('R118 a note body edit advances content time after reorder', { state: reordered.toJSON(), origin: SERVER_A, intent: noteEdit({ body: 'New body' }), serverNow: NOW + 1000 }),
    admitted('R118 an equal note body retry preserves content time', { state: changed.toJSON(), origin: SERVER_A, intent: noteEdit({ body: 'New body' }), serverNow: NOW + 2000 }),
    admitted('R118 a losing note title write preserves content time', { state: changed.toJSON(), intent: noteEdit({ title: 'Lost' }, s(T - 1)), serverNow: NOW + 2000 }),
    admitted('R118 a note title edit uses server admission time rather than the replica stamp', { state: noteState, intent: noteEdit({ title: 'Changed' }, s(T + H)) }),
    admitted('R118 proposal count includes one rename and one reorder with no moved targets', { state: proposalState, origin: SERVER_A, intent: renameAndReorder }),
    admitted('R118 insertion and removal without surviving-line reorder count only moved rows', { state: proposalState, origin: SERVER_A,
      intent: propose('Lower A', [kept('dip'), { kind: 'added', exerciseId: 'bench-press', after: {} }, { kind: 'removed', exerciseId: 'back-squat', before: {} }]) }),
    admitted('R118 a removal uses the stored count formula including a changed proposed name', { state: proposalState, origin: SERVER_A,
      intent: propose('', [{ kind: 'removed', exerciseId: 'back-squat', before: {} }, { kind: 'removed', exerciseId: 'dip', before: {} }], 'remove') }),
    admitted('R118 supersession preserves frozen base name revision and count', { state: frozen.toJSON(), origin: SERVER_A,
      intent: gym([update('routine', two.id, two.born, null, { name: 'Later', entries: [{ exerciseId: 'bench-press' }] })]), serverNow: NOW + 1000 }),
    ...[false, true].map((proposalFirst) => {
      const deltas = [update('routine', two.id, two.born, null, { name: 'Renamed' }), ...renameAndReorder.d];
      return admitted(`R118 mixed intent freezes joined base and supersedes the proposal with ${proposalFirst ? 'proposal' : 'routine'} first`, {
        state: proposalState, origin: SERVER_A, intent: gym(proposalFirst ? deltas.reverse() : deltas),
      });
    }),
    ...[['routine', 'revision'], ['routine', 'createdEntries'], ['proposal', 'baseRevision'], ['proposal', 'baseName'], ['proposal', 'changeCount'], ['note', 'updatedAt'],
      ['session', 'planRevision'], ['session', 'routineRevision'], ['workoutProposal', 'baseRevision'], ['workoutProposal', 'changeCount']].map(([t, field]) =>
      admitted(`R118 a replica cannot write ${t}.${field}`, { state: base(), intent: gym([create(t, 'forged0001', s(NOW), { [field]: field === 'baseName' ? 'Forged' : 1 })]) })),
    admitted('R118 a server door cannot supply derived routine metadata', { state: base(), origin: SERVER_A, intent: gym([create('routine', 'forged0001', null, { name: 'Forged', entries: SQUAT, revision: 99 })]) }),
    admitted('R118 a server door cannot supply metadata on an absent routine delete', { state: base(), origin: SERVER_A,
      intent: gym([{ t: 'routine', id: 'missing001', born: null, life: ['dead', null], f: regs(null, { revision: 99 }) }]) }),
    admitted('R118 a server door cannot supply metadata on a spent routine delete', { state: base({
      spent: { [GYM_A]: [{ t: 'routine', id: 'routine0009', born: s(T), lifeStamp: s(T + H), seq: 6 }] },
    }), origin: SERVER_A, intent: gym([{ t: 'routine', id: 'routine0009', born: null, life: ['dead', null], f: regs(null, { revision: 99 }) }]) }),
    admitted('R118 a replica cannot supply a creation snapshot', { state: base(), intent: gym([{ t: 'routineCreation', id: 'forged0001', f: regs(s(NOW), { snapshot: {} }) }]) }),
    admitted('R118 a bare server door cannot create or replace a snapshot', { state: created.toJSON(), origin: SERVER_A, intent: gym([{ t: 'routineCreation', id: routine.id, f: regs(null, { snapshot: {} }) }]) }),
    admitted('R118 a bare server door cannot submit an empty delta for an existing snapshot', { state: created.toJSON(), origin: SERVER_A,
      intent: gym([{ t: 'routineCreation', id: routine.id }]) }),
    admitted('R118 a replica cannot create an empty snapshot record', { state: base(), intent: gym([{ t: 'routineCreation', id: 'forged0001' }]) }),
  ];
}

// M9: Coach conversations (gym Coach §9.1): a turn's records in one intent, the lifter's bounds, the Coach message's
// writer, the state rank, what is final once the writer has ended, and a conversation's death.
function conversations() {
  const THREAD = rec('thread', 'thread000001', { stamp: s(T + 6), seq: 6, f: { title: 'How heavy today?' } });
  const LIFTER = rec('message', 'lifter000001', { stamp: s(T + 6), seq: 7, f: { threadId: 'thread000001', role: 'lifter', text: 'How heavy today?', at: T + 6 } });
  const coachRow = (state, extra = {}) => rec('message', 'turn00000001', {
    stamp: s(T + 6), seq: 8, f: { threadId: 'thread000001', role: 'coach', replica: A.replica, state, at: T + 6, ...extra },
  });
  const RUNNING = coachRow('running');
  // Interrupted by another device after the turn began: its state register alone carries the later stamp.
  const INTERRUPTED = { ...RUNNING, f: { ...RUNNING.f, state: ['interrupted', s(T + 7)] } };
  const COMPLETED = coachRow('completed', { text: 'Add 2.5 kg.', receipt: { reads: { sessions: ['session0001'] }, results: [] }, calls: [{ name: 'list_sessions' }] });
  // The phone Coach's proposal, minted in the conversation: the ask door, no connection or agent.
  const LINKED = proposalRow('proposal002', 9, { threadId: 'thread000001', door: 'ask', connection: '', agent: '' });
  const conversation = (...rows) => base({ a: [THREAD, LIFTER, ...rows] });
  const coach = (stamp, values) => update('message', 'turn00000001', s(T + 6), stamp, values);
  const ending = { state: 'completed', text: 'Add 2.5 kg.', receipt: { reads: { sessions: ['session0001'] }, results: [] }, calls: [{ name: 'list_sessions' }], truncated: false };
  const turn = (lifter = {}, coachFields = {}) => gym([
    create('thread', 'thread000001', s(T + 6), { title: 'How heavy today?' }),
    create('message', 'lifter000001', s(T + 6), { threadId: 'thread000001', role: 'lifter', text: 'How heavy today?', at: T + 6, ...lifter }),
    create('message', 'turn00000001', s(T + 6), { threadId: 'thread000001', role: 'coach', replica: A.replica, state: 'running', at: T + 6, ...coachFields }),
  ]);
  return [
    admitted('a phone turn creates the conversation, the lifter message and the running Coach message in one intent', { state: base(), intent: turn() }),
    admitted('a lifter message with a picture is admitted', { state: base(), intent: turn({ pictures: [{ id: 'picture00001', mediaType: 'image/jpeg', localOnly: true }] }) }),
    admitted('a picture entry without its media type is refused invalid', { state: base(), intent: turn({ pictures: [{ id: 'picture00001' }] }) }),
    admitted('a lifter message beyond 8,000 bytes is refused invalid', { state: base(), intent: turn({ text: 'é'.repeat(4001) }) }),
    admitted('a lifter message of 8,000 bytes is admitted', { state: base(), intent: turn({ text: 'é'.repeat(4000) }) }),
    admitted('a lifter message carrying a Coach register is refused invalid', { state: base(), intent: turn({ state: 'completed' }) }),
    admitted('a Coach message created without its replica is refused invalid', { state: base(), intent: gym([turn().d[0], turn().d[1], { ...turn().d[2], f: regs(s(T + 6), { threadId: 'thread000001', role: 'coach', state: 'running', at: T + 6 }) }]) }),
    admitted('a message created without its role is refused invalid', { state: base(), intent: gym([turn().d[0], { ...turn().d[1], f: regs(s(T + 6), { threadId: 'thread000001', text: 'Hi', at: T + 6 }) }]) }),
    admitted('a message created without its time is refused invalid', { state: base(), intent: gym([turn().d[0], { ...turn().d[1], f: regs(s(T + 6), { threadId: 'thread000001', role: 'lifter', text: 'Hi' }) }]) }),
    admitted('a message whose conversation is unknown is refused parent-dead', { state: base(), intent: gym([turn().d[1]]) }),
    admitted('a conversation created without its title is refused invalid', { state: base(), intent: gym([create('thread', 'thread000001', s(T + 6))]) }),
    admitted('a Coach answer beyond 128 KiB is refused invalid', { state: conversation(RUNNING), intent: gym([coach(s(T + 8), { text: 'a'.repeat(131_073) })]) }),
    admitted('a receipt beyond 16 KiB of JCS is refused invalid', { state: conversation(RUNNING), intent: gym([coach(s(T + 8), { receipt: { reads: 'r'.repeat(16_400) } })]) }),
    admitted('the writer ends its turn with its text, receipt, calls and truncation', { state: conversation(RUNNING), intent: gym([coach(s(T + 8), ending)]) }),
    admitted('a server-origin interrupted lands on a running Coach message', { state: conversation(RUNNING), origin: SERVER_A, intent: gym([coach(null, { state: 'interrupted' })]) }),
    admitted('a writer terminal write is admitted over interrupted, whatever the stamps', { state: conversation(INTERRUPTED), intent: gym([coach(s(T + 5), ending)]) }),
    ...[['state', 'interrupted'], ['text', 'Add 5 kg.'], ['receipt', {}], ['calls', []]].map(([field, value]) =>
      admitted(`a write of ${field} after the writer ended its turn is refused message-final`, { state: conversation(COMPLETED), intent: gym([coach(s(T + 9), { [field]: value })]) })),
    admitted('a server-origin interrupted after the writer ended its turn is refused message-final', { state: conversation(COMPLETED), origin: SERVER_A, intent: gym([coach(null, { state: 'interrupted' })]) }),
    admitted('truncated stays writable after the writer ended its turn', { state: conversation(COMPLETED), intent: gym([coach(s(T + 9), { truncated: true })]) }),
    admitted('a completed Coach message can be deleted', { state: conversation(COMPLETED), intent: gym([{ t: 'message', id: 'turn00000001', born: s(T + 6), life: ['dead', s(T + 9)] }]) }),
    admitted('a server-origin proposal create names the conversation it was minted in', { state: conversation(COMPLETED), origin: SERVER_A,
      intent: gym([create('proposal', 'proposal003', null, { routineId: 'routine0001', intent: 'revise', proposedName: 'Lower A', summary: 'Heavier squat', changes: CHANGES, door: 'ask', connection: '', agent: '', threadId: 'thread000001' })]) }),
    admitted('a conversation delete kills its messages and unlinks the proposals naming it', { state: conversation(COMPLETED, LINKED), intent: gym([{ t: 'thread', id: 'thread000001', born: s(T + 6), life: ['dead', s(T + 9)] }]) }),
  ];
}

export function files() {
  return {
    'gym/admit.json': [...weighins(), ...catalog(), ...sets(), ...routines(), ...proposals(), ...sessions(), ...notes(), ...names(), ...historicalNames(), ...adversarial(), ...metadata(), ...conversations(), ...workoutPlans(), ...workoutProposals()],
  };
}
