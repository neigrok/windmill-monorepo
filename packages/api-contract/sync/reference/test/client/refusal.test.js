// §11.2 property 8, clock-skew recovery terminates (INV-14): a device an hour or more ahead of the
// reference server creates, edits and deletes records, holds creates and keyed puts, undoes and retires
// them, sends creates the server refuses `invalid` and atomic entries that depend on them in part, while
// 409s and restores under a new epoch return its numbered entries to ready. With the server clock held
// still, every entry is acked or ends, and none is refused clock-skew twice.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { steadyTiming } from '../../core/clock.js';
import { isAlive } from '../../core/rows.js';
import { commit } from '../../client/commit.js';
import { releaseAll, undo } from '../../client/hold.js';
import { Replica } from '../../client/replica.js';
import { nextPush, onPushResponse } from '../../client/sender.js';
import { drawn, stored } from '../../client/views.js';
import { push } from '../../server/push.js';
import { ServerState } from '../../server/state.js';
import { ACTOR, Rng, product, registry } from '../../vectors/fixtures.js';

const SERVER_NOW = 1_000_000;
const DAYS = ['2026-09-01', '2026-09-02', '2026-09-03'];

test('clock-skew recovery terminates when 409s, epoch changes, holds, undo, retire and orphans meet later gestures on the same records', () => {
  const tally = { undone: 0, retired: 0, folded: 0, orphans: 0, orphansAdmitted: 0, recovered: 0 };
  for (let seed = 1; seed <= 500; seed += 1) {
    const rng = new Rng(seed);
    let server = ServerState.empty({ epoch: 'ep-0', accounts: { A: { name: 'Ann' } } });
    let epochs = 0;
    let replicas = 1;
    let actors = 0;
    let gestures = 0;
    const replica = Replica.fresh({ replica: 'rp_00000000000000000000000000000001', state: 'bound', account: 'A' });
    const deviceNow = SERVER_NOW + 3_600_000 + rng.int(3_600_000);
    const ctx = {
      registry,
      actor: ACTOR,
      deviceNow,
      ended: [],
      telemetry: [],
      appVersion: '1',
      nextGestureId: () => `g${(gestures += 1)}`,
      newReplicaId: () => `rp_${String((replicas += 1)).padStart(32, '0')}`,
      newActor: () => `r_${String((actors += 1)).padStart(12, 'c')}`,
      draw: (size) => rng.int(size),
    };
    const skews = new Map();
    const serve = (request) => {
      const out = push({ state: server, registry, product, account: 'A', request, serverNow: SERVER_NOW });
      server = out.state;
      return out.response;
    };
    const answer = (request, response) => {
      for (const result of response.body.results ?? []) {
        if (result.s !== 'refused' || result.code !== 'clock-skew') continue;
        const entry = replica.entries().find((candidate) => candidate.state === 'sent' && candidate.n === result.n);
        if (entry) skews.set(entry.localId, (skews.get(entry.localId) ?? 0) + 1);
      }
      onPushResponse(replica, ctx, request, response, steadyTiming(deviceNow, deviceNow));
    };

    for (let step = 0; step < 30; step += 1) {
      const alive = [...drawn(replica, registry, 'self/probe').values()].filter(isAlive);
      const storedCards = [...stored(replica, registry, 'self/probe').values()].filter((record) => record.t === 'card' && isAlive(record));
      const cards = alive.filter((record) => record.t === 'card');
      const held = replica.entries().filter((entry) => entry.state === 'held');
      const heldDays = held.filter((entry) => entry.intent.d?.length === 1 && entry.intent.d[0].t === 'day' && entry.intent.d[0].life[0] === 'dead');
      const roll = rng.int(12);
      if (roll === 0 && storedCards.length < 3) commit(replica, ctx, 'self/probe', [{ op: 'create', t: 'card', f: { title: rng.chance(0.3) ? 'Thirteen char' : `card ${step}` } }], { hold: rng.chance(0.4) });
      else if (roll === 1) commit(replica, ctx, 'self/probe', [{ op: 'create', t: 'board' }], { hold: rng.chance(0.3) });
      else if (roll === 2 && alive.some((record) => record.t !== 'day')) {
        const record = rng.pick(alive.filter((candidate) => candidate.t !== 'day'));
        commit(replica, ctx, 'self/probe', [{ op: 'delete', t: record.t, id: record.id }], { hold: rng.chance(0.5) });
      } else if (roll === 3 && cards.length) {
        commit(replica, ctx, 'self/probe', [{ op: 'update', t: 'card', id: rng.pick(cards).id, f: { title: `renamed ${step}` } }]);
      } else if (roll === 4) {
        const day = rng.pick(DAYS);
        const removes = alive.some((record) => record.t === 'day' && record.id === day) && rng.chance(0.5);
        commit(replica, ctx, 'self/probe', [{ op: 'put', t: 'day', id: day, present: !removes, f: rng.chance(0.7) ? { score: rng.int(11) } : {} }], { hold: removes || rng.chance(0.4) });
      } else if (roll === 5 && heldDays.length) {
        const day = rng.pick(heldDays).intent.d[0].id;
        tally.retired += commit(replica, ctx, 'self/probe', [{ op: 'put', t: 'day', id: day, f: { score: rng.int(11) } }], { retire: [{ t: 'day', id: day }] }).retired.length;
      } else if (roll === 6 && held.length) {
        if (undo(replica, registry, ctx.ended, rng.pick(held).gestureId)) tally.undone += 1;
      } else if (roll === 7) releaseAll(replica, registry, ctx.ended);
      else if (roll === 8 && cards.length && storedCards.length < 3) {
        const card = rng.pick(cards);
        const touch = rng.chance(0.5) ? { op: 'delete', t: 'card', id: card.id } : { op: 'update', t: 'card', id: card.id, f: { body: `body ${step}` } };
        commit(replica, ctx, 'self/probe', [touch, { op: 'create', t: 'card', f: { title: `new ${step}` } }], { atomic: true, hold: rng.chance(0.2) });
      }
      else {
        const request = nextPush(replica, ctx);
        if (request === null) continue;
        const fault = rng.int(4);
        if (fault === 0) answer(request, { status: 409, body: { serverTime: SERVER_NOW, epoch: server.epoch, error: 'gap' } });
        else if (fault === 1) serve(request);
        else {
          if (fault === 2) server = new ServerState({ ...server.toJSON(), epoch: `ep-${(epochs += 1)}` });
          answer(request, serve(request));
        }
      }
    }

    releaseAll(replica, registry, ctx.ended);
    for (let round = 0; round < 40; round += 1) {
      const request = nextPush(replica, ctx);
      if (request === null) break;
      answer(request, serve(request));
    }
    const unsettled = replica.entries().filter((entry) => entry.state !== 'acked').map((entry) => `${entry.localId}:${entry.state}`);
    assert.deepEqual(unsettled, [], `seed ${seed}: every entry is acked or ends with the server clock held still`);
    assert.deepEqual([...skews].filter(([, count]) => count > 1), [], `seed ${seed}: no entry is refused clock-skew twice`);
    tally.recovered += skews.size;
    tally.folded += ctx.ended.filter((end) => end.event === 'silent-fold').length;
    tally.orphans += ctx.ended.filter((end) => end.event === 'refuse' && end.orphanOf !== undefined).length;
    tally.orphansAdmitted += replica.entries().filter((entry) => entry.orphanOf !== undefined && entry.state === 'acked').length;
  }
  assert.ok(tally.undone > 400, `only ${tally.undone} held gestures were undone`);
  assert.ok(tally.retired > 30, `only ${tally.retired} held gestures were retired`);
  assert.ok(tally.folded > 40, `only ${tally.folded} entries folded silently`);
  assert.ok(tally.recovered > 600, `only ${tally.recovered} entries recovered from clock-skew`);
  assert.ok(tally.orphans > 30, `only ${tally.orphans} orphans were refused`);
  assert.ok(tally.orphansAdmitted > 10, `only ${tally.orphansAdmitted} orphans were admitted`);
});
