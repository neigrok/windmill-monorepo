// Roadmap on the device's copy as the account changes (roadmap-on-the-engine.md §5 Signed out, §8.2, flow 50, Roadmap
// Coach 10.4): the words of the shell's sign-in question, Add or Discard, where the account already holds roadmaps, and of its sign-out question,
// Keep or Discard, where every unsent change is roadmap's, each naming every roadmap its Discard takes, so a Discard
// covers exactly the work it named (engine.md §7.10); what the browser kept beside the roadmaps a sign-in's Discard takes,
// and the old stores the carry-over carried into them; and what an explicit sign-out, an account replacement and an account closure take from the browser: every replica's
// landing notes, a dormant one's included, the told notice ids, what the browser kept of every roadmap but the anonymous
// ones, and, where the account's replica went with a Discard, the old stores its question named. The route table hands
// these to the shell only where the room reads the copy.

import { effectsOf } from '../../../../../packages/api-contract/sync/reference/client/projections.js';
import { Id } from '../../../platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../platform/domain-kit/runner.js';
import { FixedZone } from '../../../platform/domain-kit/time.js';
import { APP_LOCALE } from '../../../platform/i18n/index.js';
import { syncSession } from '../../../platform/sync/session.js';
import { track as beacon } from '../../../telemetry/beacon.js';
import { countBucket } from '../../../telemetry/countBucket.js';
import { CarryNotes, OldStores } from '../carry/OldStores.js';
import { carryLedgerOf, listedAs } from '../domain/carry.js';
import { CoachThread } from '../domain/conversation.js';
import { Roadmap, RoadmapMeta } from '../domain/roadmaps.js';
import { RoadmapScopes } from '../domain/roadmapRules.js';
import { RoadmapNames } from '../kept/KeptChanges.js';
import { forgetToldNotices } from '../kept/toldNotices.js';
import { forgetShareResidue, forgetTreeResidue } from '../persistence/deviceResidue.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { failureTags } from './SyncStore.js';
import { t } from '../i18n/index.js';

const META = new Id('meta', RoadmapMeta);
const SIGN_IN_STEPS = new Set(['shown', 'add', 'discard', 'cancel']);
const SIGN_OUT_STEPS = new Set(['shown', 'keep', 'discard', 'cancel']);

const runnerOf = (engine) => new ActionRunner(new EngineReplica(engine), engine.registry, new FixedZone(0));

// The active replica's entries a question pins (`counted`), in the order the device committed them.
function entriesOf(engine, counted) {
  const pinned = new Set(counted);
  return engine.device.activeReplica.entries().filter((entry) => pinned.has(entry.localId));
}

// The roadmaps an entry writes: those whose tree scope or overlay it writes, and those whose record in the person's list it
// writes.
function roadmapsWrittenBy(entry) {
  return effectsOf(entry).flatMap(({ scope, d }) => (scope === RoadmapScopes.account
    ? d.filter((delta) => delta.t === Roadmap.type).map((delta) => String(delta.id))
    : [RoadmapNames.roadmapOf(scope)].filter(Boolean)));
}

// A change is one act of the person's: every entry the act commits carries its gesture's id, so making a roadmap, which
// writes its record and its first words, is one change, and so is a gesture composed over several scopes.

// One roadmap some of the device's queued entries change: the root of its branch, its name as the active replica holds
// it, whether it stands in that replica's list (`listed`) or stood there and was deleted (`deleted`), and how many of the
// person's changes change it. One in neither is another person's.
export class ChangedRoadmap {
  constructor({ root, name, listed, deleted, changes }) {
    this.root = root;
    this.name = name;
    this.listed = listed;
    this.deleted = deleted;
    this.changes = changes;
    Object.freeze(this);
  }

  // The roadmaps the entries a question pins change (`counted`, their local ids), each by the root of its branch, in
  // the order the device first changed it. An entry changes the roadmaps whose tree scope or overlay it writes, and
  // those whose record in the person's list it writes; a subtree's change is its root's. Each is named as the active
  // replica holds it, and only so: the browser never names a roadmap from another replica or from the server.
  static of(engine, counted) {
    const runner = runnerOf(engine);
    const parents = new Map(runner.read(RoadmapScopes.account, (read) => read.repository(Roadmap).all('drawn'))
      .map((roadmap) => [roadmap.id.record, roadmap.parent?.tree ?? null]));
    const rootOf = (tree) => {
      const path = [tree];
      for (let parent = parents.get(tree); parent && !path.includes(parent); parent = parents.get(parent)) path.push(parent);
      return path.at(-1);
    };
    const changes = new Map();
    for (const entry of entriesOf(engine, counted)) {
      for (const root of roadmapsWrittenBy(entry).map(rootOf)) changes.set(root, (changes.get(root) ?? new Set()).add(entry.gestureId));
    }
    return [...changes].map(([root, gestures]) => new ChangedRoadmap({
      root,
      name: ChangedRoadmap.nameOf(runner, root),
      listed: parents.has(root),
      deleted: runner.read(RoadmapScopes.account, (read) => listedAs(read, root)) === 'spent',
      changes: gestures.size,
    }));
  }

