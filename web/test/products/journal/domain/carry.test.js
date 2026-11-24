import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { journalProduct, journalRegistry } from '../../../platform/sync/oracle-adapters/journal.js';
import { CarryLedger, CarryPage, OldPage, OldStore, RecordCarry, Seat, SeatPages } from '../../../../src/products/journal/domain/carry.js';
import { JOURNAL_SCOPE, JournalState } from '../../../../src/products/journal/domain/page.js';
import { EditorDraft, SavePage } from '../../../../src/products/journal/domain/writing.js';
import { LocalDay } from '../../../../src/platform/domain-kit/time.js';

// A page as the bundle before the engine kept it in a store, under its day.
const entry = (day, body, { owed = true, read = false, stamp = '1:0:legacy', mood = null, energy = null } = {}) =>
  ({ [day]: { page: { day, body, mood, energy, source: 'typed', stamp }, needsPush: owed, read } });
const store = (key, ...entries) => OldStore.read(key, JSON.stringify(Object.assign({}, ...entries)));
const fields = (page) => ({ day: page.day.text, ...page.document.fields() });
const anonymous = () => Harness.open({ registry: journalRegistry, product: journalProduct, scope: JOURNAL_SCOPE, anonymous: true });
const results = (outcome) => {
  assert.notEqual(outcome.kind, 'refused', JSON.stringify(outcome));
  return outcome.results;
};
const claims = (a) => a.engine.device.activeReplica.entries(JOURNAL_SCOPE).flatMap((each) => (each.intent.cmd ? [each.intent.cmd.args] : []));

test('a store\'s key names whose pages it keeps, a replica whose pages it takes, and the first version\'s scales read on the engine\'s', () => {
  assert.deepEqual(['wm.journal.v2.pages.anon', 'wm.journal.pages.anon', 'wm.journal.v2.pages.u.acct-1.x', 'wm.journal.pages.u.B',
    'wm.journal.v2.pages.unclaimed', 'wm.journal.pages.unclaimed', 'wm.journal.pages', 'wm.journal.v2.pages.unclaimed.0123456789abcdef',
    'wm.journal.v2.pages.unclaimed.x', 'wm.journal.notes', 'windmill:journal-search-meaning'].map((key) => Seat.ofKey(key)?.name ?? null),
  ['anon', 'anon', 'u.acct-1.x', 'u.B', 'unclaimed', 'unclaimed', 'unclaimed', 'unclaimed', null, null, null]);
  assert.deepEqual([{ state: 'bound', account: 'A' }, { state: 'anon' }, { state: 'dormant', account: 'A' }].map((meta) => Seat.ofReplica(meta)?.name ?? null),
    ['u.A', 'anon', null]);

  const first = store('wm.journal.pages.anon', entry('2026-09-01', 'first', { mood: 3, energy: 2 }), entry('2026-09-02', 'unanswered', { mood: 0, energy: 7 }));
  const second = store('wm.journal.v2.pages.anon', entry('2026-09-01', 'second', { mood: 3, energy: 2 }));
  assert.deepEqual(first.pages.map(fields), [
    { day: '2026-09-01', body: 'first', mood: 5, energy: 5, source: 'typed' },
    { day: '2026-09-02', body: 'unanswered', mood: null, energy: null, source: 'typed' },
  ]);
  assert.deepEqual(second.pages.map(fields), [{ day: '2026-09-01', body: 'second', mood: 3, energy: 2, source: 'typed' }]);
});

