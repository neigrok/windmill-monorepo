import { failureReason, isStoreFailure } from '../errors.js';

export function restLabel(seconds) {
  if (seconds == null) return 'off';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function preferenceRefusal(error) {
  if (error?.sentence) return error.sentence;
  if (isStoreFailure(error)) return `that setting didn’t save — ${failureReason(error)}`;
  return 'that setting didn’t save — the log didn’t answer. Try again in a moment';
}
