import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CONSTANTS } from '../../core/constants.js';
import { scopeDigest } from '../../core/digest.js';
import { jcs } from '../../core/jcs.js';
import { compareRecords, isAlive, recordKey } from '../../core/rows.js';
import { admit } from '../../server/admit.js';
import { scopeKeyOf } from '../../server/access.js';
import { deathFrameFor, hello, pull } from '../../server/pull.js';
import { ServerState } from '../../server/state.js';
import { Rng, product, registry, serverState } from '../../vectors/fixtures.js';

const read = (path) => JSON.parse(readFileSync(new URL(`../../../corpus/${path}`, import.meta.url), 'utf8'));

test('pull/serve.json replays through pull', () => {
  for (const { name, input, expect } of read('pull/serve.json')) {
    const out = pull({ state: new ServerState(input.state), registry, product, account: input.account, credential: input.credential, request: input.request, serverNow: input.serverNow, limits: { ...CONSTANTS, ...(input.limits ?? {}) } });
    assert.equal(jcs(out.response), jcs(expect.response), name);
    assert.equal(jcs(out.state.toJSON()), jcs(expect.state ?? input.state), name);
    assert.equal(jcs(out.live), jcs(expect.live ?? []), name);
  }
});

test('live/death.json replays through deathFrameFor', () => {
  for (const { name, input, expect } of read('live/death.json')) {
    const target = scopeKeyOf(registry, input.scope, input.account);
    assert.equal(jcs(deathFrameFor(new ServerState(input.state), target.key, input.account)), jcs(expect.frame), name);
  }
});

test('pull/hello.json replays through hello', () => {
  for (const { name, input, expect } of read('pull/hello.json')) {
    assert.equal(jcs(hello({ state: new ServerState(input.state), registry, account: input.account, credential: input.credential, serverTime: input.serverTime })), jcs(expect.response), name);
  }
});

// A random history of writes to A's product scope: cards (capped, spent when dead), boards (kept thin
// when dead), runs through probe.start and their laps (killed with the run).
function writer(rng) {
  let clock = 1000;
  const next = () => `${(clock += 1 + rng.int(3))}:0:r_aaaaaaaaaaaa`;
  return (state) => {
    const alive = (t) => state.rowsOf('acct:A/probe').filter((row) => row.t === t && isAlive(row));
    const pick = rng.int(6);
    const s = next();
    let intent;
    if (pick === 0) intent = { scope: 'self/probe', d: [{ t: 'card', id: `card${String(rng.int(9)).padStart(4, '0')}`, born: s, life: ['alive', s], f: { title: ['T', s] } }] };
    else if (pick === 1 && alive('card').length) {
      const card = rng.pick(alive('card'));
      intent = { scope: 'self/probe', d: [rng.chance(0.5) ? { t: 'card', id: card.id, born: card.born, life: ['dead', s] } : { t: 'card', id: card.id, born: card.born, f: { title: [rng.pick(['a', 'b']), s] } }] };
    } else if (pick === 2) intent = { scope: 'self/probe', d: [{ t: 'board', id: `b_0000000${rng.int(4)}`, born: s, life: ['alive', s] }] };
    else if (pick === 3) intent = { scope: 'self/probe', cmd: { name: 'probe.start', args: { id: `run${String(rng.int(99)).padStart(5, '0')}`, startedAt: 1000, join: true } } };
    else if (pick === 4 && alive('run').length) {
      const run = rng.pick(alive('run'));
      intent = { scope: 'self/probe', d: [{ t: 'lap', id: `lap${String(rng.int(999)).padStart(5, '0')}`, born: s, life: ['alive', s], f: { runId: [run.id, s], at: [1000, s], weight: [1, s] } }] };
    } else if (alive('run').length) {
      const run = rng.pick(alive('run'));
      intent = { scope: 'self/probe', d: [{ t: 'run', id: run.id, born: run.born, life: ['dead', s] }] };
    } else return state;
    return admit({ state, registry, product, origin: { kind: 'replica', account: 'A' }, intent, serverNow: 2_000_000 }).state;
  };
}

// INV-5 and the server half of INV-15: a replica that boots, with writes landing between its pages,
// and then pulls live until `more` is false holds exactly the scope's alive rows, and the last page's
// digest is the digest of those rows.
test('paging through writes ends at the head holding exactly the alive rows, with a matching digest', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const rng = new Rng(seed);
    const write = writer(rng);
    let state = new ServerState(serverState({ scopes: { 'acct:A/probe': { kind: 'product', owner: 'A' } } }));
    for (let i = 0; i < 12; i += 1) state = write(state);
    const held = new Map();
    let cursor = null;
    let page;
    for (let round = 0; round < 200; round += 1) {
      const limits = { ...CONSTANTS, PULL_PAGE_BYTES: 100 + rng.int(400) };
      const out = pull({ state, registry, product, account: 'A', request: { scopes: [{ scope: 'self/probe', cursor }] }, serverNow: 2_000_000, limits });
      state = out.state;
      page = out.response.body.pages[0];
      for (const row of page.rows) {
        const key = recordKey(row.t, row.id);
        if (isAlive(row)) held.set(key, row);
        else held.delete(key);
      }
      cursor = page.cursor;
      if (!page.more && rng.chance(0.7)) break;
      if (rng.chance(0.4)) state = write(state);
    }
    const truth = state.rowsOf('acct:A/probe').filter(isAlive).sort(compareRecords);
    const mine = [...held.values()].sort(compareRecords);
    assert.equal(page.more, false, `seed ${seed}`);
    assert.equal(jcs(mine), jcs(truth), `seed ${seed}`);
    assert.equal(page.digest, scopeDigest(truth), `seed ${seed}`);
    assert.equal(page.digest, state.scope('acct:A/probe').digest, `seed ${seed}`);
  }
});
