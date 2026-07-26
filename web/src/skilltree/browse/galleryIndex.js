// The public gallery index, as the browser holds it: the server's ranked page joined to
// what this page already has, plus the two state-aware facts each card wears. Pure and
// dependency-free — GET /v1/gallery owns the ranking (two URLs, one index, never two
// rankings), so nothing here ever sorts or filters what came back.

// Canon §5 — the sort control is earned, not invented: the Popular · New · Finished chips
// appear at 24 listed trees and the search icon at 100. The numbers live here so they
// aren't re-argued per release. The live index is in single digits, so neither control is
// built yet; when `count` crosses these, this is what turns them on.
export const CHIPS_AT = 24;
export const SEARCH_AT = 100;

export function galleryHeader(count) {
  return {
    line: count === 0 ? '' : `${count} ${count === 1 ? 'tree' : 'trees'} planted in public`,
    chips: count >= CHIPS_AT,
    search: count >= SEARCH_AT,
  };
}

// One page's worth of the index, and the walk that grows it. `status` is the page's whole
// story: loading (nothing has arrived), ready (a page is on screen), paging (the next one
// is in flight), failed (the server didn't answer). `cursor` is empty when the index ends
// here — so `hasMore` is the button's only condition.
export class GalleryIndex {
  constructor({ entries = [], count = 0, cursor = '', status = 'loading' } = {}) {
    this.entries = entries;
    this.count = count;
    this.cursor = cursor;
    this.status = status;
  }

  get hasMore() {
    return this.cursor !== '';
  }

  // Bare, and the server has spoken: nothing is listed. Distinct from loading, which looks
  // identical and means the opposite.
  get isBare() {
    return this.status === 'ready' && this.entries.length === 0;
  }

  // Appends the page in the order it arrived. An entry already on screen is dropped rather
  // than repeated: a tree can move between pages while someone forks, and a wall that shows
  // the same tree twice reads as a bug in the tree, not in the paging.
  join(page) {
    const seen = new Set(this.entries.map((entry) => entry.id));
    return new GalleryIndex({
      entries: [...this.entries, ...page.entries.filter((entry) => !seen.has(entry.id))],
      count: page.count,
      cursor: page.nextCursor,
      status: 'ready',
    });
  }

  paging() {
    return new GalleryIndex({ ...this, status: 'paging' });
  }

  failed() {
    return new GalleryIndex({ ...this, status: 'failed' });
  }

  // A fork just landed: the source wears "Forked" from this moment on — it can't be forked
  // twice by accident — carries the copy it made so the card can offer to open it, and
  // counts the fork it just inspired. Its place in the ranking does NOT move; the order on
  // screen is the server's, and a reload is where a new ranking comes from.
  forked(treeId, copyId) {
    return new GalleryIndex({
      ...this,
      entries: this.entries.map((entry) => (
        entry.id === treeId ? { ...entry, forked: true, copyId, forks: entry.forks + 1 } : entry
      )),
    });
  }
}

// What a card wears, given who is reading (canon §3 — the in-product surface knows you).
// Your own listed tree opens in your editor and is never offered back to you; a tree you
// have already forked says so instead of offering a second copy; everything else opens
// read-only, the way a stranger sees it, and offers the fork.
export function cardMark(entry) {
  if (entry.mine) return { badge: 'Listed by you', fork: 'none', href: `#/app/${entry.id}` };
  if (entry.copyId) return { badge: 'Forked', fork: 'copy', href: `#/t/${entry.id}` };
  if (entry.forked) return { badge: 'Forked', fork: 'done', href: `#/t/${entry.id}` };
  return { badge: '', fork: 'offer', href: `#/t/${entry.id}` };
}
