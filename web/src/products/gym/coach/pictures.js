import { CoachTurnBounds } from '../domain/coach/conversation.js';
import { PictureCopy } from '../domain/coach/turn.js';
import { t } from '../i18n/index.js';

// A file the browser cannot read as a picture, or cannot fit within a copy's bounds: the person's to choose again, no fault.
export class PictureRefused extends Error {
  constructor() { super(t('gym.coach.photo.unsupported')); this.name = 'PictureRefused'; }
}

// A picture chosen for Coach, as the browser keeps it (gym Coach on the AI service §5): the original within
// `PICTURE_EDGE` and `PICTURE_BYTES`, and the model copy, the one that leaves the browser, within its own bounds.
// Each copy is a JPEG or a PNG the canvas draws again, scaled down until it fits.

async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

async function copyWithin(bitmap, edge, bytes) {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  for (let quality = 0.9, shrink = 1; quality > 0.3; quality -= 0.15, shrink *= 0.85) {
    const width = Math.max(1, Math.floor(bitmap.width * scale * shrink));
    const height = Math.max(1, Math.floor(bitmap.height * scale * shrink));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) break;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= bytes) return new PictureCopy('image/jpeg', width, height, await base64(blob));
  }
  throw new PictureRefused();
}

export async function prepareCoachPicture(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new PictureRefused(); }
  try {
    return {
      original: await copyWithin(bitmap, CoachTurnBounds.pictureEdge, CoachTurnBounds.pictureBytes),
      model: await copyWithin(bitmap, CoachTurnBounds.modelPictureEdge, CoachTurnBounds.modelPictureBytes),
    };
  } finally {
    bitmap.close();
  }
}

// A copy as an image the page can draw.
export function pictureSource(copy) {
  return `data:${copy.mediaType};base64,${copy.data}`;
}