test('an entry that does not read stays as it is, words no digest names among them, and a store gives up only the pages it is told', () => {
  const unread = { '2026-02-30': entry('2026-02-30', 'no such day')['2026-02-30'], '2026-09-03': { needsPush: true },
    '2026-09-04': { page: { body: 'bad stamp', stamp: 'later' }, needsPush: true }, ...entry('2026-09-05', 'a lone \ud800 surrogate') };
  const mixed = OldStore.read('wm.journal.v2.pages.anon', JSON.stringify({ ...entry('2026-09-01', 'carried'), ...entry('2026-09-02', 'owed'), ...unread }));
  assert.equal(mixed.unreadable, 4);
  assert.deepEqual(mixed.pages.map(fields), [
    { day: '2026-09-01', body: 'carried', mood: null, energy: null, source: 'typed' },
    { day: '2026-09-02', body: 'owed', mood: null, energy: null, source: 'typed' },
  ]);
  const [carried, owed] = mixed.pages;
  assert.deepEqual(mixed.rest(new Set()), { kind: 'keep' });
  assert.deepEqual(mixed.rest(new Set([carried.digest])), { kind: 'rewrite', raw: JSON.stringify({ ...entry('2026-09-02', 'owed'), ...unread }), gone: [carried] });
  assert.deepEqual(mixed.rest(new Set([carried.digest, owed.digest])), { kind: 'rewrite', raw: JSON.stringify(unread), gone: [carried, owed] });
  assert.deepEqual(OldStore.read(mixed.key, JSON.stringify(unread)).rest(new Set([carried.digest, owed.digest])), { kind: 'keep' });

  const whole = store('wm.journal.v2.pages.anon', entry('2026-09-01', 'carried'));
  assert.deepEqual(whole.rest(new Set([carried.digest])), { kind: 'forget', gone: whole.pages });
  assert.deepEqual(OldStore.read('wm.journal.v2.pages.anon', '{}').rest(new Set()), { kind: 'forget', gone: [] });
  const garbled = OldStore.read('wm.journal.v2.pages.anon', '{not json');
  assert.deepEqual({ pages: garbled.pages, unreadable: garbled.unreadable, rest: garbled.rest(new Set([carried.digest])) }, { pages: [], unreadable: 1, rest: { kind: 'keep' } });
});

test('a page the browser did not owe is a copy of the account\'s own in an account\'s store and the first version\'s unscoped one, the person\'s writing elsewhere', () => {
  const kept = [entry('2026-09-01', 'owed'), entry('2026-09-02', 'not owed', { owed: false })];
  assert.deepEqual(['wm.journal.v2.pages.u.A', 'wm.journal.pages.u.A', 'wm.journal.pages', 'wm.journal.pages.unclaimed', 'wm.journal.v2.pages.unclaimed',
    'wm.journal.v2.pages.unclaimed.0123456789abcdef', 'wm.journal.v2.pages.anon'].map((key) => store(key, ...kept).pages.map((page) => page.copy)), [
    [false, true], [false, true], [false, true], [false, false], [false, false], [false, false], [false, false],
  ]);
  const unscoped = store('wm.journal.pages', ...kept);
  assert.deepEqual(new SeatPages(Seat.unclaimed, [unscoped]).pages.map((page) => page.document.body), ['owed']);
  assert.deepEqual(unscoped.rest(new Set()), { kind: 'rewrite', raw: JSON.stringify(entry('2026-09-01', 'owed')), gone: [unscoped.pages[1]] });
  assert.deepEqual(unscoped.rest(new Set([unscoped.pages[0].digest])), { kind: 'forget', gone: unscoped.pages });
});

test('a seat keeps a day\'s page as the bundle kept it, and the others of the day with other words to recover', () => {
  const day = '2026-09-01';
  const pages = new SeatPages(Seat.of('A'), [
    store('wm.journal.pages.u.A', entry(day, 'owed, read', { read: true, stamp: '9:0:legacy' }), entry('2026-09-02', 'cached newer', { owed: false, stamp: '9:0:legacy' })),
    store('wm.journal.v2.pages.u.A', entry(day, 'owed, never read', { stamp: '1:0:legacy' }), entry('2026-09-02', 'owed older')),
    store('wm.journal.v2.pages.u.B', entry(day, 'another account\'s')),
    store('wm.journal.v2.pages.anon', entry(day, 'signed out')),
  ]);
  assert.deepEqual(pages.stores.map((each) => each.key), ['wm.journal.pages.u.A', 'wm.journal.v2.pages.u.A']);
  assert.deepEqual(pages.days.map(({ kept, others }) => ({ kept: kept.document.body, others: others.map((page) => page.document.body) })), [
    { kept: 'owed, never read', others: ['owed, read'] },
    { kept: 'owed older', others: [] },
  ]);

  const ties = new SeatPages(Seat.anon, [
    store('wm.journal.pages.anon', entry(day, 'same words'), entry('2026-09-02', 'older stamp', { stamp: '1:0:a' })),
    store('wm.journal.v2.pages.anon', entry(day, 'same words'), entry('2026-09-02', 'newer stamp', { stamp: '2:0:a' })),
  ]);
  assert.deepEqual(ties.days.map(({ kept, others }) => ({ kept: kept.document.body, others: others.map((page) => page.document.body) })), [
    { kept: 'same words', others: [] },
    { kept: 'newer stamp', others: ['older stamp'] },
  ]);
  const [page] = ties.pages;
  assert.equal(page.claimId, `carry-${page.digest}`);
  assert.equal(page.claimId, OldPage.read(day, entry(day, 'same words', { stamp: '7:3:else', owed: false })[day], false).claimId);
  assert.match(`pendingClaim:${page.claimId}`, new RegExp(journalRegistry.products.journal.device.pendingClaim.keyPattern));
  assert.match(CarryLedger.key(Seat.of('A')), new RegExp(journalRegistry.products.journal.device.carry.keyPattern));
  assert.notEqual(CarryLedger.key(Seat.of('A')), CarryLedger.key(Seat.anon));
});

