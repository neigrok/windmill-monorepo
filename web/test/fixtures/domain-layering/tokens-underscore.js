// @ts-check
// layer: kit
// file: entities.js
// expect: 7: identifier _secret begins with an underscore
// expect: 8: identifier _secret begins with an underscore
// expect: 11: identifier _tag begins with an underscore
const _secret = 1;
export function hidden(x) { return x + _secret; }
export class Card { #ownId = 1; count() { return this.#ownId; } }
export const indexes = [1, 2].map((_, index) => index); // a bare _ passes, as in Swift
export const tagged = (card) => card._tag;
