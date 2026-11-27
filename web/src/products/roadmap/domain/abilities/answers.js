// @ts-check
// Roadmap Coach §6.1: what an ability answers, the result it read, the room's acts a direct write is carried out as with
// the result it answers, or the refusal of the call, and the codes it refuses with. Every ability answers in this form,
// the vectors' `expect`.

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {{ code: string, id?: string }} AbilityRefusal */
/** @typedef {{ action: string, input: { [key: string]: Json } }} RoomAct one of the domain's actions, named and shaped as the domain corpus's cases name and shape it */
/**
 * @typedef {{ result: { [key: string]: Json } }
 *   | { writes: RoomAct[], result: { [key: string]: Json } }
 *   | { refused: AbilityRefusal }} AbilityResponse
 */

// §6.1 The codes an ability refuses with, those of the abilities built.
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
  unknownKind: 'unknown-kind',
  addressNotAllowed: 'address-not-allowed',
  opensRoadmap: 'opens-roadmap',
  stepLocked: 'step-locked',
  roadmapChanged: 'roadmap-changed',
  noChange: 'no-change',
});

// §6.1 A refusal names, as `id`, what the failing check is about, where that is a step, a ref, a kind or a roadmap.
/** @param {string} code @param {string} [id] @returns {AbilityResponse} */
export function refusal(code, id) {
  return { refused: id === undefined ? { code } : { code, id } };
}
