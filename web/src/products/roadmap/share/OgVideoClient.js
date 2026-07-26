// Uploads a tree's share VIDEO (design brief #19) — the motion companion to OgImageClient's still.
// PUT /v1/trees/:id/og-video with the raw mp4 bytes; the backend (owner-only, ≤3 MB) then serves it
// as the tree's og:video, with the still as the poster.
//
// Fire-and-forget by contract, exactly like the image upload: a failed upload must never block or
// break sharing. Guarded and silent — the owner already has their link, and the poster covers a
// clip that never arrived.

import { API_BASE } from '../../../shell/apiBase.js';

const MAX_BYTES = 3 * 1024 * 1024; // the backend's cap — don't ship a body it will only reject

export async function uploadOgVideo(treeId, blob) {
  if (!treeId || !blob || blob.size > MAX_BYTES) return;
  try {
    await fetch(`${API_BASE}/v1/trees/${treeId}/og-video`, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'video/mp4' },
      body: blob,
      credentials: 'include',
    });
  } catch { /* best-effort — a failed share video never breaks sharing */ }
}
