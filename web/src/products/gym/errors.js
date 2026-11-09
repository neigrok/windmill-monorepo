// The gym's failures, and the reason a screen gives for each.

import { CommitError } from '../../../../packages/api-contract/sync/reference/client/commit.js';
import { t } from './i18n/index.js';

// A REST door's answer that was not a success, in the server's words and code.
export class GymError extends Error {
  constructor(status, detail = '', code = '', body = null) {
    super(detail || `gym request failed: ${status}`);
    this.name = 'GymError';
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.generation = body?.generation;
  }
}

// A refused write: the engine's code, the sentence a screen shows, and for an
// overlap the finished session the workout's times cross.
export class GymRefusal extends Error {
  constructor(code, { sentence = t('gym.errors.refused'), overlapping = null } = {}) {
    super(sentence);
    this.name = 'GymRefusal';
    this.code = code;
    this.sentence = sentence;
    this.overlapping = overlapping;
  }
}

// This device's own store could not keep an engine write. The engine has already reported it.
export function isStoreFailure(error) {
  return error instanceof CommitError && error.kind === 'store';
}

// A Coach answer that stopped before it finished, whether the server said so or the stream broke off.
export const RESPONSE_INTERRUPTED = t('gym.errors.responseInterrupted');

export function failureReason(error) {
  if (error instanceof GymRefusal) {
    return error.code === 'not-writable' ? t('gym.errors.reasonSignedOut') : t('gym.errors.reasonNotTaken');
  }
  if (isStoreFailure(error)) return t('gym.errors.reasonNotStored');
  if (error instanceof CommitError || error?.status === 400 || error?.status === 409) return t('gym.errors.reasonNotTaken');
  if (error?.status === 401) return t('gym.errors.reasonSignedOut');
  if (error?.status === 404) return t('gym.errors.reasonGone');
  return t('gym.errors.reasonNoAnswer');
}
