// @ts-check
// layer: kit
// file: entities.js
// expect: 7: token crypto
// expect: 8: token Math.random
// expect: 9: token crypto
export const id = crypto.randomUUID();
export const roll = Math.random();
export const word = crypto.getRandomValues(new Uint32Array(1));
