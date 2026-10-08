// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { DecodeError, Fields } from '../../../../src/platform/domain-kit/entities.js';
import { Reader, Views } from '../../../../src/platform/domain-kit/reading.js';
import { Plan } from '../../../../src/platform/domain-kit/plans.js';
import { Fault, Violation } from '../../../../src/platform/domain-kit/values.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { JournalRefusals, JournalRules, refusalForm } from '../../../../src/products/journal/domain/journalRules.js';
import { ClaimPage, ClaimPageCommand, ContentClock, EditorDraft, PendingClaim, ReconcileClaim, RetireJournalInvitation, SavePage, SavePageCommand } from '../../../../src/products/journal/domain/writing.js';
import { ProductCorpus } from '../../../platform/domain-kit/productCorpus.js';
import { RegistryCheck, RuleBookCheck, RuleBookParity } from '../../../platform/domain-kit/checks.js';
import { Contract, ContractError, momentOf, viewRecords, withRecordsReversed } from '../../../platform/domain-kit/vectors.js';
import { locateEcho } from '../../../../src/products/journal/domain/echoes.js';

/** @typedef {import('../../../platform/domain-kit/vectors.js').Vector} Vector */
/** @typedef {import('../../../../src/platform/domain-kit/values.js').Json} Json */

const rulesFile = 'journal/domain/rules.json';
const valuesFile = 'journal/domain/values.json';
const actionsFile = 'journal/domain/page-actions.json';
const echoesFile = 'journal/domain/echo-quotes.json';
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

class JournalCorpus extends ProductCorpus {
  /** @param {Vector} vector @param {string} scope */
  reader(vector, scope) {
    const input = vector.input;
    const records = input.records;
    const ids = [...(input.ids ?? [])];
    const views = Views.ofRecords(this.book.registry, {
      drawn: viewRecords(records.drawn), stored: viewRecords(records.stored ?? records.drawn),
      confirmed: viewRecords(records.confirmed ?? records.stored ?? records.drawn),
      devices: input.devices ?? {}, firstPullComplete: input.firstPullComplete ?? true,
      actor: input.actor, isAnonymous: input.anonymous ?? false,
      commands: input.commands ?? [], checkpoint: input.checkpoint ?? { epoch: null, cleanSeq: null },
      opaqueID: () => {
        const id = ids.shift();
        if (typeof id !== 'string') throw new Fault('the journal vector has no opaque id left');
        return id;
      },
    });
    return new Reader(views, scope, momentOf(input));
  }

  /** @param {Vector} vector */
  runValue(vector) {
    const input = vector.input;
    if (input.spec || input.entity) return super.value(vector);
    try {
      switch (input.op) {
        case 'command': {
          if (!['SavePage', 'ClaimPage'].includes(input.command)) throw new ContractError(`unclaimed command ${input.command}`);
          const command = input.command === 'SavePage' ? new SavePageCommand(input.args) : new ClaimPageCommand(input.args);
          return { args: Plan.running(command).command?.args ?? null };
        }
        case 'ContentClock.valid': return { valid: ContentClock.valid(input.stamp) };
        case 'ContentClock.advance':
          try { return { stamp: ContentClock.advance(input) }; }
          catch { return { error: true }; }
        case 'EditorDraft.adopt': {
          const incoming = input.incoming === null ? null : EditorDraft.fromJSON(input.incoming);
          const current = input.current === null ? null : EditorDraft.fromJSON(input.current);
          const adopted = EditorDraft.adopt(incoming, current);
          return { current: adopted.current?.json ?? null, recovered: adopted.recovered?.json ?? null };
        }
        case 'PendingClaim.reconcileBody': return { body: PendingClaim.reconcileBody(input.joined, input.base, input.latest) };
        case 'PendingClaim.edit': {
          const pending = PendingClaim.fromJSON(input.pending);
          pending.edit(input.document, Object.fromEntries(input.retiring.map((/** @type {string} */ name) => [name, 'retired'])));
          return { pending: pending.json };
        }
        default: throw new ContractError(`unclaimed journal value ${input.op}`);
      }
    } catch (error) {
      if (error instanceof Violation) return { violation: error.json };
      if (error instanceof DecodeError || error instanceof TypeError) return { error: true };
      throw error;
    }
  }
}

const corpus = new JournalCorpus(JournalRules.book, JournalRules.spec);

/** @type {Record<string, (vector: Vector) => unknown>} */
const handlers = {
  [echoesFile]: ({ input }) => ({ range: locateEcho(input.body, input.text, input.occurrenceHint,
    (value) => graphemes.segment(value)) }),
  [valuesFile]: (vector) => corpus.runValue(vector),
  [actionsFile]: (vector) => {
    const input = vector.input;
    /** @type {import('../../../../src/platform/domain-kit/actions.js').Decider<any, any, import('../../../../src/products/journal/domain/journalRules.js').JournalRefusal>} */
    let action;
    switch (input.action) {
      case 'SavePage': action = new SavePage(input.input); break;
      case 'ClaimPage': action = new ClaimPage(input.input); break;
      case 'ReconcileClaim': action = new ReconcileClaim(input.input); break;
      case 'RetireJournalInvitation': action = new RetireJournalInvitation(input.input); break;
      default: throw new ContractError(`unclaimed journal action ${input.action}`);
    }
    return corpus.decision(action, vector, (result) => result, refusalForm);
  },
};

test('the web claims every journal vector file', (t) => {
  assert.deepEqual([rulesFile, ...Object.keys(handlers)].sort(), Contract.files('journal/domain'));
  t.diagnostic(`journal corpus: ${Object.keys(handlers).length + 1}/${Contract.files('journal/domain').length} files, ${1 + Object.keys(handlers).reduce((sum, file) => sum + Contract.vectors(file).length, 0)} comparisons, none pending`);
});

test('the two-entity journal book equals the pinned bytes', () => RuleBookParity.check(JournalRules.book, rulesFile));
test('every journal rule has shared coverage and maps both refusal paths', () => RuleBookCheck.check(JournalRules.book, JournalRefusals, valuesFile, [actionsFile]));
test('journal declarations agree with the registry', () => {
  const vectors = Contract.vectors(valuesFile);
  for (const entity of JournalRules.book.entities) {
    const sample = vectors.find((vector) => vector.input.entity === entity.type);
    RegistryCheck.entity(entity, entity.isWritable && sample ? entity.decode(Fields.values(entity.type, sample.input.id, sample.input.fields)) : null, JournalRules.book);
  }
});

for (const [file, run] of Object.entries(handlers)) for (const vector of Contract.vectors(file)) {
  test(`${file} · ${vector.name}`, () => {
    const before = jcs(vector.input);
    assert.equal(jcs(run(vector)), jcs(vector.expect));
    assert.equal(jcs(vector.input), before, 'a pure decision preserves its input');
    const reversed = withRecordsReversed(vector.input);
    if (reversed.records?.confirmed) reversed.records.confirmed.reverse();
    assert.equal(jcs(run({ ...vector, input: reversed })), jcs(vector.expect), 'reversed records');
  });
}
