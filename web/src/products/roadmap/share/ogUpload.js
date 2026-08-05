// Uploads a tree's unfurl assets: the still (design brief #12) and the motion companion
// (#19). PUT /v1/trees/:id/og-image or /og-video with the raw bytes; the backend — owner
// only — then serves them as the tree's og:image / og:video, with a generic image as the
// fallback for a card that was never uploaded and the still as the clip's poster.
//
// Fire-and-forget by contract: a failed upload must never block or break sharing. Both
// doors are guarded and return silently — the owner already copied their link, and the
// fallbacks cover an asset that never arrived.

import { API_BASE } from '../../../shell/apiBase.js';

const MAX_BYTES = 3 * 1024 * 1024; // the backend's cap — don't ship a body it will only reject

export function uploadOgImage(treeId, blob) {
  return putOgAsset(treeId, 'og-image', blob, 'image/png');
}

export function uploadOgVideo(treeId, blob) {
  return putOgAsset(treeId, 'og-video', blob, 'video/mp4');
}

async function putOgAsset(treeId, slot, blob, fallbackType) {
  if (!treeId || !blob || blob.size > MAX_BYTES) return;
  try {
    await fetch(`${API_BASE}/v1/trees/${treeId}/${slot}`, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || fallbackType },
      body: blob,
      credentials: 'include',
    });
  } catch { /* best-effort — a failed unfurl asset never breaks sharing */ }
}
