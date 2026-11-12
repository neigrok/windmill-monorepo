// The guides above a tree: those of its holder's trees that lead down to it, farthest first, as its agents are given
// them before the tree's own. They are read here and written where they stand, each on its own tree.

import { hasGuide, withLineFeeds } from './GuideDraft.js';

// What `GET /v1/trees/{id}/guides` answered, read against its contract, { guides: [{ treeId, title, text }] }. `above`
// holds each guide above `treeId` as { treeId, title, text }, in the reply's order: the tree's own entry is left out,
// as the room holds that guide, a tree answered twice stands once, where it stood farthest, and an entry with no words
// is none. A tree with no title takes `untitled`. `shaped` is false where the body holds no array of guides, or an
// entry lacks a tree id or a text: what is well formed is still read.
export function guidesAbove(reply, { treeId, untitled }) {
  const entries = Array.isArray(reply?.guides) ? reply.guides : null;
  const read = (entries ?? []).filter((guide) => typeof guide?.treeId === 'string' && guide.treeId !== '' && typeof guide.text === 'string');
  const above = new Map();
  for (const guide of read) {
    if (guide.treeId === treeId || above.has(guide.treeId) || !hasGuide(guide.text)) continue;
    above.set(guide.treeId, {
      treeId: guide.treeId,
      title: (typeof guide.title === 'string' && guide.title.trim()) || untitled,
      text: withLineFeeds(guide.text),
    });
  }
  return { above: [...above.values()], shaped: entries !== null && read.length === entries.length };
}

// Why a read of the guides above failed, as its report's one tag says it: `network` for a request that never arrived,
// `unavailable` where the server could not read the trees above, and `server` for any other failure of its own. An
// answer that is not the contract's shape is no failure of the read, and its report says `shape`.
export function readFailureReason(error) {
  if (error?.status === 0) return 'network';
  if (error?.status === 503 && error.code === 'guides-unavailable') return 'unavailable';
  return 'server';
}

// What the entry's line names: the two farthest trees, and how many more stand between them and this one.
export function namedAbove(above) {
  const [first = null, second = null] = above.map((guide) => guide.title);
  return { first, second, more: Math.max(0, above.length - 2) };
}