test('a seat\'s pages carry as claims under their own ids, retire the first run and are recorded, and carrying again writes nothing', async () => {
  const a = await anonymous();
  try {
    const pages = new SeatPages(Seat.anon, [store('wm.journal.v2.pages.anon', entry('2026-09-01', 'one'), entry('2026-09-02', 'two'))]);
    const [act, ...rest] = pages.carrying(20);
    assert.deepEqual(rest, []);
    assert.deepEqual(act.pages, pages.pages);
    assert.deepEqual(results(await a.runner.runComposed(act.parts)), ['claimed', 'claimed', null, null]);
    assert.deepEqual(claims(a), pages.pages.map((page) => ({ ...fields(page), claimId: page.claimId })));
    assert.deepEqual(a.drawn(JournalState).map((state) => state.fields()),
      [{ placeholder: 'retired', privacyLine: 'retired', firstPage: 'retired', scales: 'retired' }]);
    assert.deepEqual(a.engine.readDeviceRows('journal')[CarryLedger.key(Seat.anon)], { pages: pages.pages.map((page) => page.digest).sort() });

    const again = await a.runner.runComposed(pages.carrying(20)[0].parts);
    assert.deepEqual(again, { kind: 'unchanged', results: ['held', 'held', null, null] });
    assert.equal(claims(a).length, 2);
  } finally { a.close(); }
});

test('a page the seat\'s ledger records is not written again though the replica holds neither its claim nor its draft, and one recorded nowhere is', async () => {
  const a = await anonymous();
  try {
    const pages = new SeatPages(Seat.anon, [
      store('wm.journal.pages.anon', entry('2026-09-01', 'an earlier recorded page of the day', { stamp: '1:0:legacy' })),
      store('wm.journal.v2.pages.anon', entry('2026-09-01', 'recorded', { stamp: '2:0:legacy' }), entry('2026-09-02', 'new')),
    ]);
    const [recorded, other, fresh] = pages.pages;
    assert.deepEqual([recorded, other, fresh].map((page) => page.document.body), ['recorded', 'an earlier recorded page of the day', 'new']);
    results(await a.runner.runComposed([new RecordCarry(Seat.anon, [recorded.digest, other.digest])]));
    assert.deepEqual(results(await a.runner.runComposed(pages.carrying(20)[0].parts)), ['held', 'held', 'claimed', null, null]);
    assert.deepEqual(claims(a).map((args) => args.claimId), [fresh.claimId]);
    assert.equal(a.engine.readDeviceRows('journal')[other.draft.recoveryKey], undefined);
  } finally { a.close(); }
});

test('the carry keeps a page of a day the replica holds as a draft to recover, and a restore joins it as a claim', async () => {
  const a = await anonymous();
  try {
    const today = a.runner.moment().today.text;
    assert.equal((await a.runner.run(new SavePage({ day: today, document: { body: 'written here', mood: null, energy: null, source: 'typed' } }))).kind, 'committed');
    const pages = new SeatPages(Seat.anon, [store('wm.journal.v2.pages.anon', entry(today, 'kept before'), entry('2026-09-01', 'a free day'))]);
    assert.deepEqual(results(await a.runner.runComposed(pages.carrying(20)[0].parts)), ['claimed', 'recovered', null, null]);
    const kept = pages.pages.find((page) => page.day.text === today);
    assert.deepEqual(a.engine.readDeviceRows('journal')[kept.draft.recoveryKey], kept.draft.json);

    const unclaimed = new SeatPages(Seat.unclaimed, [store('wm.journal.v2.pages.unclaimed', entry(today, 'kept before'))]);
    const [join] = unclaimed.restoring(20)[0].parts;
    assert.ok(join instanceof CarryPage);
    assert.deepEqual(results(await a.runner.runComposed([join])), ['held']);
    const elsewhere = new SeatPages(Seat.unclaimed, [store('wm.journal.v2.pages.unclaimed', entry(today, 'unattributed words'))]);
    assert.deepEqual(results(await a.runner.runComposed(elsewhere.restoring(20)[0].parts)), ['claimed']);
    assert.deepEqual(claims(a).filter((args) => args.day === today).map((args) => args.body), ['written here', 'unattributed words']);
  } finally { a.close(); }
});

