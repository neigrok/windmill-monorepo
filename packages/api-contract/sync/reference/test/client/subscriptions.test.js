import assert from 'node:assert/strict';
import test from 'node:test';
import { Replica } from '../../client/replica.js';
import { Doubts, firstPullComplete, reconcile, subscriptionsOf } from '../../client/subscriptions.js';
import { registry } from '../../vectors/fixtures.js';

function boundWithBoards() {
  return new Replica({
    meta: { ...Replica.fresh({ replica: 'rp_1', state: 'bound', account: 'A' }).meta },
    confirmed: {
      'self/probe': [
        { t: 'board', id: 'b_00000001', life: ['alive', '1:0:r_aaaaaaaaaaaa'], born: '1:0:r_aaaaaaaaaaaa', seq: 1, rc: 1, ru: 1 },
        { t: 'board', id: 'b_00000002', life: ['dead', '2:0:r_aaaaaaaaaaaa'], born: '1:0:r_aaaaaaaaaaaa', seq: 2, rc: 1, ru: 2 },
      ],
    },
    cursors: {
      'self/probe': { cursor: 'c1', digest: '0'.repeat(64), booted: true },
      'tree/b_00000002': { cursor: 'c2', digest: '0'.repeat(64), booted: true },
    },
    outbox: [
      { localId: 'g1/0', gestureId: 'g1', lineage: 'A', scope: 'tree/b_00000002', state: 'acked', commitOrder: 1, releaseAt: 0, stamp: '3:0:r_aaaaaaaaaaaa', resultSeq: 4, resultEpoch: 'ep-1', intent: { scope: 'tree/b_00000002', d: [{ t: 'meta', id: 'meta', f: { title: ['x', '3:0:r_aaaaaaaaaaaa'] } }], gestureId: 'g1' } },
      { localId: 'g2/0', gestureId: 'g2', lineage: 'A', scope: 'tree/b_00000003', state: 'ready', commitOrder: 2, releaseAt: 0, stamp: '4:0:r_aaaaaaaaaaaa', intent: { scope: 'tree/b_00000003', d: [{ t: 'meta', id: 'meta', f: { title: ['y', '4:0:r_aaaaaaaaaaaa'] } }], gestureId: 'g2' } },
    ],
  });
}

test('§7.9: a bound replica subscribes its product scope and each alive board\'s tree and overlay', () => {
  assert.deepEqual(subscriptionsOf(boundWithBoards(), registry, ['probe']), ['self/probe', 'tree/b_00000001', 'self/overlay/b_00000001']);
  assert.deepEqual(subscriptionsOf(Replica.fresh({ replica: 'rp_2', state: 'anon' }), registry, ['probe']), []);
});

test('§8.1: leaving the subscription set forgets the scope and resolves its acked entries, pending ones stay', () => {
  const replica = boundWithBoards();
  const ended = [];
  reconcile(replica, { ended }, subscriptionsOf(replica, registry, ['probe']));
  assert.deepEqual(ended, [{ localId: 'g1/0', outcome: 'resolved', event: 'resolve' }]);
  assert.deepEqual(Object.keys(replica.cursors), ['self/probe']);
  assert.deepEqual(replica.outbox.map((entry) => [entry.localId, entry.state]), [['g2/0', 'ready']]);
});

test('§7.9 firstPullComplete: booted for a pulled scope, true for a scope the replica does not pull', () => {
  const replica = boundWithBoards();
  const scopes = subscriptionsOf(replica, registry, ['probe']);
  assert.equal(firstPullComplete(replica, 'self/probe', scopes), true);
  assert.equal(firstPullComplete(replica, 'tree/b_00000001', scopes), false);
  assert.equal(firstPullComplete(replica, 'tree/b_99999999', scopes), true);
});

// A draw that answers its bound, the longest sleep a backoff can take, and one that answers 0.
const longest = (bound) => bound;
const shortest = () => 0;

// One scope, a live socket and a puller driven by Doubts against a server whose answers never change:
// `subAnswer` and `pullAnswer` are 'not-found', which the client ignores (it holds the governing record
// alive), or 'kept' and 'rows'. Each answer lands `rtt` ms after its request. Counts the subs and pulls
// sent in `span` ms.
function drive({ subAnswer, pullAnswer, draw, span = 60_000, rtt = 50 }) {
  const doubts = new Doubts();
  const scope = 'tree/b_00000001';
  const counts = { subs: 0, pulls: 0 };
  const answers = [];
  let followed = false;
  let subInFlight = false;
  let now = 0;
  for (;;) {
    if (!followed && !subInFlight && doubts.mayFollow(scope)) {
      counts.subs += 1;
      subInFlight = true;
      answers.push({ at: now + rtt, kind: 'sub' });
    }
    for (const due of doubts.due(now)) {
      assert.equal(due, scope);
      counts.pulls += 1;
      answers.push({ at: now + rtt, kind: 'pull' });
    }
    const next = Math.min(...answers.map((answer) => answer.at), doubts.of(scope).due ?? Infinity);
    if (next >= span) return counts;
    now = next;
    const index = answers.findIndex((answer) => answer.at === now);
    if (index < 0) continue;
    const [answer] = answers.splice(index, 1);
    if (answer.kind === 'sub') {
      subInFlight = false;
      if (subAnswer === 'kept') {
        followed = true;
        doubts.followed(scope, now);
      } else {
        doubts.end(scope, now, draw);
      }
    } else if (pullAnswer === 'rows') {
      doubts.rows(scope);
      if (followed) doubts.followed(scope, now);
    } else {
      doubts.end(scope, now, draw);
      doubts.repulled(scope, now, draw);
    }
  }
}

