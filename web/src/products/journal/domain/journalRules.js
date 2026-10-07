// @ts-check

import { Rule, RuleBook } from '../../../platform/domain-kit/rules.js';
import { ChoiceSpec, Path, TextSpec, Violation } from '../../../platform/domain-kit/values.js';
import { registry } from '../../../platform/sync/schema.js';
import { JournalState, JournalStateRules, Page } from './page.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/refusals.js').Refused} Refused */
/** @typedef {{ kind: 'invalid', violation: Violation } | { kind: 'tooLarge' } | { kind: 'claimConflict' } | { kind: 'other', refused: Refused }} JournalRefusal */

export const SavePageSpecs = Object.freeze({
  body: new TextSpec('journal.savePage.body', { unit: 'bytes', min: 0, max: 131_072, trim: false, nfc: false }),
  source: new ChoiceSpec('journal.savePage.source', ['typed', 'spoken']),
  actor: new TextSpec('journal.savePage.stamp.actor', { unit: 'bytes', min: 0, max: 64, trim: false, nfc: false }),
});

export const ClaimPageSpecs = Object.freeze({
  body: new TextSpec('journal.claimPage.body', { unit: 'bytes', min: 0, max: 131_072, trim: false, nfc: false }),
  source: new ChoiceSpec('journal.claimPage.source', ['typed', 'spoken']),
  claimId: new TextSpec('journal.claimPage.claimId', { unit: 'bytes', min: 1, max: 128, trim: false, nfc: false }),
});

/** @type {import('../../../platform/domain-kit/refusals.js').Refusals<JournalRefusal>} */
export const JournalRefusals = Object.freeze({
  ofViolation: (violation) => Object.freeze({ kind: 'invalid', violation }),
  ofRefused: (refused) => {
    if (refused.code === 'too-large') return Object.freeze({ kind: 'tooLarge' });
    if (refused.code === 'claim-conflict') return Object.freeze({ kind: 'claimConflict' });
    return Object.freeze({ kind: 'other', refused });
  },
  isGeneric: (refusal) => refusal.kind === 'other',
});

/** @param {JournalRefusal} refusal @returns {Json} */
export function refusalForm(refusal) {
  if (refusal.kind === 'invalid') return { invalid: refusal.violation.json };
  if (refusal.kind === 'tooLarge' || refusal.kind === 'claimConflict') return { [refusal.kind]: true };
  const { code, subject, detail, path } = refusal.refused;
  return { other: { code, subject, detail, path } };
}

const specs = Object.freeze([...Object.values(SavePageSpecs), ...Object.values(ClaimPageSpecs), ...JournalStateRules]);

export const JournalRules = Object.freeze({
  body: SavePageSpecs.body,
  specs,
  /** @param {string} path */
  spec: (path) => specs.find((spec) => spec.path === path) ?? null,
  book: new RuleBook(registry, [Page, JournalState], [
    ...specs.map((spec) => Rule.localSpec(spec)),
    ...['journal.day', 'journal.documentStamp', 'journal.mood', 'journal.energy', 'journal.contentClock']
      .map((name) => Rule.localCheck(name, Page.type)),
    Rule.localCheck('journalState', JournalState.type),
    Rule.serverDecided('journal.claim', ['claim-conflict'], Page.type),
  ]),
  /** @param {import('./page.js').PageDocument} doc @param {{ body: TextSpec, source: ChoiceSpec }} [bound] */
  check(doc, bound = SavePageSpecs) {
    bound.body.apply(doc.body, new Path('body'));
    for (const [name, value] of Object.entries({ mood: doc.mood, energy: doc.energy })) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 10)) {
        throw new Violation(`journal.${name}`, new Path(name), { kind: 'custom', custom: 'invalidScale' });
      }
    }
    bound.source.apply(doc.source, new Path('source'));
  },
});
