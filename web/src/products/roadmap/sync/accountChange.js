// Roadmap on the device's copy as the account changes (roadmap-on-the-engine.md §5 Signed out, flow 50). The engine's
// lineage rule adds signed-out roadmaps to an account that holds none without asking; where the account holds some, the
// shell asks Add or Discard, and at sign-out with changes unsent, Keep or Discard. Roadmap words both questions, naming
// the roadmaps the work changes, and tells each step to the intake. Signing out also takes what the engine's own sign-out
// lets go of: every roadmap's landing note, in each replica the device holds (Keep leaves the account's dormant replica
// with its device rows, Discard deletes it), and the ids of the notices this browser told the intake of; no engine API
// reaches a dormant replica, so the sweep writes the device's store itself. The route table hands these to the shell only
// where the room reads the device's copy; the shell names no product.

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

// One roadmap some of the device's queued entries change: the root of its branch, its name as the device holds it,
// whether it stands in the person's list, and how many of the entries change it.
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
    const pinned = new Set(counted);
    const changes = new Map();
    for (const entry of engine.device.activeReplica.entries()) {
      if (!pinned.has(entry.localId)) continue;
      const written = effectsOf(entry).flatMap(({ scope, d }) => (scope === RoadmapScopes.account
        ? d.filter((delta) => delta.t === Roadmap.type).map((delta) => String(delta.id))
        : [RoadmapNames.roadmapOf(scope)].filter(Boolean)));
      for (const root of new Set(written.map(rootOf))) changes.set(root, (changes.get(root) ?? 0) + 1);
    }
    return [...changes].map(([root, count]) => new ChangedRoadmap({
      root,
      name: runner.read(RoadmapScopes.tree(root), (read) => read.repository(RoadmapMeta).find(META, 'drawn')?.title.trim()) || t('roadmap.common.untitled'),
      listed: parents.has(root),
      changes: count,
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

// Keep unsent changes? (50.02, 50.04), where every change the sign-out question counts is roadmap's: how many, and each
// roadmap they change with how many change it. A question that counts no change, or another product's, keeps the
// shell's words.
export function signOutWords(engine, question, track = beacon) {
  const roadmaps = new Set(engine.device.activeReplica.entries()
    .filter((entry) => engine.registry.productOfRef(entry.scope) === 'roadmap').map((entry) => entry.localId));
  if (question.unsent === 0 || !question.counted.every((localId) => roadmaps.has(localId))) return null;
  const count = question.unsent;
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