test('§7.9 and INV-16: a sub and every pull answered not-found for a scope held alive send one sub and back the re-pulls off', () => {
  assert.deepEqual(drive({ subAnswer: 'not-found', pullAnswer: 'not-found', draw: longest }), { subs: 1, pulls: 5 });
});

test('§7.9 and INV-16: a sub answered not-found while pulls bring rows turns once per re-pull draw, not at the socket\'s speed', () => {
  assert.deepEqual(drive({ subAnswer: 'not-found', pullAnswer: 'rows', draw: longest }), { subs: 6, pulls: 5 });
  const unlucky = drive({ subAnswer: 'not-found', pullAnswer: 'rows', draw: shortest });
  assert.ok(unlucky.subs <= unlucky.pulls + 1, JSON.stringify(unlucky));
});

test('§7.9: a kept sub sends nothing more', () => {
  assert.deepEqual(drive({ subAnswer: 'kept', pullAnswer: 'rows', draw: longest }), { subs: 1, pulls: 0 });
});

test('§7.9: k returns to 0 once the scope stayed followed, not in doubt, for 30 s, and not before', () => {
  const settle = (followedFor) => {
    const doubts = new Doubts();
    doubts.end('tree/t', 0, longest);
    doubts.due(1000);
    doubts.rows('tree/t');
    doubts.followed('tree/t', 1000);
    doubts.end('tree/t', 1000 + followedFor, longest);
    return doubts.of('tree/t').due - (1000 + followedFor);
  };
  assert.equal(settle(29_999), 2000);
  assert.equal(settle(30_000), 1000);
});

// A scope put in doubt at 0 and pulled at 1000 with rows, so k is 1 and it is followed from 1000.
function followedAfterDoubt() {
  const doubts = new Doubts();
  doubts.end('tree/t', 0, longest);
  doubts.due(1000);
  doubts.rows('tree/t');
  doubts.followed('tree/t', 1000);
  return doubts;
}

test('§7.9: a stretch of 30 s ended by the socket\'s close returns k to 0, though a shorter stretch follows before the next doubt', () => {
  const settled = followedAfterDoubt();
  settled.unfollowed('tree/t', 31_000);
  settled.followed('tree/t', 50_000);
  settled.followed('tree/t', 52_000);
  settled.end('tree/t', 55_000, longest);
  assert.deepEqual(settled.of('tree/t'), { k: 1, doubt: true, due: 56_000, followedSince: null });
  const short = followedAfterDoubt();
  short.unfollowed('tree/t', 30_999);
  short.followed('tree/t', 50_000);
  short.end('tree/t', 55_000, longest);
  assert.deepEqual(short.of('tree/t'), { k: 2, doubt: true, due: 57_000, followedSince: null });
});

test('§7.9: a stretch of 30 s ended by the gone or not-found frame itself returns k to 0, though the socket unfollowed as the frame arrived and the ignored end is handled after', () => {
  const doubts = followedAfterDoubt();
  doubts.unfollowed('tree/t', 31_000);
  doubts.end('tree/t', 31_050, longest);
  assert.deepEqual(doubts.of('tree/t'), { k: 1, doubt: true, due: 32_050, followedSince: null });
});

test('§7.9: a pull of another trigger answered by an ignored end leaves the scheduled re-pull and k as they are', () => {
  const doubts = new Doubts();
  doubts.end('tree/t', 0, longest);
  doubts.end('tree/t', 400, longest);
  assert.deepEqual(doubts.of('tree/t'), { k: 1, doubt: true, due: 1000, followedSince: null });
  assert.deepEqual(doubts.due(999), []);
  assert.deepEqual(doubts.due(1000), ['tree/t']);
});

test('§7.9 and §7.12: leaving the subscription set, and a sign-in, a sign-out or a re-identify, end the doubt and return k to 0', () => {
  const doubts = new Doubts();
  doubts.end('tree/a', 0, longest);
  doubts.end('tree/b', 0, longest);
  doubts.left('tree/a');
  assert.equal(doubts.mayFollow('tree/a'), true);
  assert.equal(doubts.of('tree/a').k, 0);
  doubts.clear();
  assert.equal(doubts.mayFollow('tree/b'), true);
  assert.equal(doubts.of('tree/b').k, 0);
});
