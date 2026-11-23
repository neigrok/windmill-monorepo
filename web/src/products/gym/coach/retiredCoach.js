// What the server's web Coach kept in this browser before Coach's turns moved into it: drafts and questions with their
// answers under `windmill.gym.coach.` in local storage, and its photos' IndexedDB database. Nothing reads them now, so each
// boot of the gym room and each sign-out deletes what is left. A browser that keeps nothing has nothing to delete.
const PREFIX = 'windmill.gym.coach.';
const PHOTOS = 'windmill.gym.coach.photos';

export function forgetRetiredCoach({ storage = globalThis.localStorage, databases = globalThis.indexedDB } = {}) {
  try {
    const keys = [];
    for (let index = 0; index < (storage?.length ?? 0); index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch { /* Storage the browser withholds holds nothing of ours to delete. */ }
  try { databases?.deleteDatabase?.(PHOTOS); } catch { /* The same. */ }
}
