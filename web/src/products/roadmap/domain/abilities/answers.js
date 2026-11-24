// @ts-check
// Roadmap Coach §6.1: what an ability answers, the result it read or wrote or the refusal of the call, and the codes it
// refuses with. Every ability answers in this form, the vectors' `expect`.

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {{ code: string, id?: string }} AbilityRefusal */
/** @typedef {{ result: { [key: string]: Json } } | { refused: AbilityRefusal }} AbilityResponse */

// §6.1 The codes an ability refuses with, those of the abilities built.
export const AbilityCodes = Object.freeze({
  invalidInput: 'invalid-input',
  roadmapUnavailable: 'roadmap-unavailable',
  unknownRoadmap: 'unknown-roadmap',
  unknownStep: 'unknown-step',
  roadmapChanged: 'roadmap-changed',
});

// §6.1 A refusal names, as `id`, what the failing check is about, where that is a step, a ref, a kind or a roadmap.
/** @param {string} code @param {string} [id] @returns {AbilityResponse} */
export function refusal(code, id) {
  return { refused: id === undefined ? { code } : { code, id } };
}