test('an owed page of a day whose account page is pulled is still claimed, so the account joins it whatever the pull\'s timing', async () => {
  const a = await Harness.open({ registry: journalRegistry, product: journalProduct, scope: JOURNAL_SCOPE });
  try {
    await a.sync();
    const today = a.runner.moment().today.text;
    assert.equal((await a.runner.run(new SavePage({ day: today, document: { body: 'the account\'s page', mood: null, energy: null, source: 'typed' } }))).kind, 'committed');
    await a.sync();
    assert.equal(a.engine.device.activeReplica.entries(JOURNAL_SCOPE).length, 0);
    const pages = new SeatPages(Seat.of('A'), [store('wm.journal.v2.pages.u.A', entry(today, 'the account\'s page, then words written offline', { read: true }))]);
    assert.deepEqual(results(await a.runner.runComposed(pages.carrying(20)[0].parts)), ['claimed', null, null]);
    assert.deepEqual(claims(a).map((args) => args.body), ['the account\'s page, then words written offline']);
  } finally { a.close(); }
});

test('words past a claim\'s bound stay to correct: the editor\'s draft where its day is free, a draft to recover after', async () => {
  const a = await anonymous();
  try {
    const long = 'legacy writing '.repeat(10_000);
    const pages = new SeatPages(Seat.anon, [store('wm.journal.v2.pages.anon', entry('2026-09-01', long), entry('2026-09-02', `${long}again`), entry('2026-09-03', 'fits'))]);
    assert.deepEqual(results(await a.runner.runComposed(pages.carrying(20)[0].parts)), ['drafted', 'recovered', 'claimed', null, null]);
    const rows = a.engine.readDeviceRows('journal');
    const [first, second] = pages.pages;
    assert.deepEqual(rows[EditorDraft.key], first.draft.json);
    assert.deepEqual(rows[second.draft.recoveryKey], second.draft.json);
    assert.deepEqual(claims(a).map((args) => args.body), ['fits']);
  } finally { a.close(); }
});

test('an account seat carries only what the browser owed it, and acts hold a bounded number of pages each', () => {
  const days = Array.from({ length: 23 }, (_, index) => LocalDay.parse(`2026-08-${String(index + 1).padStart(2, '0')}`).text);
  const account = new SeatPages(Seat.of('A'), [store('wm.journal.v2.pages.u.A', ...days.map((day, index) => entry(day, `page ${index}`, { owed: index % 2 === 0 })))]);
  assert.equal(account.pages.length, 12);
  const acts = account.carrying(5);
  assert.deepEqual(acts.map((act) => act.parts.map((part) => part.constructor.name)), [
    ['CarryPage', 'CarryPage', 'CarryPage', 'CarryPage', 'CarryPage', 'RetireFirstRun', 'RecordCarry'],
    ['CarryPage', 'CarryPage', 'CarryPage', 'CarryPage', 'CarryPage', 'RecordCarry'],
    ['CarryPage', 'CarryPage', 'RecordCarry'],
  ]);
  assert.deepEqual(acts.map((act) => act.pages), [account.pages.slice(0, 5), account.pages.slice(5, 10), account.pages.slice(10)]);
  assert.deepEqual(acts.map((act) => act.parts.at(-1).digests), acts.map((act) => act.pages.map((page) => page.digest)));
  const blank = new SeatPages(Seat.anon, [store('wm.journal.v2.pages.anon', entry('2026-09-01', '  ', { mood: 4 }))]);
  assert.deepEqual(blank.carrying(5).map((act) => act.parts.map((part) => part.constructor.name)), [['CarryPage', 'RecordCarry']]);
});