  static nameOf(runner, tree) {
    return runner.read(RoadmapScopes.tree(tree), (read) => read.repository(RoadmapMeta).find(META, 'drawn')?.title.trim()) || t('roadmap.common.untitled');
  }
}

// §8.2 One roadmap of the account's the old bundle kept that waits in its stores: the old roadmap, the roadmap it goes
// to, and how many of the person's changes it holds that the ledger has not carried.
class WaitingRoadmap {
  constructor(roadmap, to, changes) {
    this.roadmap = roadmap;
    this.to = to;
    this.changes = changes;
    Object.freeze(this);
  }

  // Of the old stores' roadmaps, those that go to `account`'s replica, the active one: those a ledger of it places, and
  // those its rows name or its list holds.
  static async of(engine, account, stores) {
    const { roadmaps } = await stores.read();
    return runnerOf(engine).read(RoadmapScopes.account, (read) => roadmaps.flatMap((roadmap) => {
      const ledger = carryLedgerOf(read, roadmap.id);
      if (ledger.to === null && !roadmap.belongsTo(account, listedAs(read, roadmap.id))) return [];
      return [new WaitingRoadmap(roadmap, ledger.to ?? roadmap.id, roadmap.unsentCount(ledger))];
    }));
  }
}

const formatted = (count) => new Intl.NumberFormat(APP_LOCALE).format(count);

// A roadmap the question names by its changes: "{name} · N changes".
const changedRow = (name, changes) => t('roadmap.accountChoice.changedRoadmap', { name, count: changes, shown: formatted(changes) });

// How many Coach conversations the work a question pins (`counted`) makes that still stand: those its entries write that
// the active replica draws. One made and deleted here is not counted, as a roadmap made and deleted is not named.
function conversationsOf(engine, counted) {
  const written = new Set(entriesOf(engine, counted).flatMap((entry) => effectsOf(entry).flatMap(({ scope, d }) => (scope === RoadmapScopes.account
    ? d.filter((delta) => delta.t === CoachThread.type).map((delta) => String(delta.id))
    : []))));
  return runnerOf(engine).read(RoadmapScopes.account, (read) => read.repository(CoachThread).all('drawn').filter((thread) => written.has(thread.id.record)).length);
}

// The engine adds without asking the roadmap work that changes no roadmap the signed-out list holds: the question would
// name only roadmaps the person does not own, and their changes join the account, with every conversation the work holds.
export function adoptionAnswer(engine, due) {
  return ChangedRoadmap.of(engine, due.counted).some((roadmap) => roadmap.listed) ? null : 'add';
}

// Add your roadmaps? (50.01, 50.03): every roadmap the signed-out work changes, as its Discard takes all of it: the
// browser's own roadmaps by name, and another's roadmap by its changes, each named as this browser showed it. One the
// person made and deleted here is not named: added or discarded, it stays deleted. Where the work holds Coach's
// conversations it is Add to your account? (10.4) instead, which counts what its Discard takes in one sentence: the
// browser's own roadmaps, the conversations, and the changes to another's roadmaps. Its Discard takes, with that work, what
// the browser kept beside the roadmaps it made, and the old stores the carry-over carried into it, as they stand while the
// question is asked (`forgetDiscarded`).
export async function signInWords(engine, due, track = beacon, { stores = new OldStores(), report = reportRoadmapFailure } = {}) {
  const roadmaps = ChangedRoadmap.of(engine, due.counted).filter((roadmap) => !roadmap.deleted);
  const count = roadmaps.filter((roadmap) => roadmap.listed).length;
  const conversations = conversationsOf(engine, due.counted);
  const asked = countBucket(count);
  const talked = countBucket(conversations);
  const carried = await carriedInto(engine, due.counted, stores);
  return {
    ...(conversations > 0 ? countedWords(roadmaps, count, conversations) : {
      title: t('roadmap.accountChoice.addTitle'),
      lead: t('roadmap.accountChoice.addLead', { count, shown: formatted(count) }),
      items: roadmaps.map((roadmap) => (roadmap.listed ? roadmap.name : changedRow(roadmap.name, roadmap.changes))),
      note: t('roadmap.accountChoice.addNote', { count }),
    }),
    onStep: (step) => {
      if (SIGN_IN_STEPS.has(step)) track('roadmap_signin', { step, roadmaps: asked, conversations: talked });
      if (step === 'discard') return forgetDiscarded(engine, due.counted, { carried, stores, track, report });
      return undefined;
    },
  };
}

