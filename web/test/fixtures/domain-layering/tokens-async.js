// @ts-check
// layer: kit
// file: drafts.js
// expect: 10: token async
// expect: 11: token await
// expect: 13: token async
// expect: 14: token async
// expect: 15: token await
// expect: 18: token Promise
export async function save(draft) {
  return await draft;
}
export const open = async (id) => id;
export class Runner { async run(action) {
  for await (const step of action) { if (step) return step; }
  return null;
} }
export const later = Promise.resolve(1);
