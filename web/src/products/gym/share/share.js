import { dayLabel, groupByExercise, sharedHref } from '../log.js';

export function shareLink(token, origin = '') {
  return `${origin}/${sharedHref(token)}`;
}

export function expiryLine(expiresAtMs) {
  return `Expires ${dayLabel(expiresAtMs)}.`;
}

export const SHARE_OFFER = 'Share with a coach';
export const SHARE_OFFER_LINE = 'A link to this one workout. It expires, you can revoke it here, and sharing again hands back the same link rather than a second one.';

export const SHARE_TERMS = [
  'Anyone holding this link can read this one workout.',
  'It opens nothing else — no other session, no account, no name.',
  'You can revoke it here at any time, and the link stops working.',
];

export const SHARED_TERMS = [
  'One workout, shared by the person who trained it.',
  'The link expires, and they can revoke it at any time.',
  'It carries no name and opens nothing else in their log.',
  'Weights are in kilograms.',
];

// Revoked, expired and never-minted answer identically; never guess which.
export const SHARED_ABSENT = {
  title: 'This link doesn’t open a workout.',
  body: 'It may have expired, been revoked, or never existed. The log answers all three the same way, so there is nothing more to tell you.',
};

// The shared wire spells a movement as its display name, not a catalog id.
export function sharedGroups(sets) {
  return groupByExercise(sets.map((set) => ({ ...set, exerciseId: set.exercise })));
}
