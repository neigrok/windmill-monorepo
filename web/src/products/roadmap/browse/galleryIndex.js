export const CHIPS_AT = 24;
export const SEARCH_AT = 100;

export function galleryHeader(count) {
  return {
    line: count === 0 ? '' : `${count} ${count === 1 ? 'tree' : 'trees'} planted in public`,
    chips: count >= CHIPS_AT,
    search: count >= SEARCH_AT,
  };
}

// status: loading | ready | paging | failed. An empty cursor means the index ends here.
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

  get isBare() {
    return this.status === 'ready' && this.entries.length === 0;
  }

  // Appends in arrival order; an entry already on screen is dropped, never repeated.
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

  // Marks the source forked and counts it; its place in the ranking does not move.
  forked(treeId, copyId) {
    return new GalleryIndex({
      ...this,
      entries: this.entries.map((entry) => (
        entry.id === treeId ? { ...entry, forked: true, copyId, forks: entry.forks + 1 } : entry
      )),
    });
  }
}

export function cardMark(entry) {
  if (entry.mine) return { badge: 'Listed by you', fork: 'none', href: `#/app/${entry.id}` };
  if (entry.copyId) return { badge: 'Forked', fork: 'copy', href: `#/t/${entry.id}` };
  if (entry.forked) return { badge: 'Forked', fork: 'done', href: `#/t/${entry.id}` };
  return { badge: '', fork: 'offer', href: `#/t/${entry.id}` };
}