// 10.4's words, the Shell's question (iOS 23i) with this browser for this phone: how many of the browser's own roadmaps,
// how many conversations, and how many changes to another's roadmaps, in one sentence and again in the Discard that asks
// once more. The work always counts a roadmap and a conversation, so it is "them".
function countedWords(roadmaps, count, conversations) {
  const changes = roadmaps.filter((roadmap) => !roadmap.listed).reduce((sum, roadmap) => sum + roadmap.changes, 0);
  const work = new Intl.ListFormat(APP_LOCALE, { type: 'conjunction' }).format([
    t('roadmap.accountChoice.roadmaps', { count, shown: formatted(count) }),
    t('roadmap.accountChoice.conversations', { count: conversations, shown: formatted(conversations) }),
    ...(changes > 0 ? [t('roadmap.accountChoice.changes', { count: changes, shown: formatted(changes) })] : []),
  ]);
  return {
    title: t('roadmap.accountChoice.addWorkTitle'),
    lead: t('roadmap.accountChoice.addWorkLead', { work }),
    items: [],
    note: null,
    discard: { title: t('roadmap.accountChoice.discardWorkTitle', { work }), body: t('roadmap.accountChoice.discardWorkBody') },
  };
}

// §8.2 The old roadmaps the carry-over carried into the work a sign-in question counts (`counted`): those whose ledger in
// the active replica places them on a roadmap that work writes, each by its id with what its old stores hold now.
async function carriedInto(engine, counted, stores) {
  const written = new Set(entriesOf(engine, counted).flatMap(roadmapsWrittenBy));
  const { roadmaps } = await stores.read();
  return runnerOf(engine).read(RoadmapScopes.account, (read) => Object.fromEntries(roadmaps
    .filter((roadmap) => written.has(carryLedgerOf(read, roadmap.id).to)).map((roadmap) => [roadmap.id, roadmap.fingerprint])));
}

// Once the sign-in the person answered with Discard completes and the work it counted (`counted`, its entries' local ids)
// is gone from the browser, what the browser kept beside each roadmap that work wrote and the anon replica no longer holds
// goes too: its legend, its ledgers, the last place on it. So do the old stores the carry-over carried into that work
// (`carried`), each only while its entries hold what the question saw, so what an old tab wrote since stays: the engine's
// Discard took the ledger that placed them, and a later anon replica would carry them again. A sign-in cancelled, or
// completed with Add after all, takes none of it.
export async function forgetDiscarded(engine, counted, { carried = {}, stores = new OldStores(), forget = forgetTreeResidue, track = beacon,
  report = reportRoadmapFailure } = {}) {
  const written = new Set(entriesOf(engine, counted).flatMap(roadmapsWrittenBy));
  await new Promise((settled) => {
    const answered = () => {
      const { state, pendingSignIn } = engine.getSnapshot();
      if (state !== 'bound' && pendingSignIn) return;
      stop();
      settled();
    };
    const stop = engine.observeEngine(answered);
    answered();
  });
  if (engine.getSnapshot().state !== 'bound' || entriesOf(engine, counted).length > 0) return;
  const held = anonReplicaTrees(engine);
  forget((tree) => written.has(tree) && !held.has(tree));
  await discardOld(stores, (roadmap) => carried[roadmap.id] === roadmap.fingerprint, { track, report });
}

