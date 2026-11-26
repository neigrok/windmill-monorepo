// @ts-check

import { ActDecision } from '../../../platform/domain-kit/acts.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { DomainNotice } from '../../../platform/domain-kit/refusals.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { FollowGraph } from './graph.js';
import { LandingNote } from './records.js';
import { landingFacts } from './reads.js';
import { RoadmapRefusals, RoadmapScopes, writeIn } from './roadmapRules.js';
import { Roadmap } from './roadmaps.js';
import { landingOrder, readNote, readTree } from './steps.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/refusals.js').Notice} Notice */
/** @typedef {import('../../../../../packages/api-contract/sync/reference/core/registry.js').Registry} Registry */
/** @typedef {'roadmapDeleted' | 'capFilled' | 'accessEnded' | 'noteTooLong'} CannotLandReason */

// §6 What a device tells a person once, read from its note and the roadmap as it now stands: each of its own
// new steps and links that follows through a step whose delete the server took before the link (`LandingNote.saying`),
// with the steps removed and the steps it now follows, each by name; and each step its change brought back. A link
// whose write has not landed tells nothing yet. A step the device still holds is named as it stands; one deleted
// elsewhere, of which it keeps nothing (engine.md §7.5), by the name its note took when it made the link, and by none
// (null) where the note holds none.
/**
 * @param {string} tree
 * @param {Reader} read
 */
export function landingOf(tree, read) {
  const note = LandingNote.of(read.device(RoadmapScopes.landing(tree)));
  const roadmap = readTree(tree, read);
  const name = (/** @type {string} */ id) => roadmap.nodesById.get(id)?.label ?? note.nameOf(id);
  const facts = landingFacts(new FollowGraph(roadmap), note.saying(roadmap, landingOrder(read)));
  return {
    follows: facts.map(({ node, incoming, followed }) => ({
      node, incoming,
      removed: incoming.map(([from = '']) => ({ id: from, name: name(from) })),
      followed: followed.map((entry) => ({ ...entry, name: name(entry.id) })),
    })),
    cameBack: note.revived.filter((id) => roadmap.nodesById.get(id)?.present === true),
    note,
  };
}

// Once told, the device clears what it told from its note, and with it each entry that has landed and can say
// nothing more (`readNote`). The note of a roadmap gone from the person's list, deleted there or no longer in it once
// the device has read the list, goes whole: nothing of it is told again. The note is the device's, not the roadmap's,
// so the act writes it through the account's scope, which a roadmap's end leaves writable.
export class ClearLanding {
  /**
   * @param {string} tree
   * @param {{ nodes?: string[], edges?: string[][], revived?: string[] }} told
   */
  constructor(tree, told) {
    this.tree = tree;
    this.told = told;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/acts.js').ActReader} read */
  load(read) {
    const { held, gone } = read.inScope(RoadmapScopes.account, (account) => ({
      held: LandingNote.of(account.device(RoadmapScopes.landing(this.tree))),
      gone: account.firstPullComplete() && account.repository(Roadmap).record(this.tree, 'drawn')?.life?.[0] !== 'alive',
    }));
    return { held, settled: gone ? null : read.inScope(RoadmapScopes.tree(this.tree), (tree) => readNote(this.tree, tree)) };
  }

  /** @param {{ held: LandingNote, settled: LandingNote | null }} loaded */
  decide({ held, settled }) {
    const left = settled === null ? new LandingNote() : settled.clearing(this.told);
    if (jcs(left.json) === jcs(held.json)) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.device(RoadmapScopes.landing(this.tree), left.isEmpty ? null : left.json);
    return writeIn(RoadmapScopes.account, plan, null);
  }
}

// §6 The one list of what cannot land, from the engine's notices: each with its reason, whether it made its subject or
// changed one that stood (`made`: the refused content creates it, its life made alive at its own birth), and what the
// person wrote, to copy or discard. Every other notice is no refusal a person is shown; `unexpected` names it for the
// failure report.
/**
 * @param {Notice[]} notices
 * @param {Registry} registry
 */
export function cannotLand(notices, registry) {
  /** @type {{ id: string, gestureId: string, reason: CannotLandReason, made: boolean, subject: import('../../../platform/domain-kit/entities.js').RecordRef | null, values: Record<string, Json> }[]} */
  const listed = [];
  /** @type {{ id: string, code: string }[]} */
  const unexpected = [];
  for (const notice of notices) {
    const read = new DomainNotice(notice, registry, RoadmapRefusals);
    const { refusal } = read;
    /** @type {CannotLandReason | null} */
    const reason = refusal.kind === 'roadmapGone' ? 'roadmapDeleted'
      : refusal.kind === 'full' ? 'capFilled'
        : refusal.kind === 'unreachable' ? 'accessEnded'
          : refusal.kind === 'tooLarge' && refusal.subject.t === 'stepNote' ? 'noteTooLong' : null;
    if (reason === null) {
      unexpected.push({ id: notice.id, code: notice.code });
      continue;
    }
    const { subject } = read;
    listed.push({
      id: notice.id, gestureId: read.gestureId, reason, made: subject !== null && creates(notice.content, jcs([subject.t, subject.id])),
      subject, values: subject === null ? {} : read.values(subject),
    });
  }
  return { listed, unexpected };
}

// Whether the content, or a dependent folded into it, creates the record `key` names (`jcs([t, id])`).
/**
 * @param {import('../../../platform/domain-kit/refusals.js').NoticeContent} content
 * @param {string} key
 * @returns {boolean}
 */
function creates(content, key) {
  return (content.d ?? []).some((delta) => jcs([delta.t, delta.id]) === key && delta.life?.[0] === 'alive' && delta.life[1] === delta.born)
    || (content.dependents ?? []).some((dependent) => creates(dependent, key));
}
