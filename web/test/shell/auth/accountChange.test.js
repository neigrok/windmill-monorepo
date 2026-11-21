import test from 'node:test';
import assert from 'node:assert/strict';

import { DeviceSeat, ProductQuestions, restoredDeviceHolder } from '../../../src/shell/auth/accountChange.js';

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


test('restoring the durable holder grants no session authority and cannot replace a confirmed answer', () => {
  const roadmap = recorder('roadmap');
  const seat = new DeviceSeat([roadmap.product]);
  seat.restoreHolder({ device: { meta: {}, activeReplica: { meta: { state: 'bound', account: A.id } } } });
  assert.deepEqual({ previous: seat.previousAccount, account: seat.account, confirmed: seat.confirmed, lapsed: seat.lapsed },
    { previous: A.id, account: null, confirmed: false, lapsed: false });
  assert.deepEqual(seat.receive(undefined), { status: 'ghost', user: null, account: null, confirmed: false });
  assert.deepEqual(roadmap.calls, []);
  seat.receive(A);
  seat.restoreHolder({ device: { meta: {}, activeReplica: { meta: { state: 'bound', account: B.id } } } });
  assert.equal(seat.previousAccount, A.id);
  assert.equal(seat.account, A);
  assert.deepEqual(roadmap.calls, []);
});

for (const guard of ['none', 'anon', 'dormant', 'closed', 'signingOut', 'signOut', 'deviceCleanup', 'clearCredential', 'closingAccount']) {
  test(`the shell's restored-holder rule excludes ${guard} from device authority`, () => {
    let engine = { device: { meta: {}, activeReplica: { meta: { state: 'bound', account: A.id } } } };
    if (guard === 'none') engine = null;
    else if (guard === 'anon' || guard === 'dormant') engine.device.activeReplica.meta.state = guard;
    else if (guard === 'closed' || guard === 'signingOut') engine[guard] = true;
    else engine.device.meta[guard] = { account: A.id };
    const seat = new DeviceSeat([]);
    seat.restoreHolder(engine);
    assert.equal(restoredDeviceHolder(engine), null);
    assert.deepEqual({ previous: seat.previousAccount, account: seat.account, confirmed: seat.confirmed, lapsed: seat.lapsed },
      { previous: null, account: null, confirmed: false, lapsed: false });
  });
}

test('the seat tells the engine whose credential each read found, and a tell that throws is reported once a page while the reads go on', async () => {
  const told = [], reported = [];
  let failing = false;
  const engine = { credentialHeld: async (held) => {
    told.push(held);
    if (failing) throw new Error('store closed');
  } };
  const seat = new DeviceSeat([], (error) => reported.push(error.message));
  await seat.tellCredential(engine, A);
  await seat.tellCredential(engine, null);
  await seat.tellCredential(engine, undefined);
  failing = true;
  await seat.tellCredential(engine, null);
  await seat.tellCredential(engine, B);
  assert.deepEqual({ told, reported }, { told: ['u_A', null, undefined, null, 'u_B'], reported: ['store closed'] });
});

test('a product hook that throws is asked of as one that says nothing, and each throw reports the question it was asked', async () => {
  const thrown = new Error('the product chunk did not load');
  const broken = { id: 'broken', sync: {
    adoptionAnswer: async () => { throw thrown; },
    adoptionCount: () => { throw thrown; },
    signInWords: async () => { throw thrown; },
    signOutWords: () => { throw thrown; },
  } };
  const wording = { id: 'wording', sync: { signOutWords: async () => ({ title: 'Sign out?' }) } };
  const reported = [];
  const questions = new ProductQuestions([broken, wording], (question, error) => reported.push([question, error]));
  const due = { kind: 'signed-out', product: 'broken', count: { page: 1 }, counted: ['p1'] };
  const question = { complete: false, unsent: 0, ready: 0, sent: 0, counted: [] };
  const answer = await questions.adoptionAnswer({}, due);
  const count = await questions.adoptionCount({}, due);
  const words = await questions.signInWords({}, due);
  const { words: { onStep, ...worded }, ...signOut } = await questions.signOutWords({}, question);
  assert.deepEqual({
    answer, count, words,
    signOut: { ...signOut, words: worded, told: typeof onStep },
    alone: await new ProductQuestions([broken], (asked, error) => reported.push([asked, error])).signOutWords({}, question),
  }, { answer: undefined, count: undefined, words: undefined, signOut: { ...question, words: { title: 'Sign out?' }, told: 'function' }, alone: question });
  assert.deepEqual(reported, [['adoption', thrown], ['signin', thrown], ['signin', thrown], ['signout', thrown], ['signout', thrown]]);
});

test('a product whose sign-out notice or whose words\' steps throw is heard as one that says nothing there, and each throw reports the question it was asked', async () => {
  const thrown = new Error('the product chunk did not load');
  const notice = { line: 'A recording waiting in Talk will be discarded.', download: { label: 'Download recording' } };
  const steps = [];
  const broken = { id: 'broken', signOutNotice: () => { throw thrown; },
    sync: { signInWords: async () => ({ title: 'Add?', onStep: () => { throw thrown; } }) } };
  const talking = { id: 'talking', signOutNotice: () => notice,
    sync: { signOutWords: async () => ({ title: 'Sign out?', onStep: (step) => steps.push(step) }) } };
  const reported = [];
  const questions = new ProductQuestions([broken, talking, { id: 'quiet', signOutNotice: () => null }],
    (question, error) => reported.push([question, error]));
  const notices = questions.signOutNotices();
  const signIn = await questions.signInWords({}, { kind: 'signed-out', product: 'broken', count: {}, counted: [] });
  const signOut = await questions.signOutWords({}, { unsent: 0 });
  signIn.onStep('shown');
  signOut.words.onStep('keep');
  assert.deepEqual({ notices, steps, reported, titles: [signIn.title, signOut.words.title] },
    { notices: [notice], steps: ['keep'], reported: [['notice', thrown], ['step', thrown]], titles: ['Add?', 'Sign out?'] });
});

test('what products say passes through unchanged, each step told back to it, and a product with no hook leaves the question to the engine and the shell', async () => {
  const steps = [];
  const said = { title: 'Add your pages?' };
  const journal = { id: 'journal', sync: { adoptionAnswer: () => 'add', adoptionCount: () => 0,
    signInWords: async () => ({ ...said, onStep: (step) => steps.push(step) }) } };
  const reported = [];
  const questions = new ProductQuestions([journal, { id: 'gym' }], (question) => reported.push(question));
  const due = (product) => ({ kind: 'signed-out', product, count: {}, counted: [] });
  const { onStep, ...words } = await questions.signInWords({}, due('journal'));
  onStep('shown');
  assert.deepEqual({
    journal: [await questions.adoptionAnswer({}, due('journal')), await questions.adoptionCount({}, due('journal')), words],
    gym: [await questions.adoptionAnswer({}, due('gym')), await questions.adoptionCount({}, due('gym')), await questions.signInWords({}, due('gym'))],
    signOut: await questions.signOutWords({}, { unsent: 0 }),
    steps,
    reported,
  }, { journal: ['add', 0, said], gym: [undefined, undefined, undefined], signOut: { unsent: 0 }, steps: ['shown'], reported: [] });
});
