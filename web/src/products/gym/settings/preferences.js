import { failureReason, isStoreFailure } from '../errors.js';
import { t } from '../i18n/index.js';

export function restLabel(seconds) {
  if (seconds == null) return t('gym.settings.restOff');
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function preferenceRefusal(error) {
  if (error?.sentence) return error.sentence;
  if (isStoreFailure(error)) return t('gym.settings.notSaved', { reason: failureReason(error) });
  return t('gym.settings.notSavedNoAnswer');
}
