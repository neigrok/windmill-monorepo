// @ts-check
// The acts and the read of `turn-records-actions.json` as its cases name them (the corpus README's Actions table).

import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { CoachMessage, CoachThread, EndTurn } from '../../../../src/products/roadmap/domain/conversation.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { BeginRound, CoachHistory, DeleteConversation, ForgetRunningTurn, InterruptStaleTurn, RecordWriteFate, RecoverMark, StreamTurnText }
  from '../../../../src/products/roadmap/domain/turnRecords.js';

/** @param {any} input */
export function turnRecordAct(input) {
  const { action, input: given } = input;
  const message = () => new Id(given.message, CoachMessage);
  switch (action) {
    case 'BeginRound': return new BeginRound(message(), { callId: given.callId, text: given.text });
    case 'StreamTurnText': return new StreamTurnText(message(), given.text);
    case 'RecoverMark': return new RecoverMark();
    case 'ForgetRunningTurn': return new ForgetRunningTurn(message());
    case 'InterruptStaleTurn': return new InterruptStaleTurn(message(), given.serverNow);
    case 'RecordWriteFate': return new RecordWriteFate(message(), { receipt: given.receipt, fate: given.fate, code: given.code ?? null });
    case 'DeleteConversation': return new DeleteConversation(new Id(given.thread, CoachThread));
    case 'EndTurn': return new EndTurn(message(), { state: given.state, text: given.text ?? null, truncated: given.truncated ?? false,
      refusal: given.refusal ?? null, calls: given.calls ?? null, receipts: given.receipts ?? null });
    default: throw new Error(`no turn record act ${action}`);
  }
}

/**
 * @param {import('../../../platform/domain-kit/vectors.js').Vector} vector
 * @param {(vector: any, scope: string, body: (read: any) => any) => any} readScope
 */
export function turnRecordRead(vector, readScope) {
  if (vector.input.read !== 'history') throw new Error(`no turn record read ${vector.input.read}`);
  return readScope(vector, RoadmapScopes.account, (read) => CoachHistory.read(read, vector.input.input.current ?? null));
}
