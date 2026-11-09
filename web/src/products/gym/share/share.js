import { t } from '../i18n/index.js';
import { dayLabel, groupByExercise, sharedHref } from '../log.js';

export function shareLink(token, origin = '') {
  return `${origin}/${sharedHref(token)}`;
}

export function expiryLine(expiresAtMs) {
  return t('gym.share.expires', { day: dayLabel(expiresAtMs) });
}

// The link a lifter hands to a person. It never carries the word coach — that names the room.
export const SHARE_OFFER = t('gym.share.offer');
export const SHARE_OFFER_LINE = t('gym.share.offerLine');

export const SHARE_TERMS = [
  t('gym.share.termsReadOne'),
  t('gym.share.termsOpensNothing'),
  t('gym.share.termsRevoke'),
];

export const SHARED_TERMS = [
  t('gym.share.sharedBy'),
  t('gym.share.sharedExpires'),
  t('gym.share.sharedNoName'),
  t('gym.share.sharedKilograms'),
];

// Revoked, expired and never-minted answer identically; never guess which.
export const SHARED_ABSENT = {
  title: t('gym.share.absentTitle'),
  body: t('gym.share.absentBody'),
};

// The shared wire spells a movement as its display name, not a catalog id.
export function sharedGroups(sets) {
  return groupByExercise(sets.map((set) => ({ ...set, exerciseId: set.exercise })));
}
