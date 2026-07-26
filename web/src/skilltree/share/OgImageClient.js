// Uploads a tree's unfurl image (design brief #12). PUT /v1/trees/:id/og-image with the raw
// PNG bytes; the backend (owner-only, ≤3 MB → 204) then serves it as the tree's og:image, with
// a generic fallback if none was ever uploaded.
//
// Fire-and-forget by contract: a failed upload must never block or break sharing. Everything
// here is guarded and returns silently — the owner still copied their link, and the backend's
// fallback image covers a card that never arrived.

import { API_BASE } from '../apiBase.js';

const MAX_BYTES = 3 * 1024 * 1024; // the backend's cap — don't ship a body it will only reject

export async function uploadOgImage(treeId, blob) {
  if (!treeId || !blob || blob.size > MAX_BYTES) return;
  try {
    await fetch(`${API_BASE}/v1/trees/${treeId}/og-image`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
      credentials: 'include',
    });
  } catch { /* best-effort — a failed unfurl image never breaks sharing */ }
}
