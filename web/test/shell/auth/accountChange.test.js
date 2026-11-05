import test from 'node:test';
import assert from 'node:assert/strict';

import { DeviceSeat } from '../../../src/shell/auth/accountChange.js';

const A = { id: 'u_A', email: 'a@example.com' };
const B = { id: 'u_B', email: 'b@example.com' };

function recorder(id) {
  const calls = [];
  return { product: { id, forgetDevice: (change) => calls.push(change) }, calls };
}

test('a cold boot that cannot reach the server is nobody — no account, and not confirmed', () => {
  const seat = new DeviceSeat([]);

  assert.deepEqual(seat.receive(undefined), { status: 'ghost', user: null, account: null, confirmed: false });
  assert.equal(seat.account, null);
  assert.equal(seat.confirmed, false);
});

test('one successful answer confirms the load, and that is when the account exists', () => {
  const seat = new DeviceSeat([]);

  seat.receive(undefined);
  assert.deepEqual(seat.receive(A), { status: 'signed-in', user: A, account: A, confirmed: true });
  assert.equal(seat.account, A);
  assert.equal(seat.confirmed, true);
});

test('a blip after confirmation changes nothing at all — the confirmed account stays', () => {
  const seat = new DeviceSeat([]);
  seat.receive(A);

  assert.equal(seat.receive(undefined), null);
  assert.equal(seat.account, A);
  assert.equal(seat.confirmed, true);
});

test('a real 401 removes session authority and retains the previous device owner', () => {
  const seat = new DeviceSeat([]);
  seat.receive(A);

  assert.deepEqual(seat.receive(null), { status: 'ghost', user: null, account: null, confirmed: true });
  assert.equal(seat.account, null);
  assert.equal(seat.previousAccount, 'u_A');
  assert.equal(seat.lapsed, true);
});

test('a sign-out forgets the device — every product hears the same change', () => {
  const roadmap = recorder('roadmap');
  const journal = recorder('journal');
  const seat = new DeviceSeat([roadmap.product, journal.product]);
  seat.receive(A);

  seat.receive(null, { signedOut: true });
  assert.deepEqual(roadmap.calls, [{ previous: 'u_A', next: null }]);
  assert.deepEqual(journal.calls, [{ previous: 'u_A', next: null }]);
});

test('an account switch this tab only learned about forgets the device too', () => {
  const roadmap = recorder('roadmap');
  const seat = new DeviceSeat([roadmap.product]);
  seat.receive(A);

  seat.receive(B);
  assert.deepEqual(roadmap.calls, [{ previous: 'u_A', next: 'u_B' }]);
});

test('ghost → signed-in is the claim, not a change — nothing is forgotten', () => {
  const roadmap = recorder('roadmap');
  const seat = new DeviceSeat([roadmap.product]);

  seat.receive(null);
  seat.receive(A);
  assert.deepEqual(roadmap.calls, []);
});

test('the same account answering again is not a change', () => {
  const roadmap = recorder('roadmap');
  const seat = new DeviceSeat([roadmap.product]);

  seat.receive(A);
  seat.receive(A);
  seat.receive(A);
  assert.deepEqual(roadmap.calls, []);
});

test('a boot with no network, then a real answer, forgets nothing — no account was ever handed out', () => {
  const roadmap = recorder('roadmap');
  const seat = new DeviceSeat([roadmap.product]);

  seat.receive(undefined);
  seat.receive(B);
  assert.deepEqual(roadmap.calls, []);
});

test('a blip between two confirmed answers does not break the change that follows it', () => {
  const roadmap = recorder('roadmap');
  const seat = new DeviceSeat([roadmap.product]);

  seat.receive(A);
  seat.receive(undefined);
  seat.receive(null, { signedOut: true });
  assert.deepEqual(roadmap.calls, [{ previous: 'u_A', next: null }]);
});

test('one product throwing neither stops the others nor throws at the caller — sign-out completes', async () => {
  const broken = { id: 'broken', forgetDevice: () => { throw new Error('indexedDB is gone'); } };
  const rejecting = { id: 'rejecting', forgetDevice: async () => { throw new Error('deleteDatabase blocked'); } };
  const hanging = { id: 'hanging', forgetDevice: () => new Promise(() => {}) };
  const roadmap = recorder('roadmap');
  const seat = new DeviceSeat([broken, rejecting, hanging, roadmap.product]);
  seat.receive(A);

  const complaints = [];
  const realError = console.error;
  console.error = (...args) => complaints.push(args[0]);
  try {
    assert.deepEqual(seat.receive(null, { signedOut: true }), { status: 'ghost', user: null, account: null, confirmed: true });
    await Promise.resolve();  // the rejected cleanup is caught a microtask later, not inline
    await Promise.resolve();
  } finally {
    console.error = realError;
  }
  assert.deepEqual(roadmap.calls, [{ previous: 'u_A', next: null }]);
  assert.equal(complaints.length, 2);
});

test('a product that keeps nothing on the device is simply skipped', () => {
  const seat = new DeviceSeat([{ id: 'nothing-to-forget' }]);
  seat.receive(A);
  assert.deepEqual(seat.receive(B), { status: 'signed-in', user: B, account: B, confirmed: true });
});

for (const returning of [A, B]) {
  test(`a lapse retains unsynced device work until ${returning.id} signs in`, () => {
    const roadmap = recorder('roadmap');
    const seat = new DeviceSeat([roadmap.product]);
    seat.receive(A);
    seat.receive(null);
    seat.receive(null);
    seat.receive(undefined);
    assert.deepEqual(roadmap.calls, []);
    assert.equal(seat.lapsed, true);
    assert.equal(seat.previousAccount, A.id);
    assert.deepEqual(seat.receive(returning), { status: 'signed-in', user: returning, account: returning, confirmed: true });
    assert.deepEqual(roadmap.calls, returning === A ? [] : [{ previous: A.id, next: B.id }]);
    assert.equal(seat.lapsed, false);
  });
}

test('explicit sign-out after a lapse clears the remembered account and forgets once', () => {
  const roadmap = recorder('roadmap');
  const seat = new DeviceSeat([roadmap.product]);
  seat.receive(A);
  seat.receive(null);
  seat.receive(null, { signedOut: true });
  seat.receive(null);
  assert.deepEqual(roadmap.calls, [{ previous: A.id, next: null }]);
  assert.equal(seat.previousAccount, null);
  assert.equal(seat.lapsed, false);
});
