// THE COACH SHARE, AS RULES AND AS WORDS — one workout, handed to one person, with an end date on
// it. No React and no fetch in here; the two screens either side of it (CoachShare.jsx, the lifter's;
// SharedSession.jsx, the coach's) draw what this says.
//
// WHAT THIS IS NOT, and the words are load-bearing because the copy is a promise:
//   · it is NOT public. Nothing lists it, nothing indexes it, nothing links to it — the token is the
//     whole credential and it exists only where the lifter sent it. So the word "public" is not in
//     this file and must not appear on either screen.
//   · it is NOT a log. A share is ONE session: the reply carries no id at any depth, so there is
//     nothing in the coach's hands to walk to a second workout with.
//   · it is NOT a social object. There is no share sheet, no card, no image, no count of who opened
//     it. A coach share is a link a lifter sends to a person they chose.
//   · it does NOT carry a name. The wire has no account on it — not an email, not a display name —
//     and that is deliberate, so the page says who it is from only in the sense that the person who
//     sent it is the person who sent it.
//
// The terms below are stated on the lifter's screen BEFORE they can copy anything, because they are
// the honest description of the thing the tap just created — and stated again, in the coach's own
// second person, on the page the link opens.

import { dayLabel, groupByExercise, sharedHref } from '../log.js';

// The link, whole, for a lifter to paste into a message. The server now sends a `url` too — it has
// to, because the phone and an MCP client have no page origin to read and both once composed the
// JSON route from the API's base, handing a coach a page of JSON. THIS surface keeps composing from
// the page's own origin anyway, and that is not drift: a browser knows exactly where it is being
// served from, while the server's WINDMILL_APP_URL is a deployment's guess that is a different port
// in development. The route itself is one function (`sharedHref`), which is the part that must not
// be written twice.
export function shareLink(token, origin = '') {
  return `${origin}/${sharedHref(token)}`;
}

// Said on the lifter's screen, where the instant is known. The coach's page cannot say this — the
// shared read carries no expiry, deliberately, since everything it holds is one workout and nothing
// about the capability — so that page states that the link ends without naming a day it cannot see.
export function expiryLine(expiresAtMs) {
  return `Expires ${dayLabel(expiresAtMs)}.`;
}

// Before the tap: what pressing it will make. The last clause is there because the mint is
// idempotent on the session and this screen forgets between visits — so a lifter who shared this
// workout last week and taps again gets that same link, on its original expiry, rather than a
// second capability. Saying so is cheaper than a state that would have to be read to be trusted.
export const SHARE_OFFER = 'Share with a coach';
export const SHARE_OFFER_LINE = 'A link to this one workout. It expires, you can revoke it here, and sharing again hands back the same link rather than a second one.';

// After the tap: what the link in hand actually is. Read in this order on purpose — the capability
// first, its limits second, the way out third.
export const SHARE_TERMS = [
  'Anyone holding this link can read this one workout.',
  'It opens nothing else — no other session, no account, no name.',
  'You can revoke it here at any time, and the link stops working.',
];

// The coach's own second person, on the page the link opens. Same three facts, none of them a
// promise this side cannot keep: the expiry has no date here because the wire carries none.
export const SHARED_TERMS = [
  'One workout, shared by the person who trained it.',
  'The link expires, and they can revoke it at any time.',
  'It carries no name and opens nothing else in their log.',
];

// A token that resolves to nothing. Revoked, expired and never-minted answer byte-identically on
// purpose — that is what stops a token from being probed for existence — so this page may not guess
// which of the three it is looking at, and says so rather than picking the friendliest one.
export const SHARED_ABSENT = {
  title: 'This link doesn’t open a workout.',
  body: 'It may have expired, been revoked, or never existed. The log answers all three the same way, so there is nothing more to tell you.',
};

// The coach reads the same session the owner does, in the same first-performed order — but the wire
// spells a movement as its display NAME rather than as a catalog id, because a reader with no
// account holds no catalog to resolve a slug against. One map, and then the product's one grouping
// rule does the rest.
export function sharedGroups(sets) {
  return groupByExercise(sets.map((set) => ({ ...set, exerciseId: set.exercise })));
}
