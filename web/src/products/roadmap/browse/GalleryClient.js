import { API_BASE } from '../../../shell/apiBase.js';
import { ShareStats } from '../share/ShareStats.js';

// The server caps a page at 60.
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

// `sourceTitle` empty means there is no lineage to show, never "unknown".
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

export function portraitUrl(treeId) {
  return `${API_BASE}/og/${encodeURIComponent(treeId)}.png`;
}
