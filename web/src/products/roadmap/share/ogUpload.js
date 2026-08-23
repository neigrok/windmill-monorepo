// Uploads a tree's unfurl assets: PUT /v1/trees/:id/og-image or /og-video with the raw bytes,
// owner only. Fire-and-forget by contract — a failed upload never blocks or breaks sharing.

import { API_BASE } from '../../../shell/apiBase.js';

const MAX_BYTES = 3 * 1024 * 1024; // the backend's cap

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
  } catch { /* best-effort */ }
}
