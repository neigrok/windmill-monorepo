// The guides above a tree: those of its holder's trees that lead down to it, farthest first, as its agents are given
// them before the tree's own. They are read here and written where they stand, each on its own tree.

import { hasGuide, withLineFeeds } from './GuideDraft.js';

// What `GET /v1/trees/{id}/guides` answered as the guides above `treeId`: each as { treeId, title, text }, in the reply's
// order. The tree's own entry is left out, as the room holds that guide, and so is anything that is not a guide with
// words. A tree with no title takes `untitled`.
export function guidesAbove(reply, { treeId, untitled }) {
  const guides = Array.isArray(reply?.guides) ? reply.guides : [];
  return guides
    .filter((guide) => typeof guide?.treeId === 'string' && guide.treeId !== treeId && typeof guide.text === 'string' && hasGuide(guide.text))
    .map((guide) => ({
      treeId: guide.treeId,
      title: (typeof guide.title === 'string' && guide.title.trim()) || untitled,
      text: withLineFeeds(guide.text),
    }));
}

// What the entry's line names: the two farthest trees, and how many more stand between them and this one.
export function namedAbove(above) {
  const [first = null, second = null] = above.map((guide) => guide.title);
  return { first, second, more: Math.max(0, above.length - 2) };
}