// Keep unsent changes? (50.02, 50.04), where every entry the sign-out question counts is roadmap's: how many changes, and
// each roadmap they change with how many change it, the account's roadmaps waiting in the old stores (§8.2) among them.
// Its Discard takes the replica's work and exactly those roadmaps' old stores, while they hold what was counted: the
// answer notes them (`CarryNotes.counted`) for the account's sweep, and every question begins with none noted. A question
// that counts nothing, or another product's work, keeps the shell's words, and its Discard takes no old store.
export async function signOutWords(engine, question, track = beacon, { stores = new OldStores(), notes = new CarryNotes() } = {}) {
  notes.counted = null;
  const entries = entriesOf(engine, question.counted);
  if (entries.length !== question.counted.length || entries.some((entry) => engine.registry.productOfRef(entry.scope) !== 'roadmap')) return null;
  const account = engine.device.activeReplica.meta.account;
  const waiting = await WaitingRoadmap.of(engine, account, stores);
  const rows = new Map(ChangedRoadmap.of(engine, question.counted).map((roadmap) => [roadmap.root, { name: roadmap.name, changes: roadmap.changes }]));
  for (const each of waiting.filter((one) => one.changes > 0)) {
    const row = rows.get(each.to) ?? { name: each.roadmap.name || t('roadmap.common.untitled'), changes: 0 };
    rows.set(each.to, { ...row, changes: row.changes + each.changes });
  }
  if (rows.size === 0) return null;
  const count = new Set(entries.map((entry) => entry.gestureId)).size + waiting.reduce((sum, each) => sum + each.changes, 0);
  const asked = countBucket(count);
  const counted = { account, roadmaps: Object.fromEntries(waiting.map((each) => [each.roadmap.id, each.roadmap.fingerprint])) };
  return {
    title: t('roadmap.accountChoice.keepTitle'),
    lead: t('roadmap.accountChoice.keepLead', { count, shown: formatted(count) }),
    items: [...rows.values()].map((row) => changedRow(row.name, row.changes)),
    note: t('roadmap.accountChoice.keepNote', { count }),
    onStep: (step) => {
      if (step === 'discard') notes.counted = counted;
      if (SIGN_OUT_STEPS.has(step)) track('roadmap_signout', { step, changes: asked });
    },
  };
}

// The roadmaps the anon replica holds: its own and those it reads.
function anonReplicaTrees(engine) {
  const { scopes, records } = engine?.anonymousRecords() ?? { scopes: [], records: [] };
  return new Set([
    ...records.filter((record) => record.scope === RoadmapScopes.account && record.t === Roadmap.type).map((record) => String(record.id)),
    ...scopes.map((scope) => RoadmapNames.roadmapOf(scope)).filter(Boolean),
  ]);
}

// The roadmaps that stay with whoever is at the browser next: the anon replica's, and the old stores' roadmaps made signed
// out that name nobody.
async function anonymousTrees(engine, stores) {
  const trees = anonReplicaTrees(engine);
  const { roadmaps } = await stores.read();
  for (const roadmap of roadmaps) if (roadmap.madeSignedOut && roadmap.owner === null) trees.add(roadmap.id);
  return trees;
}

// An explicit sign-out, an account replacement or an account closure of `previous`, Keep or Discard: every replica's
// landing notes and the told notices go, and so does what the browser kept of every roadmap but the anonymous ones (the
// legend, the ledgers, the last place, what sharing left). The old stores stay for the carry-over, but where the
// account's replica went with a Discard: then its question's Discard takes the old roadmaps it named, and a closure every
// one whose row names the account. A Keep takes none. This runs again at the next start where it was cut short.
export async function forgetReplicaRoom({ engine = syncSession.engine, previous = null, stores = new OldStores(), notes = new CarryNotes(),
  track = beacon, report = reportRoadmapFailure } = {}) {
  forgetToldNotices();
  forgetShareResidue();
  const anonymous = await anonymousTrees(engine, stores);
  forgetTreeResidue((tree) => !anonymous.has(tree));
  if (!engine) return;
  await engine.dropDeviceRows('roadmap', 'landing');
  const counted = notes.counted;
  if (previous === null || engine.hasReplicaOf(previous)) {
    if (counted?.account === previous) notes.counted = null;
    return;
  }
  const closing = engine.device.meta.closingAccount?.account === previous;
  const named = counted?.account === previous ? counted.roadmaps : {};
  if (await discardOld(stores, (roadmap) => named[roadmap.id] === roadmap.fingerprint || (closing && roadmap.owner === previous), { track, report })) notes.counted = null;
}

// A Discard's old roadmaps (§5 Signed out, §8.2): each one `taken` names goes uncarried, its entries only while they hold
// what was read, told as one count; a store that fails to delete is reported, and keeps them. Answers whether the
// stores answered.
async function discardOld(stores, taken, { track, report }) {
  try {
    const discarded = await stores.discard(taken);
    if (discarded > 0) track('roadmap_carry', { stage: 'discarded', roadmaps: countBucket(discarded) });
    return true;
  } catch (error) {
    report('roadmap-carry-write', error, { stage: 'discard', ...failureTags(error) });
    return false;
  }
}
