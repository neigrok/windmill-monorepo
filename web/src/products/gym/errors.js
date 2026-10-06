// The gym's failures, and the reason a screen gives for each.

import { CommitError } from '../../platform/sync/client/commit.js';

// A REST door's answer that was not a success, in the store's words and code. 400 and 409 are terminal.
export class GymError extends Error {
  constructor(status, detail = '', code = '', body = null) {
    super(detail || `gym request failed: ${status}`);
    this.name = 'GymError';
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.terminal = status === 400 || status === 409;
    this.generation = body?.generation;
  }
}

// A write the log refused before storing it: the engine's code, the sentence a screen shows, and for an
// overlap the finished session the workout's times cross.
export class GymRefusal extends Error {
  constructor(code, { sentence = 'The log wouldn’t take this change as written.', overlapping = null } = {}) {
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

export function failureReason(error) {
  if (error instanceof GymRefusal) {
    return error.code === 'not-writable' ? 'you’re signed out. Sign in and try again' : 'the log wouldn’t take it as written';
  }
  if (isStoreFailure(error)) return 'this device couldn’t store it';
  if (error instanceof CommitError || error?.terminal) return 'the log wouldn’t take it as written';
  if (error?.status === 401) return 'you’re signed out. Sign in and try again';
  if (error?.status === 404) return 'it isn’t in the log any more';
  return 'the log didn’t answer. Try again when you have signal';
}
