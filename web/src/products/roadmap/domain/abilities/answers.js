// @ts-check
// Roadmap Coach §6.1: what an ability answers, the result it read, the room's acts a direct write is carried out as with
// the result it answers, a proposal minted with the result it answers, or the refusal of the call, and the codes it
// refuses with. Every ability answers in this form, the vectors' `expect`.

import { JcsError, jcs } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Path, Violation } from '../../../../platform/domain-kit/values.js';
import { RoadmapSpecs } from '../roadmapRules.js';

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../platform/domain-kit/values.js').TextSpec} TextSpec */
/** @typedef {{ code: string, id?: string, at?: number }} AbilityRefusal */
/** @typedef {{ action: string, input: { [key: string]: Json } }} RoomAct one of the domain's actions, named and shaped as the domain corpus's cases name and shape it */
/** @typedef {{ changes: { [key: string]: Json }[], base: Json[] }} MintedProposal what a proposal's record holds of its changes, each new step and kind under its id, and its base (§7) */
/**
 * @typedef {{ result: { [key: string]: Json } }
 *   | { writes: RoomAct[], result: { [key: string]: Json } }
 *   | { result: { [key: string]: Json }, proposal: MintedProposal }
 *   | { refused: AbilityRefusal }} AbilityResponse
 */

// §6.1 The codes an ability refuses with.
export const AbilityCodes = Object.freeze({
  invalidInput: 'invalid-input',
  roadmapUnavailable: 'roadmap-unavailable',
  unknownRoadmap: 'unknown-roadmap',
  roadmapNotReady: 'roadmap-not-ready',
  notOwner: 'not-owner',
  outOfScope: 'out-of-scope',
  overLimit: 'over-limit',
  unknownStep: 'unknown-step',
  closesCycle: 'closes-cycle',
  takesEveryStart: 'takes-every-start',
  unknownKind: 'unknown-kind',
  addressNotAllowed: 'address-not-allowed',
  opensRoadmap: 'opens-roadmap',
  stepLocked: 'step-locked',
  hueTaken: 'hue-taken',
  roadmapChanged: 'roadmap-changed',
  noChange: 'no-change',
});

// §6.1 A refusal names, as `id`, what the failing check is about, where that is a step, a ref, a kind or a roadmap; a
// refusal of a proposal's change also carries `at`, the change's index (§7).
/** @param {string} code @param {string} [id] @param {number} [at] @returns {{ refused: AbilityRefusal }} */
export function refusal(code, id, at) {
  return { refused: { code, ...(id === undefined ? {} : { id }), ...(at === undefined ? {} : { at }) } };
}

// §6.1, §6 rule 4: what the door would refuse of the texts a write sends, by the spec it applies to each, null where it
// takes every one. A text the domain cannot store at all, one that holds U+0000 or a lone surrogate, or one it takes no
// blank of, a subtask's, is `invalid-input`, before any cap; one past its cap, measured as its spec measures it, after the
// trim it applies, is `over-limit`. A blank address is the address rule's (rule 5).
/** @param {[string | undefined, TextSpec][]} texts @returns {string | null} */
export function textRefusal(texts) {
  const codes = texts.flatMap(([text, spec]) => {
    if (text === undefined) return [];
    try {
      jcs(text);
      spec.apply(text, new Path(spec.path));
      return [];
    } catch (error) {
      if (error instanceof JcsError) return [AbilityCodes.invalidInput];
      if (!(error instanceof Violation)) throw error;
      if (error.reason.kind === 'tooLong') return [AbilityCodes.overLimit];
      return error.reason.kind === 'nul' || spec !== RoadmapSpecs.linkUrl ? [AbilityCodes.invalidInput] : [];
    }
  });
  return codes.includes(AbilityCodes.invalidInput) ? AbilityCodes.invalidInput : codes[0] ?? null;
}
