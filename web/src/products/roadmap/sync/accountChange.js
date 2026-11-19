// Roadmap on the device's copy as the account changes (roadmap-on-the-engine.md §5 Signed out, flow 50): the words of the
// shell's sign-in question, Add or Discard, where the account already holds roadmaps, and of its sign-out question, Keep or
// Discard, where every unsent change is roadmap's, each naming the roadmaps the work changes and telling its steps; and the
// sweep at sign-out of every replica's landing notes (no engine API reaches a dormant replica, so it writes the device's
// store itself) and the told notice ids. The route table hands these to the shell only where the room reads the copy.

import { effectsOf } from '../../../../../packages/api-contract/sync/reference/client/projections.js';
import { Id } from '../../../platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../platform/domain-kit/runner.js';
import { FixedZone } from '../../../platform/domain-kit/time.js';
import { APP_LOCALE } from '../../../platform/i18n/index.js';
import { syncSession } from '../../../platform/sync/session.js';
import { track as beacon } from '../../../telemetry/beacon.js';
import { countBucket } from '../board/acts.js';
import { Roadmap, RoadmapMeta } from '../domain/roadmaps.js';
import { RoadmapScopes } from '../domain/roadmapRules.js';
import { RoadmapNames } from '../kept/KeptChanges.js';
import { forgetToldNotices } from '../kept/toldNotices.js';
import { t } from '../i18n/index.js';

const META = new Id('meta', RoadmapMeta);
const SIGN_IN_STEPS = new Set(['shown', 'add', 'discard', 'cancel']);
const SIGN_OUT_STEPS = new Set(['shown', 'keep', 'discard', 'cancel']);

// The active replica's entries a question pins (`counted`), in the order the device committed them.
function entriesOf(engine, counted) {
  const pinned = new Set(counted);
  return engine.device.activeReplica.entries().filter((entry) => pinned.has(entry.localId));
}

// A change is one act of the person's: every entry the act commits carries its gesture's id, so making a roadmap, which
// writes its record and its first words, is one change, and so is a gesture composed over several scopes.

// One roadmap some of the device's queued entries change: the root of its branch, its name as the device holds it,
// whether it stands in the person's list, and how many of the person's changes change it.
export class ChangedRoadmap {
  constructor({ root, name, listed, changes }) {
    this.root = root;
    this.name = name;
    this.listed = listed;
    this.changes = changes;
    Object.freeze(this);
  }

  // The roadmaps the entries a question pins change (`counted`, their local ids), each by the root of its branch, in
  // the order the device first changed it. An entry changes the roadmaps whose tree scope or overlay it writes, and
  // those whose record in the person's list it writes; a subtree's change is its root's.
  static of(engine, counted) {
    const runner = new ActionRunner(new EngineReplica(engine), engine.registry, new FixedZone(0));
    const parents = new Map(runner.read(RoadmapScopes.account, (read) => read.repository(Roadmap).all('drawn'))
      .map((roadmap) => [roadmap.id.record, roadmap.parent?.tree ?? null]));
    const rootOf = (tree) => {
      const path = [tree];
      for (let parent = parents.get(tree); parent && !path.includes(parent); parent = parents.get(parent)) path.push(parent);
      return path.at(-1);
    };
    const changes = new Map();
    for (const entry of entriesOf(engine, counted)) {
      const written = effectsOf(entry).flatMap(({ scope, d }) => (scope === RoadmapScopes.account
        ? d.filter((delta) => delta.t === Roadmap.type).map((delta) => String(delta.id))
        : [RoadmapNames.roadmapOf(scope)].filter(Boolean)));
      for (const root of written.map(rootOf)) changes.set(root, (changes.get(root) ?? new Set()).add(entry.gestureId));
    }
    return [...changes].map(([root, gestures]) => new ChangedRoadmap({
      root,
      name: runner.read(RoadmapScopes.tree(root), (read) => read.repository(RoadmapMeta).find(META, 'drawn')?.title.trim()) || t('roadmap.common.untitled'),
      listed: parents.has(root),
      changes: gestures.size,
    }));
  }
}

const formatted = (count) => new Intl.NumberFormat(APP_LOCALE).format(count);

// The engine adds without asking the roadmap work that changes no roadmap the person's list holds: the question would
// name nothing they could see.
export function adoptionAnswer(engine, due) {
  return ChangedRoadmap.of(engine, due.counted).some((roadmap) => roadmap.listed) ? null : 'add';
}

// Add your roadmaps? (50.01, 50.03): the roadmaps of the person's list that the signed-out work changes, by name.
export function signInWords(engine, due, track = beacon) {
  const roadmaps = ChangedRoadmap.of(engine, due.counted).filter((roadmap) => roadmap.listed);
  const count = roadmaps.length;
  const asked = countBucket(count);
  return {
    title: t('roadmap.accountChoice.addTitle'),
    lead: t('roadmap.accountChoice.addLead', { count, shown: formatted(count) }),
    items: roadmaps.map((roadmap) => roadmap.name),
    note: t('roadmap.accountChoice.addNote', { count }),
    onStep: (step) => { if (SIGN_IN_STEPS.has(step)) track('roadmap_signin', { step, roadmaps: asked }); },
  };
}

// Keep unsent changes? (50.02, 50.04), where every entry the sign-out question counts is roadmap's: how many changes, and
// each roadmap they change with how many change it. A question that counts nothing, or another product's work, keeps the
// shell's words.
export function signOutWords(engine, question, track = beacon) {
  const entries = entriesOf(engine, question.counted);
  if (entries.length === 0 || entries.length !== question.counted.length
    || entries.some((entry) => engine.registry.productOfRef(entry.scope) !== 'roadmap')) return null;
  const count = new Set(entries.map((entry) => entry.gestureId)).size;
  const asked = countBucket(count);
  return {
    title: t('roadmap.accountChoice.keepTitle'),
    lead: t('roadmap.accountChoice.keepLead', { count, shown: formatted(count) }),
    items: ChangedRoadmap.of(engine, question.counted).map((roadmap) => t('roadmap.accountChoice.keepRoadmap',
      { name: roadmap.name, count: roadmap.changes, shown: formatted(roadmap.changes) })),
    note: t('roadmap.accountChoice.keepNote', { count }),
    onStep: (step) => { if (SIGN_OUT_STEPS.has(step)) track('roadmap_signout', { step, changes: asked }); },
  };
}

export async function forgetReplicaRoom(engine = syncSession.engine) {
  forgetToldNotices();
  if (!engine) return;
  await engine.write(null, (device) => {
    for (const replica of device.replicas) {
      const rows = replica.deviceRows('roadmap');
      for (const key of Object.keys(rows)) if (RoadmapScopes.isLanding(key)) delete rows[key];
    }
  });
}
