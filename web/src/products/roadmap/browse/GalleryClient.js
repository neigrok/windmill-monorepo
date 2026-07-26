// The public gallery over HTTP: GET /v1/gallery, the one ranked index both gallery
// surfaces read. Anonymous is a first-class caller — a session only adds `mine` and
// `forked` to each row — so the request is credentialed but never gated.

import { API_BASE } from '../../../shell/apiBase.js';
import { ShareStats } from '../share/ShareStats.js';

// One screenful and then some: the server caps a page at 60, and 24 fills four 3-up rows
// before the "Show more" button has anything to do.
const PAGE_SIZE = 24;

export async function fetchGallery({ cursor = '' } = {}) {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`${API_BASE}/v1/gallery?${query}`, { credentials: 'include' });
  if (!response.ok) throw new Error(`gallery: HTTP ${response.status}`);
  const body = await response.json();
  return {
    count: body.count ?? 0,
    entries: (body.entries ?? []).map(entryOf),
    nextCursor: body.nextCursor ?? '',
  };
}

// A row as the card reads it: the tree's identity, the share stats every Windmill surface
// shows a tree with, and the caller-relative facts. `sourceTitle` is absent whenever the
// source may not be named — an empty string is "no lineage to show", never "unknown".
function entryOf(row) {
  return {
    id: row.id,
    title: row.title,
    stats: new ShareStats({ done: row.done ?? 0, total: row.total ?? 0, dominantKind: row.dominantKind }),
    dominantKind: row.dominantKind,
    forks: row.forks ?? 0,
    updatedAt: row.updatedAt ?? 0,
    sourceTitle: row.sourceTitle ?? '',
    mine: row.mine ?? false,
    forked: row.forked ?? false,
    copyId: '',
  };
}

// The tree's own unfurl card, which is also its thumb — the backend falls back to the
// generic image for a tree that never uploaded one, so a card can't show a broken portrait.
export function portraitUrl(treeId) {
  return `${API_BASE}/og/${encodeURIComponent(treeId)}.png`;
}
