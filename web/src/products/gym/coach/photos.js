export const PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTO_EDGE = 4096;
export const PHOTO_PIXELS = 16777216;

export function photoLimitNote({ bytes, width, height }) {
  if (bytes > PHOTO_BYTES) return 'Choose a photo up to 5 MB.';
  if (width > PHOTO_EDGE || height > PHOTO_EDGE || width * height > PHOTO_PIXELS) return 'Choose a photo no larger than 4096 × 4096 pixels.';
  return null;
}

export async function prepareCoachPhoto(file) {
  const sizeNote = photoLimitNote({ bytes: file.size });
  if (sizeNote) throw new Error(sizeNote);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Choose a supported photo. Use JPEG or PNG.');
  }
  try {
    const { width, height } = bitmap;
    const dimensionsNote = photoLimitNote({ bytes: file.size, width, height });
    if (dimensionsNote) throw new Error(dimensionsNote);
    if (['image/jpeg', 'image/png'].includes(file.type)) return { blob: file, mediaType: file.type, width, height, bytes: file.size };
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Choose a supported photo. Use JPEG or PNG.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('Choose a supported photo. Use JPEG or PNG.');
    const convertedNote = photoLimitNote({ bytes: blob.size, width, height });
    if (convertedNote) throw new Error(convertedNote);
    return { blob, mediaType: 'image/jpeg', width, height, bytes: blob.size };
  } finally {
    bitmap.close();
  }
}

export const coachPhotos = {
  prepare: prepareCoachPhoto,

  async access(accountId, thread, id, operation, blob) {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('windmill.gym.coach.photos', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('photos');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('photos', operation === 'get' ? 'readonly' : 'readwrite');
        const store = transaction.objectStore('photos');
        const key = [accountId, thread, id];
        const request = operation === 'put' ? store.put(blob, key) : store[operation](key);
        transaction.oncomplete = () => resolve(request.result ?? null);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('Photo storage unavailable.'));
      });
    } finally {
      database.close();
    }
  },

  save(accountId, thread, id, blob) { return this.access(accountId, thread, id, 'put', blob); },
  load(accountId, thread, id) { return this.access(accountId, thread, id, 'get'); },
  remove(accountId, thread, id) { return this.access(accountId, thread, id, 'delete'); },
};
